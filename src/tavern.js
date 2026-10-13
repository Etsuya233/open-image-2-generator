import { selected_world_info, world_info, loadWorldInfo } from '/scripts/world-info.js';
import { proxies } from '/scripts/openai.js';
import { getCharaFilename } from '/scripts/utils.js';

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

export function getBoundWorldbookNames() {
    const context = SillyTavern.getContext();
    const character = context.characters[context.characterId];
    const additional = character
        ? world_info.charLore?.find(item => item.name === getCharaFilename(context.characterId))?.extraBooks ?? []
        : [];
    return [...new Set([
        ...selected_world_info,
        character?.data?.extensions?.world,
        ...additional,
        context.chatMetadata.world_info,
    ].filter(Boolean))];
}

export async function getWorldbook(name) {
    const book = await loadWorldInfo(name);
    if (!book) throw new Error(`世界书 ${name} 不存在`);
    return Object.values(book.entries).map(entry => ({
        uid: entry.uid,
        name: entry.comment,
        content: entry.content,
        enabled: !entry.disable,
    }));
}

export async function generateRaw({ ordered_prompts, custom_api }) {
    const context = SillyTavern.getContext();
    if (!custom_api && context.mainApi !== 'openai') {
        return context.generateRaw({ prompt: ordered_prompts, instructOverride: true });
    }
    const overrides = { messages: ordered_prompts, stream: false };
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
