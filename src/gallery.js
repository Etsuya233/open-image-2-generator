import { saveBase64AsFile, uuidv4 } from '/scripts/utils.js';
import { user_avatar } from '/scripts/personas.js';

const folder = 'open-image2';

export function captureSource(messageId) {
    const c = SillyTavern.getContext();
    const group = c.groups.find(g => String(g.id) === String(c.groupId));
    const characters = c.groupId
        ? c.characters.filter(character => group.members.includes(character.avatar))
        : c.characters.filter((_, index) => String(index) === String(c.characterId));
    return structuredClone({
        chat: { id: c.chatId ?? null, groupId: c.groupId ?? null, name: group?.name ?? characters[0]?.name ?? '', messageId: messageId ?? null,
            message: messageId == null ? null : c.chat[messageId] },
        persona: { id: user_avatar || '__none__', name: c.name1, description: c.powerUserSettings.persona_description,
            settings: c.powerUserSettings.persona_descriptions[user_avatar] },
        characters: characters.map(character => ({ id: character.avatar, name: character.name, snapshot: character })),
    });
}

export function sourceIsCurrent(source, expectedMessage) {
    const current = captureSource(source.chat.messageId);
    return current.chat.id === source.chat.id && current.chat.groupId === source.chat.groupId
        && (expectedMessage === undefined || current.chat.message?.mes === expectedMessage)
        && current.chat.message?.swipe_id === source.chat.message?.swipe_id
        && JSON.stringify(current.characters.map(c => c.id)) === JSON.stringify(source.characters.map(c => c.id));
}

export async function saveGeneratedImage(url, metadata) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`下载生成图片失败：${response.status}`);
    const blob = await response.blob();
    const format = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[blob.type];
    if (!format) throw new Error(`不支持的生成图片类型：${blob.type}`);
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
    const id = uuidv4();
    const imagePath = await saveBase64AsFile(dataUrl.split(',')[1], folder, id, format);
    const savedAt = new Date().toISOString();
    const record = { version: 1, id, imagePath, ...metadata, savedAt,
        totalMs: new Date(savedAt) - new Date(metadata.startedAt) };
    const bytes = new TextEncoder().encode(JSON.stringify(record));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const upload = await fetch('/api/files/upload', {
        method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(),
        body: JSON.stringify({ name: `open-image2-${id}.json`, data: btoa(binary) }),
    });
    if (!upload.ok) throw new Error(`图片已保存到 ${imagePath}，元数据保存失败：${upload.status}`);
    return record;
}

const DAY_MS = 86400000;

function localDayKey(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayLabel(key) {
    if (!key) return '时间未知';
    if (key === localDayKey(Date.now())) return '今天';
    if (key === localDayKey(Date.now() - DAY_MS)) return '昨天';
    return key;
}

function clockText(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--:--';
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function elapsedText(value) {
    const ms = Number(value);
    return Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} 秒` : '未记录';
}

function stampText(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '未记录' : date.toLocaleString();
}

function characterNames(record) {
    const names = (record.source?.characters ?? []).map(character => character.name).filter(Boolean);
    return names.length ? names.join('、') : '无角色';
}

function groupByDay(records) {
    const groups = new Map();
    for (const record of records) {
        const key = localDayKey(record.startedAt);
        if (!groups.has(key)) groups.set(key, { key, label: dayLabel(key), records: [] });
        groups.get(key).records.push(record);
    }
    return [...groups.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
}

export function createGallery(root, { openLightbox } = {}) {
    const find = selector => root.querySelector(selector);
    let records = [];
    let loaded = false;
    const activeFilters = () => ({
        persona: find('#oair_gallery_persona').value,
        character: find('#oair_gallery_character').value,
        from: find('#oair_gallery_from').value,
        to: find('#oair_gallery_to').value,
    });
    const clearFilters = () => {
        find('#oair_gallery_persona').value = '';
        find('#oair_gallery_character').value = '';
        find('#oair_gallery_from').value = '';
        find('#oair_gallery_to').value = '';
        render();
    };
    const openDetails = record => {
        if (!openLightbox) return;
        const chat = record.source?.chat ?? {};
        const references = record.references ?? [];
        openLightbox(record.imagePath, record.prompt ?? '', {
            title: `${characterNames(record)} · ${stampText(record.startedAt)}`,
            fields: [
                ['来源聊天', `${chat.name || '未命名聊天'} / ${chat.id ?? '无聊天'} / 楼层 ${chat.messageId ?? '手动测试'}`],
                ['Persona', record.source?.persona?.name || '未记录'],
                ['角色卡', characterNames(record)],
                ['生成时间', `${stampText(record.startedAt)} → ${stampText(record.completedAt)}`],
                ['图片请求耗时', elapsedText(record.generationMs)],
                ['保存时累计耗时', elapsedText(record.totalMs)],
                ['请求次数', record.attempts == null ? '未记录' : String(record.attempts)],
                ['模型 / 尺寸', `${record.parameters?.model ?? '未记录'} / ${record.parameters?.size ?? '未记录'}`],
                ['参考图', references.length ? references.map(item => `${item.characterName}：${item.fileName}`).join('、') : '未使用'],
            ],
            submittedPrompt: typeof record.submittedPrompt === 'string' ? record.submittedPrompt : JSON.stringify(record.submittedPrompt, null, 2),
            json: JSON.stringify(record, null, 2),
        });
    };
    const createTile = record => {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'oair-tile';
        tile.title = `${characterNames(record)} · ${stampText(record.startedAt)}`;
        const thumb = document.createElement('span');
        thumb.className = 'oair-thumb';
        const image = document.createElement('img');
        image.src = record.imagePath;
        image.alt = record.prompt || '生成的图片';
        image.loading = 'lazy';
        image.addEventListener('error', () => thumb.classList.add('is-broken'));
        thumb.append(image);
        const references = record.references?.length ?? 0;
        if (references) {
            const badge = document.createElement('span');
            badge.className = 'oair-thumb-ref';
            badge.textContent = `参考 ×${references}`;
            thumb.append(badge);
        }
        if (record.generationMs != null && Number.isFinite(Number(record.generationMs))) {
            const badge = document.createElement('span');
            badge.className = 'oair-thumb-elapsed';
            badge.textContent = `${(Number(record.generationMs) / 1000).toFixed(1)}s`;
            thumb.append(badge);
        }
        const hint = document.createElement('span');
        hint.className = 'oair-thumb-hint';
        hint.textContent = '放大';
        thumb.append(hint);
        const caption = document.createElement('span');
        caption.className = 'oair-caption';
        const name = document.createElement('span');
        name.className = 'oair-caption-name';
        name.textContent = characterNames(record);
        const time = document.createElement('span');
        time.className = 'oair-caption-time';
        time.textContent = clockText(record.startedAt);
        caption.append(name, time);
        tile.append(thumb, caption);
        tile.addEventListener('click', () => openDetails(record));
        return tile;
    };
    const emptyBox = (text, withClear) => {
        const box = document.createElement('div');
        box.className = 'oair-gallery-empty';
        const line = document.createElement('div');
        line.textContent = text;
        box.append(line);
        if (withClear) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'oair-btn secondary';
            button.textContent = '清除筛选';
            button.addEventListener('click', clearFilters);
            box.append(button);
        }
        return box;
    };
    const renderChips = () => {
        const host = find('#oair_gallery_chips');
        host.replaceChildren();
        const { persona, character, from, to } = activeFilters();
        const chips = [
            ['#oair_gallery_persona', 'Persona', persona, find('#oair_gallery_persona').selectedOptions[0]?.textContent],
            ['#oair_gallery_character', '角色卡', character, find('#oair_gallery_character').selectedOptions[0]?.textContent],
            ['#oair_gallery_from', '日期从', from, from],
            ['#oair_gallery_to', '日期至', to, to],
        ];
        for (const [selector, label, value, text] of chips) {
            if (!value) continue;
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'oair-chip';
            chip.textContent = `${label}：${text || value} ✕`;
            chip.title = `取消「${label}」筛选`;
            chip.addEventListener('click', () => {
                find(selector).value = '';
                render();
            });
            host.append(chip);
        }
        host.hidden = !host.childElementCount;
    };
    const render = () => {
        const { persona, character, from, to } = activeFilters();
        const filtered = records.filter(record => {
            const day = localDayKey(record.startedAt);
            return (!persona || record.source?.persona?.id === persona)
                && (!character || (record.source?.characters ?? []).some(item => item.id === character))
                && (!from || (day && day >= from))
                && (!to || (day && day <= to));
        });
        find('#oair_gallery_count').textContent = filtered.length === records.length
            ? String(records.length) : `${filtered.length} / ${records.length}`;
        renderChips();
        const box = find('#oair_generated_gallery');
        box.replaceChildren();
        if (!filtered.length) {
            box.append(records.length
                ? emptyBox('没有符合筛选条件的图片。', true)
                : emptyBox('图库还是空的。到「生图与设置」跑一次生图测试，或让角色正常回复一次，图片会自动存到这里。', false));
            return;
        }
        for (const group of groupByDay(filtered)) {
            const head = document.createElement('div');
            head.className = 'oair-gallery-day';
            const label = document.createElement('b');
            label.textContent = group.label;
            const count = document.createElement('i');
            count.textContent = `${group.records.length} 张`;
            head.append(label, count);
            const grid = document.createElement('div');
            grid.className = 'oair-gallery-tiles';
            for (const record of group.records) grid.append(createTile(record));
            box.append(head, grid);
        }
    };
    const updateOptions = () => {
        for (const [selector, values] of [
            ['#oair_gallery_persona', records.map(record => record.source?.persona).filter(Boolean)],
            ['#oair_gallery_character', records.flatMap(record => record.source?.characters ?? [])],
        ]) {
            const select = find(selector);
            const previous = select.value;
            const options = [...new Map(values.map(value => [value.id, value.name])).entries()]
                .sort((a, b) => String(a[1] ?? '').localeCompare(String(b[1] ?? ''), 'zh-Hans-CN'));
            select.replaceChildren(new Option('全部', ''));
            for (const [id, name] of options) select.add(new Option(name || '未命名', id));
            select.value = [...select.options].some(option => option.value === previous) ? previous : '';
        }
    };
    for (const input of root.querySelectorAll('[data-gallery-filter]')) input.addEventListener('change', render);
    find('#oair_gallery_clear')?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        clearFilters();
    });
    return {
        async load() {
            const box = find('#oair_generated_gallery');
            if (!loaded) {
                const grid = document.createElement('div');
                grid.className = 'oair-gallery-tiles';
                grid.append(...Array.from({ length: 8 }, () => {
                    const skeleton = document.createElement('div');
                    skeleton.className = 'oair-tile-skeleton';
                    return skeleton;
                }));
                box.replaceChildren(grid);
            }
            try {
                const response = await fetch('/api/images/list', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(),
                    body: JSON.stringify({ folder, sortField: 'date', sortOrder: 'desc' }) });
                if (!response.ok) throw new Error(`读取图片目录失败：${response.status}`);
                const names = await response.json();
                records = await Promise.all(names.map(async name => {
                    const id = name.substring(0, name.lastIndexOf('.'));
                    const metadata = await fetch(`/user/files/open-image2-${id}.json`, { cache: 'no-store' });
                    if (!metadata.ok) throw new Error(`图片 ${name} 的元数据读取失败：${metadata.status}`);
                    return metadata.json();
                }));
                records.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
                loaded = true;
                updateOptions();
                render();
            } catch (error) {
                loaded = false;
                find('#oair_gallery_count').textContent = '0';
                box.replaceChildren(emptyBox(error.message, false));
                throw error;
            }
        },
        add(record) {
            records.unshift(record);
            loaded = true;
            updateOptions();
            render();
        },
    };
}
