import { checkWorldInfo, getWorldInfoSettings } from '/scripts/world-info.js';
import { user_avatar } from '/scripts/personas.js';
import { proxies } from '/scripts/openai.js';

const SETTINGS_KEY = 'open_image_2_generator';
const LEGACY_SETTINGS_KEY = 'oair_image2_character_reference_settings_v2';
const OLD_SETTINGS_KEY = 'oair_image2_rp_settings_v1';

export function loadSettings() {
    const context = SillyTavern.getContext();
    if (context.extensionSettings[SETTINGS_KEY]) return context.extensionSettings[SETTINGS_KEY];

    // Read the saved script data directly; TavernHelper does not need to be enabled.
    const trees = [
        ...(context.extensionSettings.tavern_helper?.script?.scripts ?? []),
        ...(context.characters[context.characterId]?.data?.extensions?.tavern_helper?.scripts ?? []),
        ...(context.chatCompletionSettings.extensions?.tavern_helper?.scripts ?? []),
    ];
    const scripts = trees.flatMap(item => item.type === 'folder' ? item.scripts : [item]);
    const candidates = scripts.filter(script => script.data?.[LEGACY_SETTINGS_KEY] || script.data?.[OLD_SETTINGS_KEY]);
    const active = candidates.filter(script => script.enabled);
    const selected = active.length ? active : candidates;
    if (selected.length > 1) throw new Error('发现多个 image2 脚本配置，请先只保留一份，再刷新页面迁移');
    const data = selected[0]?.data;
    const saved = data?.[LEGACY_SETTINGS_KEY] ?? data?.[OLD_SETTINGS_KEY];
    const local = localStorage.getItem(LEGACY_SETTINGS_KEY) ?? localStorage.getItem(OLD_SETTINGS_KEY);
    const legacy = saved ?? (local ? JSON.parse(local) : {});
    const settings = legacy.settings ?? legacy;
    context.extensionSettings[SETTINGS_KEY] = structuredClone(settings);
    context.saveSettingsDebounced();
    return settings;
}

export function saveSettings(settings) {
    const context = SillyTavern.getContext();
    context.extensionSettings[SETTINGS_KEY] = structuredClone(settings);
    context.saveSettingsDebounced();
}

export function getChatMessages(range, { hide_state } = {}) {
    const { chat } = SillyTavern.getContext();
    const bounds = String(range).match(/^(\d+)(?:-(\d+))?$/);
    if (!bounds) throw new Error(`无效聊天楼层范围：${range}`);
    const start = Number(bounds[1]);
    const end = Number(bounds[2] ?? bounds[1]);
    return chat.slice(start, end + 1).map((message, index) => ({
        message_id: start + index,
        name: message.name,
        role: message.is_user ? 'user' : message.extra?.type === 'narrator' ? 'system' : 'assistant',
        is_hidden: Boolean(message.is_system),
        message: message.mes,
        extra: message.extra,
    })).filter(message => hide_state !== 'unhidden' || !message.is_hidden);
}

export async function setChatMessages(messages) {
    const context = SillyTavern.getContext();
    for (const { message_id, message } of messages) {
        const entry = context.chat[message_id];
        if (!entry) throw new Error(`聊天楼层 ${message_id} 不存在`);
        entry.mes = message;
        if (entry.swipes) entry.swipes[entry.swipe_id ?? 0] = message;
        context.updateMessageBlock(message_id, entry);
        await context.eventSource.emit(context.eventTypes.MESSAGE_UPDATED, message_id);
    }
    await context.saveChat();
}

export function injectPrompts(prompts) {
    const context = SillyTavern.getContext();
    for (const prompt of prompts) {
        context.setExtensionPrompt(prompt.id, prompt.content, 1, prompt.depth, prompt.should_scan,
            { system: 0, user: 1, assistant: 2 }[prompt.role]);
    }
}

export function uninjectPrompts(ids) {
    const context = SillyTavern.getContext();
    for (const id of ids) delete context.extensionPrompts[id];
}

export async function getActivatedWorldInfo({ upToMessageId } = {}) {
    const context = SillyTavern.getContext();
    const last = upToMessageId == null ? context.chat.length - 1 : Math.min(upToMessageId, context.chat.length - 1);
    const messages = last < 0 ? [] : getChatMessages(`0-${last}`, { hide_state: 'unhidden' });
    const { world_info_include_names } = getWorldInfoSettings();
    const chat = messages
        .map(message => world_info_include_names ? `${message.name}: ${message.message}` : message.message)
        .reverse();
    const character = context.characters[context.characterId];
    const card = character ? { ...character, ...character.data } : {};
    const persona = context.powerUserSettings?.persona_descriptions?.[user_avatar];
    const activated = await checkWorldInfo(chat, context.maxContext, true, {
        personaDescription: persona?.description ?? context.powerUserSettings?.persona_description ?? '',
        characterDescription: card.description ?? '',
        characterPersonality: card.personality ?? '',
        characterDepthPrompt: card.depth_prompt?.prompt ?? '',
        scenario: card.scenario ?? '',
        creatorNotes: card.creator_notes ?? '',
        trigger: 'normal',
    });
    return Array.from(activated.allActivatedEntries ?? []).map(entry => ({
        world: entry.world,
        uid: entry.uid,
        name: entry.comment || String(entry.uid),
        content: entry.content ?? '',
    }));
}

/**
 * @param {object} params
 * @param {{role: string, content: string}[]} params.ordered_prompts 按顺序排好的消息
 * @param {object} [params.custom_api] 覆盖用的 API 配置
 * @param {boolean} [params.substitute_macros] 是否由插件替换酒馆宏。
 *   走文本补全时酒馆自己会替换，这里传 false，避免 {{random}} 这类宏被抽两次。
 */
export async function generateRaw({ ordered_prompts, custom_api, substitute_macros = false }) {
    const context = SillyTavern.getContext();
    if (!custom_api && context.mainApi !== 'openai') {
        return context.generateRaw({ prompt: ordered_prompts, instructOverride: true });
    }
    const messages = substitute_macros
        ? ordered_prompts.map(message => ({ ...message, content: context.substituteParams(message.content) }))
        : ordered_prompts;
    const overrides = { messages, stream: false };
    if (custom_api?.model) overrides.model = custom_api.model;
    if (custom_api?.proxy_preset) {
        const proxy = proxies.find(item => item.name === custom_api.proxy_preset);
        if (!proxy) throw new Error(`反向代理预设 ${custom_api.proxy_preset} 不存在`);
        overrides.reverse_proxy = proxy.url;
        overrides.proxy_password = proxy.password;
        overrides.chat_completion_source = custom_api.source;
    } else if (custom_api?.apiurl) {
        overrides.reverse_proxy = custom_api.apiurl;
        overrides.proxy_password = custom_api.key;
        overrides.chat_completion_source = custom_api.source;
    } else if (custom_api?.key || custom_api?.source) {
        throw new Error('独立提示词 API 必须填写 API 地址；反向代理模式必须填写预设名称');
    } else if (context.mainApi !== 'openai') {
        throw new Error('覆盖提示词模型时，请使用酒馆的聊天补全连接或配置独立 API');
    }
    const payload = await context.ChatCompletionService.presetToGeneratePayload({}, {}, overrides);
    const result = await context.ChatCompletionService.sendRequest(payload);
    if (!result.content) throw new Error('提示词 API 返回了空内容');
    return result.content;
}
