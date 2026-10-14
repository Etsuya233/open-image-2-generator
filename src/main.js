import { captureSource, sourceIsCurrent, saveGeneratedImage, createGallery } from './gallery.js';
import { createEntries } from './entry.js';
import * as tavern from './tavern.js';
import { defaultSettings, DEFAULT_MAIN_PROMPT, DEFAULT_REFERENCE_PROMPT_TEMPLATE, IMAGE_PROMPT_WORDING_RULES, CONTEXT_SECTIONS, createDefaultProfiles, createDefaultProfileFor } from './defaults.js';

const NS = 'OAIRImage2CharacterReference';
const SECTION_STATE_KEY = 'oair_image2_character_reference_collapsed_sections_v1';
const PANEL_POSITION_KEY = 'oair_image2_character_reference_panel_position_v1';
const PANEL_SIZE_KEY = 'oair_image2_character_reference_panel_size_v1';
const INJECT_ID = 'oair-image2-character-reference-main-prompt';
const PROMPT_PROFILE_EXPORT_TYPE = 'oair-image2-prompt-profiles';
const PROMPT_ROLES = ['system', 'user', 'assistant'];
const PROMPT_ROLE_LABELS = { system: '系统', user: '用户', assistant: '助手' };
const MATERIAL_SECTION_HINTS = {
  reply: '本次 assistant 回复的正文（生成时会去掉 <pic> 标签）',
  character: '当前角色卡的名字、描述、性格、场景、示例对话和开场白',
  worldbook: '该楼层会激活的世界书条目，数量上限取第 4 步的「世界书激活条目上限」',
  history: '截到所选楼层为止的最近聊天记录，条数取第 4 步的「聊天历史条数」',
  variables: '当前聊天的变量表（可能包含敏感信息）',
};
const REFERENCE_DB_NAME = 'oair_image2_character_reference_v1';
const REFERENCE_DB_STORE = 'reference_images';
const MAX_LOGS = 120;
const MAX_RENDERED_LOGS = 40;
let panelHtml;
let generatedGallery;

const state = {
  settings: { ...defaultSettings },
  logs: [],
  disposers: [],
  inFlightMessages: new Set(),
  currentRun: null,
  panel: null,
  entries: null,
  uiWindow: null,
  uiDocument: null,
  steps: new Map(),
  objectUrls: new Set(),
  renderLogsQueued: false,
  renderStepsQueued: false,
  busyButtons: new Set(),
  activeTab: 'main',
  editingProfileId: null,
  expandedPromptEntries: new Set(),
  referenceDb: null,
  referenceImages: new Map(),
  panelPosition: null,
  panelSize: null,
};

const W = window;
function initUiTarget() {
  state.uiWindow = window;
  state.uiDocument = document;
  return state.uiDocument;
}

function uiDoc() {
  return state.uiDocument || document;
}

function q(selector) {
  return uiDoc().querySelector(selector);
}

function qa(selector) {
  return Array.from(uiDoc().querySelectorAll(selector));
}

function makeEl(tagName) {
  return uiDoc().createElement(tagName);
}

function notify(type, message) {
  if (W.toastr?.[type]) {
    W.toastr[type](message);
    return;
  }
  console[type === 'error' ? 'error' : 'log'](`[${NS}] ${message}`);
}

function nowLabel() {
  return new Date().toLocaleString();
}

function clip(text, max = 6000) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...[已截断 ${value.length - max} 字符]`;
}

function maskSecret(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= 8) return '****';
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

function sanitize(value, depth = 0) {
  if (depth > 6) return '[Object depth limit]';
  if (value == null) return value;
  if (typeof value === 'string') {
    if (/^data:image\/[^;]+;base64,/i.test(value)) {
      return `[data image omitted, length=${value.length}]`;
    }
    if (/^[A-Za-z0-9+/=]{3000,}$/.test(value)) {
      return `[base64 omitted, length=${value.length}]`;
    }
    return clip(value, 6000);
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitize(item, depth + 1));

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/api.?key|authorization|bearer|token|password|secret|key$/i.test(key)) {
      out[key] = maskSecret(item);
    } else {
      out[key] = sanitize(item, depth + 1);
    }
  }
  return out;
}

function safeStringify(value) {
  try {
    return JSON.stringify(sanitize(value), null, 2);
  } catch (error) {
    return String(value);
  }
}

function scheduleUiRender(kind, render) {
  const flag = kind === 'logs' ? 'renderLogsQueued' : 'renderStepsQueued';
  if (state[flag]) return;
  state[flag] = true;
  const run = () => {
    state[flag] = false;
    render();
  };
  const win = state.uiWindow || W;
  if (typeof win.requestAnimationFrame === 'function') {
    win.requestAnimationFrame(run);
  } else {
    setTimeout(run, 0);
  }
}

function scheduleRenderLogs() {
  scheduleUiRender('logs', renderLogs);
}

function scheduleRenderSteps() {
  scheduleUiRender('steps', renderSteps);
}

function addLog(level, title, payload) {
  const safePayload = sanitize(payload);
  const item = {
    time: nowLabel(),
    level,
    title,
    payload: safePayload,
  };
  state.logs.unshift(item);
  state.logs = state.logs.slice(0, MAX_LOGS);
  scheduleRenderLogs();
  console[level === 'error' ? 'error' : 'log'](`[${NS}] ${title}`, safePayload);
}

function setStatus(text, level = 'info') {
  const el = q('#oair_status');
  if (!el) return;
  el.textContent = text;
  el.dataset.level = level;
}

function setElapsed(ms) {
  const el = q('#oair_elapsed');
  if (!el) return;
  if (!Number.isFinite(ms)) {
    el.textContent = '耗时：-';
    return;
  }
  el.textContent = `耗时：${(ms / 1000).toFixed(2)} 秒`;
}

function resetSteps() {
  state.steps.clear();
  [
    ['config', '读取配置/API 参数'],
    ['message', '读取消息或上下文'],
    ['prompt', '提取/生成绘图提示词'],
    ['request', '组装图片请求'],
    ['api', '调用图片 API'],
    ['parse', '解析图片结果'],
    ['write', '写回消息或预览'],
    ['done', '完成'],
  ].forEach(([key, label]) => state.steps.set(key, { label, status: 'idle', detail: '' }));
  scheduleRenderSteps();
}

function updateStep(key, status, detail = '') {
  if (!state.steps.size) resetSteps();
  const current = state.steps.get(key) || { label: key, status: 'idle', detail: '' };
  state.steps.set(key, { ...current, status, detail });
  scheduleRenderSteps();
}

function renderSteps() {
  const box = q('#oair_steps');
  if (!box) return;
  box.innerHTML = '';
  for (const [key, step] of state.steps.entries()) {
    const row = makeEl('div');
    row.className = 'oair-step';
    row.dataset.status = step.status;
    const mark = makeEl('span');
    mark.className = 'oair-step-mark';
    mark.textContent = step.status === 'ok' ? 'OK' : step.status === 'running' ? '...' : step.status === 'fail' ? '!!' : '--';
    const text = makeEl('span');
    text.className = 'oair-step-text';
    text.textContent = `${step.label}${step.detail ? `：${step.detail}` : ''}`;
    row.append(mark, text);
    box.appendChild(row);
  }
}

function renderLogs() {
  const box = q('#oair_log_list');
  if (!box) return;
  box.innerHTML = '';
  state.logs.slice(0, MAX_RENDERED_LOGS).forEach((item, index) => {
    const details = makeEl('details');
    details.className = 'oair-log-entry';
    if (index === 0) details.open = true;
    details.dataset.level = item.level;
    const summary = makeEl('summary');
    summary.textContent = `${item.time} [${item.level}] ${item.title}`;
    const pre = makeEl('pre');
    const fillPayload = () => {
      if (pre.dataset.loaded) return;
      pre.textContent = safeStringify(item.payload);
      pre.dataset.loaded = '1';
    };
    if (index === 0) fillPayload();
    details.addEventListener('toggle', () => {
      if (details.open) fillPayload();
    });
    details.append(summary, pre);
    box.appendChild(details);
  });
  if (state.logs.length > MAX_RENDERED_LOGS) {
    const more = makeEl('div');
    more.className = 'oair-log-more';
    more.textContent = `还有 ${state.logs.length - MAX_RENDERED_LOGS} 条旧日志未渲染，可用“复制日志”导出完整日志。`;
    box.appendChild(more);
  }
}

function parseRegexFromSetting(setting, fallback) {
  const raw = String(setting || '').trim();
  try {
    const source = raw || fallback;
    const slash = source.match(/^\/([\s\S]*)\/([a-z]*)$/i);
    if (slash) {
      return ensureGlobalRegex(new RegExp(slash[1], slash[2]));
    }
    return ensureGlobalRegex(new RegExp(source, 'g'));
  } catch (error) {
    addLog('error', '正则解析失败，使用默认值', { raw, fallback, error: error.message });
    const slash = fallback.match(/^\/([\s\S]*)\/([a-z]*)$/i);
    return ensureGlobalRegex(new RegExp(slash[1], slash[2]));
  }
}

function ensureGlobalRegex(regex) {
  if (regex.global) return regex;
  const flags = `${regex.flags || ''}g`.replace(/(.)(?=.*\1)/g, '');
  return new RegExp(regex.source, flags);
}

function decodeHtmlEntities(text) {
  const textarea = makeEl('textarea');
  textarea.innerHTML = text;
  return textarea.value;
}

function extractPicPrompts(text) {
  const regex = parseRegexFromSetting(
    state.settings.extractionRegex,
    '/<pic[^>]*\\sprompt="([^"]+)"[^>]*>/g',
  );
  regex.lastIndex = 0;
  const prompts = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const prompt = decodeHtmlEntities(match[1] || '').trim();
    if (prompt) prompts.push(prompt);
    if (regex.lastIndex === match.index) regex.lastIndex += 1;
  }
  const cleaned = text.replace(regex, '').replace(/\n{3,}/g, '\n\n').trim();
  return { prompts, cleaned };
}

function parseJsonLoose(text, fallback = {}) {
  const raw = String(text || '').trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    throw new Error('JSON 必须是对象');
  } catch (error) {
    throw new Error(`额外请求体 JSON 解析失败：${error.message}`);
  }
}

function compactPromptText(text, maxChars) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!maxChars || clean.length <= maxChars) return { text: clean, truncated: false };

  const parts = clean
    .split(/(?<=[。！？；;.!?])\s*/)
    .map(part => part.trim())
    .filter(Boolean);
  const kept = [];
  let used = 0;
  for (const part of parts) {
    const nextLen = used + part.length;
    if (kept.length && nextLen > maxChars) break;
    kept.push(part);
    used = nextLen;
    if (used >= maxChars) break;
  }

  let out = kept.join('');
  if (!out || out.length > maxChars) out = clean.slice(0, maxChars);
  return { text: `${out.replace(/[，,、；;：:]*$/, '')}。`, truncated: true };
}

function normalizeImagePromptForBackend(prompt) {
  const original = String(prompt || '').trim();
  let text = original.replace(/\s+/g, ' ');
  const applied = [];

  const maxChars = Math.max(0, Number(state.settings.maxImagePromptChars) || 0);
  const compacted = state.settings.normalizeImagePrompt ? compactPromptText(text, maxChars) : { text, truncated: false };
  text = compacted.text;

  const prefix = String(state.settings.imageSafetyPrefix || '').trim();
  if (state.settings.normalizeImagePrompt && prefix && !text.includes(prefix)) {
    text = `${prefix}${text}`;
  }

  return {
    originalPrompt: original,
    backendPrompt: text.trim(),
    changed: original !== text.trim(),
    replacementsApplied: applied,
    truncated: compacted.truncated,
    maxChars,
  };
}

function getRetryStatuses() {
  return new Set(
    String(state.settings.retryStatuses || '429,500,502,503,504')
      .split(',')
      .map(item => Number(item.trim()))
      .filter(Number.isFinite),
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function newId(prefix = 'id') {
  const cryptoApi = W.crypto || state.uiWindow?.crypto;
  if (cryptoApi?.randomUUID) return `${prefix}-${cryptoApi.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeReferenceCharacter(character = {}) {
  return {
    id: String(character.id || newId('character')),
    name: String(character.name || '').trim(),
    aliases: Array.isArray(character.aliases)
      ? character.aliases.map(item => String(item).trim()).filter(Boolean)
      : String(character.aliases || '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean),
    notes: String(character.notes || ''),
    enabled: character.enabled !== false,
    createdAt: Number(character.createdAt) || Date.now(),
    updatedAt: Number(character.updatedAt) || Date.now(),
  };
}

function normalizeReferenceCharacters(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map(normalizeReferenceCharacter).filter(character => {
    if (!character.name || seen.has(character.id)) return false;
    seen.add(character.id);
    return true;
  });
}

function getReferenceCharacters() {
  state.settings.referenceCharacters = normalizeReferenceCharacters(state.settings.referenceCharacters);
  return state.settings.referenceCharacters;
}

function getIndexedDbApi() {
  return W.indexedDB || state.uiWindow?.indexedDB || null;
}

function openReferenceDb() {
  if (state.referenceDb) return Promise.resolve(state.referenceDb);
  const indexedDb = getIndexedDbApi();
  if (!indexedDb) return Promise.reject(new Error('当前浏览器不支持 IndexedDB，无法持久化参考图'));
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(REFERENCE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(REFERENCE_DB_STORE)) {
        const store = db.createObjectStore(REFERENCE_DB_STORE, { keyPath: 'id' });
        store.createIndex('characterId', 'characterId', { unique: false });
      }
    };
    request.onsuccess = () => {
      state.referenceDb = request.result;
      state.referenceDb.onversionchange = () => {
        state.referenceDb?.close();
        state.referenceDb = null;
      };
      resolve(state.referenceDb);
    };
    request.onerror = () => reject(request.error || new Error('参考图库数据库打开失败'));
  });
}

async function referenceDbRequest(mode, action) {
  const db = await openReferenceDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REFERENCE_DB_STORE, mode);
    const store = tx.objectStore(REFERENCE_DB_STORE);
    let request;
    try {
      request = action(store);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error || request?.error || new Error('参考图库数据库操作失败'));
    tx.onabort = () => reject(tx.error || new Error('参考图库数据库操作已中止'));
  });
}

async function listReferenceImageRecords() {
  const records = await referenceDbRequest('readonly', store => store.getAll());
  return Array.isArray(records) ? records : [];
}

async function putReferenceImageRecord(record) {
  await referenceDbRequest('readwrite', store => store.put(record));
}

async function deleteReferenceImageRecord(imageId) {
  await referenceDbRequest('readwrite', store => store.delete(imageId));
}

async function deleteReferenceImagesForCharacter(characterId) {
  const records = [...state.referenceImages.values()].filter(item => item.characterId === characterId);
  if (!records.length) return;
  const db = await openReferenceDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(REFERENCE_DB_STORE, 'readwrite');
    const store = tx.objectStore(REFERENCE_DB_STORE);
    records.forEach(record => store.delete(record.id));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('删除角色参考图失败'));
    tx.onabort = () => reject(tx.error || new Error('删除角色参考图操作已中止'));
  });
}

async function refreshReferenceImages({ render = true } = {}) {
  try {
    const records = await listReferenceImageRecords();
    state.referenceImages = new Map(records.map(item => [item.id, item]));
    if (render) renderReferenceCharacters();
    renderReferenceMatchPreview();
    return records;
  } catch (error) {
    addLog('error', '读取参考图库失败', { error: error.message });
    setStatus(`参考图库读取失败：${error.message}`, 'error');
    return [];
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取图片文件失败'));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法解码参考图片'));
    image.src = dataUrl;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('参考图片压缩失败')), type, quality);
  });
}

async function prepareReferenceFile(file) {
  if (!file || !/^image\//i.test(file.type || '')) throw new Error('请选择图片文件');
  const maxBytes = Math.max(1, Number(state.settings.referenceMaxImageMB) || 8) * 1024 * 1024;
  const maxDimension = Math.max(512, Number(state.settings.referenceMaxDimension) || 2048);
  const originalDataUrl = await fileToDataUrl(file);
  const image = await loadImageElement(originalDataUrl);
  const supportedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
  const needsResize = image.naturalWidth > maxDimension
    || image.naturalHeight > maxDimension
    || file.size > maxBytes
    || !supportedMimeTypes.has(String(file.type || '').toLocaleLowerCase());
  if (!needsResize) {
    return {
      dataUrl: originalDataUrl,
      mimeType: file.type || 'image/png',
      size: file.size || Math.ceil(originalDataUrl.length * 0.75),
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  }

  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = makeEl('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法创建图片压缩画布');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await canvasToBlob(canvas, 'image/webp', 0.88);
  const dataUrl = await fileToDataUrl(blob);
  return {
    dataUrl,
    mimeType: blob.type || 'image/webp',
    size: blob.size,
    width: canvas.width,
    height: canvas.height,
  };
}

function dataUrlToBlob(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i);
  if (!match) throw new Error('参考图不是有效 data URL');
  const mimeType = match[1] || 'application/octet-stream';
  const raw = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

function referenceFileName(fileName, mimeType, fallbackBase = 'reference') {
  const extension = String(mimeType || 'image/png').split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
  const base = String(fileName || fallbackBase).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') || fallbackBase;
  return `${base}.${extension}`;
}

function referenceImagesForCharacter(characterId) {
  return [...state.referenceImages.values()]
    .filter(item => item.characterId === characterId)
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
}

function matchReferenceCharacters(prompt) {
  if (!state.settings.referenceEnabled) return [];
  const caseSensitive = Boolean(state.settings.referenceCaseSensitive);
  const normalize = value => {
    const text = String(value || '').normalize?.('NFKC') || String(value || '');
    return caseSensitive ? text : text.toLocaleLowerCase();
  };
  const source = normalize(prompt);
  const includesTerm = termValue => {
    const term = normalize(termValue);
    if (!term) return false;
    if (/^[a-z0-9][a-z0-9 _.'-]*$/i.test(term)) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, caseSensitive ? '' : 'i').test(source);
    }
    return source.includes(term);
  };
  const matches = [];
  for (const character of getReferenceCharacters()) {
    if (!character.enabled) continue;
    const terms = [character.name, ...character.aliases]
      .map(item => String(item || '').trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const matchedTerm = terms.find(includesTerm);
    if (matchedTerm) matches.push({ character, matchedTerm });
  }
  return matches
    .sort((a, b) => b.matchedTerm.length - a.matchedTerm.length || a.character.createdAt - b.character.createdAt)
    .slice(0, Math.max(1, Number(state.settings.referenceMaxCharacters) || 1));
}

function resolveReferenceContext(prompt) {
  const matches = matchReferenceCharacters(prompt);
  const imagesPerCharacter = Math.max(1, Number(state.settings.referenceImagesPerCharacter) || 1);
  const characters = [];
  const images = [];
  for (const match of matches) {
    const selected = referenceImagesForCharacter(match.character.id).slice(0, imagesPerCharacter);
    if (!selected.length) continue;
    characters.push({ ...match.character, matchedTerm: match.matchedTerm, imageCount: selected.length });
    selected.forEach(image => images.push({ ...image, characterName: match.character.name }));
  }
  return { characters, images };
}

function fillPromptTemplate(template, prompt, referenceContext) {
  const characters = referenceContext.characters.map(item => item.name).join('、') || '无';
  const notes = referenceContext.characters
    .map(item => item.notes ? `${item.name}：${item.notes}` : '')
    .filter(Boolean)
    .join('\n') || '无';
  const replacements = {
    '{{prompt}}': prompt,
    '{{characters}}': characters,
    '{{character_names}}': characters,
    '{{reference_count}}': String(referenceContext.images.length),
    '{{reference_notes}}': notes,
  };
  let result = String(template || '');
  for (const [token, value] of Object.entries(replacements)) result = result.replaceAll(token, value);
  if (!result.includes(prompt)) result = `${result}\n\n${prompt}`;
  return result.trim();
}

function resolveReferenceRequestMode(hasReferences) {
  if (!hasReferences) return 'text-only';
  const configured = String(state.settings.referenceRequestMode || 'auto');
  if (configured !== 'auto') return configured;
  const url = String(state.settings.referenceServiceUrl || state.settings.serviceUrl || '');
  if (/\/chat\/completions(?:\?|$|\/)?/i.test(url)) return 'chat-multimodal';
  if (/\/images\/edits(?:\?|$|\/)?/i.test(url)) return 'multipart-edit';
  return 'json-reference';
}

function buildImageRequest(prompt, referenceContext = { characters: [], images: [] }) {
  const settings = state.settings;
  const normalized = normalizeImagePromptForBackend(prompt);
  const backendPrompt = normalized.backendPrompt;
  const hasReferences = Boolean(referenceContext.images?.length);
  const finalPrompt = hasReferences
    ? fillPromptTemplate(settings.referencePromptTemplate, backendPrompt, referenceContext)
    : settings.promptTemplate.includes('{{prompt}}')
      ? settings.promptTemplate.replaceAll('{{prompt}}', backendPrompt)
      : `${settings.promptTemplate}\n\n${backendPrompt}`;
  const extraBody = parseJsonLoose(settings.extraBody, {});
  const url = hasReferences && settings.referenceServiceUrl
    ? settings.referenceServiceUrl
    : settings.serviceUrl;
  const mode = resolveReferenceRequestMode(hasReferences);
  let body;
  let fetchBody;
  let bodyForLog;
  const headers = {};

  if (mode === 'multipart-edit') {
    const form = new FormData();
    form.append('model', settings.model || 'gpt-image-2');
    form.append('prompt', finalPrompt);
    form.append('n', String(Math.max(1, Number(settings.imageN) || 1)));
    if (settings.imageSize) form.append('size', settings.imageSize);
    for (const [key, value] of Object.entries(extraBody)) {
      if (value == null) continue;
      form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    referenceContext.images.forEach((image, index) => {
      const blob = dataUrlToBlob(image.dataUrl);
      const filename = referenceFileName(
        image.fileName,
        image.mimeType || blob.type,
        `${image.characterName || 'reference'}-${index + 1}`,
      );
      form.append('image', blob, filename);
    });
    fetchBody = form;
    bodyForLog = {
      model: settings.model,
      prompt: finalPrompt,
      n: Math.max(1, Number(settings.imageN) || 1),
      size: settings.imageSize,
      extraBody,
      images: referenceContext.images.map(image => ({
        id: image.id,
        characterName: image.characterName,
        fileName: image.fileName,
        mimeType: image.mimeType,
        size: image.size,
        width: image.width,
        height: image.height,
      })),
    };
    body = bodyForLog;
  } else if (mode === 'chat-multimodal') {
    const content = [
      { type: 'text', text: finalPrompt },
      ...referenceContext.images.map(image => ({
        type: 'image_url',
        image_url: {
          url: image.dataUrl,
          detail: settings.referenceImageDetail || 'high',
        },
      })),
    ];
    body = {
      model: settings.model,
      messages: [{ role: 'user', content }],
      ...extraBody,
    };
    fetchBody = JSON.stringify(body);
    bodyForLog = body;
    headers['Content-Type'] = 'application/json';
  } else {
    const isChatEndpoint = /\/chat\/completions(?:\?|$|\/)?/i.test(url);
    const baseBody = isChatEndpoint
      ? {
          model: settings.model,
          messages: [{ role: 'user', content: finalPrompt }],
        }
      : {
          model: settings.model,
          prompt: finalPrompt,
          n: Math.max(1, Number(settings.imageN) || 1),
          size: settings.imageSize || '1024x1024',
        };
    body = { ...baseBody, ...extraBody };
    if (hasReferences) {
      const field = String(settings.referenceJsonField || 'images').trim() || 'images';
      const values = referenceContext.images.map(image => image.dataUrl);
      body[field] = /^(image|reference_image)$/i.test(field) ? values[0] : values;
      body.reference_characters = referenceContext.characters.map(character => character.name);
    }
    fetchBody = JSON.stringify(body);
    bodyForLog = body;
    headers['Content-Type'] = 'application/json';
  }

  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  return {
    url,
    headers,
    body,
    fetchBody,
    bodyForLog,
    finalPrompt,
    normalized,
    mode,
    referenceContext,
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = Number(timeoutMs) || 600000;
  const timer = setTimeout(() => controller.abort(new Error(`图片 API 超时：${timeout}ms`)), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(controller.signal.reason?.message || `图片 API 超时：${timeout}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function callImageApi(prompt, referenceContext = { characters: [], images: [] }) {
  const retryStatuses = getRetryStatuses();
  const maxAttempts = Math.max(1, Number(state.settings.retryMaxAttempts) || 1);
  const retryDelayMs = Math.max(0, Number(state.settings.retryDelayMs) || 0);
  let currentPrompt = prompt;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    updateStep('request', 'running', `正在组装请求体，第 ${attempt}/${maxAttempts} 次`);
    const request = buildImageRequest(currentPrompt, referenceContext);
    updateStep('request', 'ok', `模式 ${request.mode}`);
    addLog('info', '图片请求体已组装', {
      attempt,
      maxAttempts,
      url: request.url,
      mode: request.mode,
      originalPrompt: request.normalized.originalPrompt,
      backendPrompt: request.normalized.backendPrompt,
      promptChanged: request.normalized.changed,
      replacementsApplied: request.normalized.replacementsApplied,
      truncated: request.normalized.truncated,
      finalPrompt: request.finalPrompt,
      body: request.bodyForLog,
      headers: request.headers,
      referenceCharacters: request.referenceContext.characters.map(item => item.name),
      referenceImageCount: request.referenceContext.images.length,
    });

    updateStep('api', 'running', `正在请求图片后端，第 ${attempt}/${maxAttempts} 次`);
    const started = performance.now();
    let response = null;
    let responseText = '';
    let data = null;

    try {
      response = await fetchWithTimeout(
        request.url,
        {
          method: 'POST',
          headers: request.headers,
          body: request.fetchBody,
        },
        Number(state.settings.timeoutMs) || 600000,
      );
      responseText = await response.text();
      try {
        data = responseText ? JSON.parse(responseText) : null;
      } catch {
        data = null;
      }
    } catch (error) {
      const elapsedMs = performance.now() - started;
      lastError = error;
      addLog('error', '图片 API 请求异常', {
        attempt,
        maxAttempts,
        elapsedMs: Math.round(elapsedMs),
        error: error.message,
        stack: error.stack,
      });
      if (attempt < maxAttempts) {
        updateStep('api', 'running', `请求异常，${retryDelayMs}ms 后重试`);
        await sleep(retryDelayMs);
        continue;
      }
      updateStep('api', 'fail', error.message);
      throw error;
    }

    const elapsedMs = performance.now() - started;
    addLog(response.ok ? 'info' : 'error', '图片 API 返回', {
      attempt,
      maxAttempts,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      elapsedMs: Math.round(elapsedMs),
      json: data,
      text: data ? undefined : responseText,
    });

    if (response.ok) {
      updateStep('api', 'ok', `返回成功，耗时 ${(elapsedMs / 1000).toFixed(2)} 秒`);
      return { data, responseText, elapsedMs, request, attempt };
    }

    const errorText = data?.error?.message || responseText || response.statusText;
    lastError = new Error(`图片 API 请求失败：${response.status} ${response.statusText}，响应：${clip(errorText, 1200)}`);
    const shouldRetry = attempt < maxAttempts && retryStatuses.has(Number(response.status));
    if (!shouldRetry) {
      updateStep('api', 'fail', `${response.status} ${response.statusText}`);
      throw lastError;
    }

    updateStep('api', 'running', `${response.status} ${response.statusText}，${retryDelayMs}ms 后重试`);
    await sleep(retryDelayMs);
  }

  throw lastError || new Error('图片 API 请求失败：未知错误');
}

function extractUrlsByRegex(text) {
  const regex = parseRegexFromSetting(
    state.settings.responseImageRegex,
    '/!\\[[^\\]]*\\]\\(([^)\\s]+)\\)/g',
  );
  regex.lastIndex = 0;
  const urls = [];
  let match;
  while ((match = regex.exec(text || '')) !== null) {
    if (match[1]) urls.push(match[1].trim());
    if (regex.lastIndex === match.index) regex.lastIndex += 1;
  }
  return urls;
}

function looksLikeImageUrl(value) {
  const text = String(value || '').trim();
  return /^data:image\//i.test(text)
    || /^blob:/i.test(text)
    || /^https?:\/\//i.test(text)
    || /^\/[^/\s][^\s]*\.(png|jpe?g|webp|gif|bmp|svg)(\?|#|$)/i.test(text);
}

function imageFileExtension(url) {
  const text = String(url || '');
  const dataMatch = text.match(/^data:image\/([^;]+);/i);
  if (dataMatch?.[1]) return dataMatch[1].replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
  const urlMatch = text.match(/\.(png|jpe?g|webp|gif|bmp|svg)(?:[?#]|$)/i);
  return urlMatch?.[1]?.replace('jpeg', 'jpg').toLowerCase() || 'png';
}

function imageDownloadName(url) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `image2-${stamp}.${imageFileExtension(url)}`;
}

async function saveImage(url) {
  const href = String(url || '').trim();
  if (!href) return;
  const doc = uiDoc();
  const link = doc.createElement('a');
  link.href = href;
  link.download = imageDownloadName(href);
  link.rel = 'noopener';
  doc.body.appendChild(link);
  link.click();
  link.remove();
  setStatus('图片保存已触发', 'ok');
}

function closeImageLightbox() {
  q('#oair_lightbox')?.remove();
}

function lightboxField(doc, label, value, tag = 'span') {
  const field = doc.createElement('div');
  field.className = 'oair-lightbox-field';
  const key = doc.createElement('span');
  key.className = 'k';
  key.textContent = label;
  const content = doc.createElement(tag);
  content.className = 'v';
  content.textContent = value;
  field.append(key, content);
  return field;
}

function buildLightboxMeta(doc, meta, prompt) {
  const aside = doc.createElement('aside');
  aside.className = 'oair-lightbox-meta';
  if (meta.fields?.length) {
    const fields = doc.createElement('div');
    fields.className = 'oair-lightbox-fields';
    for (const [label, value] of meta.fields) fields.append(lightboxField(doc, label, value));
    aside.append(fields);
  }
  for (const [label, value] of [['原始 Prompt', prompt], ['提交 Prompt', meta.submittedPrompt]]) {
    if (!value) continue;
    const block = doc.createElement('div');
    block.className = 'oair-lightbox-block';
    block.append(lightboxField(doc, label, value, 'pre'));
    aside.append(block);
  }
  if (meta.json) {
    const details = doc.createElement('details');
    const summary = doc.createElement('summary');
    summary.textContent = '完整元数据与角色 / Persona 快照';
    const pre = doc.createElement('pre');
    pre.textContent = meta.json;
    details.append(summary, pre);
    aside.append(details);
  }
  return aside;
}

function openImageLightbox(url, prompt = '', meta = null) {
  const href = String(url || '').trim();
  if (!href) return;
  closeImageLightbox();
  const doc = uiDoc();
  const overlay = doc.createElement('div');
  overlay.id = 'oair_lightbox';
  overlay.innerHTML = `
    <div class="oair-lightbox-inner" role="dialog" aria-modal="true">
      <div class="oair-lightbox-toolbar">
        <span class="oair-lightbox-title"></span>
        <a class="oair-btn secondary" target="_blank" rel="noopener">打开原图</a>
        <button class="oair-btn secondary" id="oair_lightbox_save" type="button">保存</button>
        <button class="oair-btn secondary" id="oair_lightbox_close" type="button">关闭</button>
      </div>
      <div class="oair-lightbox-view"></div>
    </div>
  `;
  const view = overlay.querySelector('.oair-lightbox-view');
  const image = doc.createElement('img');
  image.className = 'oair-lightbox-img';
  image.alt = 'image2 大图预览';
  image.src = href;
  view.append(image);
  overlay.querySelector('.oair-lightbox-title').textContent = meta?.title ?? '';
  overlay.querySelector('a.oair-btn').href = href;
  if (meta) {
    view.classList.add('has-meta');
    view.append(buildLightboxMeta(doc, meta, prompt));
  } else if (prompt) {
    const text = doc.createElement('pre');
    text.className = 'oair-lightbox-prompt';
    text.textContent = prompt;
    view.append(text);
  }
  overlay.addEventListener('click', event => {
    if (event.target === overlay) closeImageLightbox();
  });
  overlay.querySelector('#oair_lightbox_close').addEventListener('click', closeImageLightbox);
  overlay.querySelector('#oair_lightbox_save').addEventListener('click', () => saveImage(href));
  doc.body.appendChild(overlay);
}

function bindImageActions(img, url, prompt = '') {
  img.title = '点击放大';
  img.style.cursor = 'zoom-in';
  img.addEventListener('click', () => openImageLightbox(url, prompt));
}

function appendImageActionButtons(host, doc, url, prompt = '', inlineStyle = false) {
  const actions = doc.createElement('div');
  actions.className = 'oair-image-actions';
  if (inlineStyle) actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

  const zoom = doc.createElement('button');
  zoom.type = 'button';
  zoom.className = 'oair-btn secondary';
  zoom.textContent = '放大';
  if (inlineStyle) zoom.style.cssText = 'color:#fff;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.18);border-radius:5px;padding:5px 9px;cursor:pointer;';
  zoom.addEventListener('click', () => openImageLightbox(url, prompt));

  const save = doc.createElement('button');
  save.type = 'button';
  save.className = 'oair-btn secondary';
  save.textContent = '保存';
  if (inlineStyle) save.style.cssText = zoom.style.cssText;
  save.addEventListener('click', () => saveImage(url));

  actions.append(zoom, save);
  host.appendChild(actions);
}

function collectImageUrls(data, responseText) {
  const urls = [];
  const seen = new Set();

  function push(value, source) {
    const text = String(value || '').trim();
    if (!text) return;
    if (looksLikeImageUrl(text)) {
      if (!seen.has(text)) {
        seen.add(text);
        urls.push({ url: text, source });
      }
    }
  }

  function pushBase64(value, source) {
    const text = String(value || '').trim();
    if (!text) return;
    const url = text.startsWith('data:image/') ? text : `data:image/png;base64,${text}`;
    push(url, source);
  }

  function visit(node, path = [], depth = 0) {
    if (depth > 8 || node == null) return;
    const key = String(path[path.length - 1] || '');
    if (typeof node === 'string') {
      if (/b64|base64/i.test(key) && /^[A-Za-z0-9+/=\s]+$/.test(node) && node.length > 100) {
        pushBase64(node.replace(/\s+/g, ''), path.join('.'));
      } else if (/url|uri|src|image|href|file/i.test(key)) {
        push(node, path.join('.'));
      }
      extractUrlsByRegex(node).forEach(url => push(url, `${path.join('.') || 'text'} markdown`));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...path, index], depth + 1));
      return;
    }
    if (typeof node === 'object') {
      if (node.url) push(node.url, [...path, 'url'].join('.'));
      if (node.image_url?.url) push(node.image_url.url, [...path, 'image_url.url'].join('.'));
      if (node.b64_json) pushBase64(node.b64_json, [...path, 'b64_json'].join('.'));
      if (node.base64) pushBase64(node.base64, [...path, 'base64'].join('.'));
      if (node.image_base64) pushBase64(node.image_base64, [...path, 'image_base64'].join('.'));
      for (const [childKey, child] of Object.entries(node)) {
        visit(child, [...path, childKey], depth + 1);
      }
    }
  }

  visit(data);
  extractUrlsByRegex(responseText || '').forEach(url => push(url, 'response text markdown'));
  return urls;
}

function imageMarkdown(url) {
  const safeUrl = String(url || '').trim();
  return `![image2](${safeUrl})`;
}

async function updateMessageWithImage(messageId, cleanedMessage, imageUrls) {
  if (!state.settings.appendImageToMessage) return;
  const message = `${cleanedMessage ? `${cleanedMessage}\n\n` : ''}${imageUrls.map(imageMarkdown).join('\n\n')}`;
  await tavern.setChatMessages([{ message_id: Number(messageId), message }]);
  updateStep('write', 'ok', `第 ${messageId} 楼已写入 ST 图片链接`);
}

async function processPromptToImage(prompt, options = {}) {
  const runStarted = performance.now();
  const startedAt = new Date().toISOString();
  const source = options.sourceSnapshot ?? captureSource(options.messageId);
  if (!options.keepSteps) resetSteps();
  setElapsed(NaN);
  setStatus('正在生成图片...', 'running');
  state.currentRun = { started: runStarted };

  try {
    updateStep('config', 'running', '读取当前设置');
    if (!state.settings.serviceUrl) throw new Error('服务地址为空');
    if (!prompt?.trim()) throw new Error('绘图提示词为空');
    updateStep('config', 'ok', '配置读取成功');

    const referenceContext = resolveReferenceContext(`${prompt}\n${options.matchText || ''}`);
    const referenceDetail = referenceContext.images.length
      ? `匹配 ${referenceContext.characters.map(item => item.name).join('、')}，附带 ${referenceContext.images.length} 张参考图`
      : '未匹配到可用角色参考图，使用文生图';
    updateStep('prompt', 'ok', `${clip(prompt, 120)}；${referenceDetail}`);
    addLog('info', '角色参考图匹配完成', {
      enabled: state.settings.referenceEnabled,
      prompt,
      matchText: options.matchText || '',
      characters: referenceContext.characters.map(item => ({
        id: item.id,
        name: item.name,
        matchedTerm: item.matchedTerm,
        imageCount: item.imageCount,
      })),
      images: referenceContext.images.map(item => ({
        id: item.id,
        characterName: item.characterName,
        fileName: item.fileName,
        mimeType: item.mimeType,
        size: item.size,
      })),
    });
    const result = await callImageApi(prompt.trim(), referenceContext);

    const completedAt = new Date().toISOString();
    updateStep('parse', 'running', '正在解析图片链接');
    const urls = collectImageUrls(result.data, result.responseText);
    if (!urls.length) {
      updateStep('parse', 'fail', '没有找到图片 URL 或 base64 图片字段');
      throw new Error('图片 API 返回成功，但没有解析到图片。请检查 media/data/url/b64_json 或返回图片正则。');
    }
    updateStep('parse', 'ok', `找到 ${urls.length} 张图片`);
    updateStep('write', 'running', '正在保存图片与元数据到 ST');
    const records = [];
    const submittedContent = result.request.body.prompt ?? result.request.body.messages?.[0]?.content ?? result.request.finalPrompt;
    const submittedPrompt = Array.isArray(submittedContent)
      ? submittedContent.filter(part => part.type === 'text').map(part => part.text).join('\n')
      : submittedContent;
    for (const image of urls) {
      const record = await saveGeneratedImage(image.url, {
        source, startedAt, completedAt,
        generationMs: result.elapsedMs, elapsedBeforeSaveMs: Math.round(performance.now() - runStarted),
        attempts: result.attempt, prompt, submittedPrompt,
        parameters: { model: result.request.body.model, size: result.request.body.size,
          n: result.request.body.n, mode: result.request.mode },
        references: referenceContext.images.map(({ id, characterName, fileName }) => ({ id, characterName, fileName })),
      });
      records.push(record);
      generatedGallery?.add(record);
    }
    const first = { url: records[0].imagePath };
    if (!options.previewOnly && options.messageId != null) {
      if (sourceIsCurrent(source, options.cleanedMessage)) {
        await updateMessageWithImage(options.messageId, options.cleanedMessage ?? '', records.map(r => r.imagePath));
      } else {
        addLog('warn', '来源聊天或楼层内容已变化，图片已保存到图库，未写回聊天');
      }
    }
    updateStep('write', 'ok', `已保存 ${records.length} 张图片与元数据`);

    const totalMs = performance.now() - runStarted;
    updateStep('done', 'ok', `总耗时 ${(totalMs / 1000).toFixed(2)} 秒`);
    setElapsed(totalMs);
    setStatus('生成成功', 'ok');
    addLog('info', '图片生成流程完成', {
      prompt,
      imageUrl: first.url,
      totalMs: Math.round(totalMs),
    });
    return {
      imageUrl: first.url,
      elapsedMs: totalMs,
      referenceCharacters: referenceContext.characters.map(item => item.name),
      referenceImageCount: referenceContext.images.length,
    };
  } catch (error) {
    const totalMs = performance.now() - runStarted;
    updateStep('done', 'fail', error.message);
    setElapsed(totalMs);
    setStatus(`生成失败：${error.message}`, 'error');
    addLog('error', '图片生成流程失败', {
      prompt,
      error: error.message,
      stack: error.stack,
      totalMs: Math.round(totalMs),
    });
    throw error;
  }
}

async function onGenerationAfterCommands(...args) {
  try {
    if (!state.settings.enabled || !state.settings.injectMainPrompt) return;
    tavern.uninjectPrompts([INJECT_ID]);
    tavern.injectPrompts([{
      id: INJECT_ID,
      depth: 0,
      role: 'system',
      content: state.settings.mainPrompt,
      should_scan: false,
    }]);
    addLog('info', '已为本次生成注入 image2 主提示词', {
      eventArgs: args,
      injectId: INJECT_ID,
      prompt: state.settings.mainPrompt,
    });
    setStatus('已注入本次 image2 提示规则', 'ok');
  } catch (error) {
    addLog('error', '注入主提示词失败', { error: error.message, stack: error.stack });
    setStatus(`注入失败：${error.message}`, 'error');
  }
}

async function onMessageReceived(messageIdLike, ...args) {
  const messageId = Number(messageIdLike);
  if (!state.settings.enabled || !state.settings.processAssistantMessages) return;
  if (!Number.isFinite(messageId)) {
    addLog('warn', 'MESSAGE_RECEIVED 的楼层号不是数字，跳过', { messageIdLike, args });
    return;
  }
  if (state.inFlightMessages.has(messageId)) return;
  state.inFlightMessages.add(messageId);

  try {
    resetSteps();
    setStatus(`收到第 ${messageId} 楼，正在检查图片标签...`, 'running');
    updateStep('message', 'running', `读取第 ${messageId} 楼`);

    const messages = tavern.getChatMessages(messageId, { include_swipes: false });
    const message = messages?.[0];
    if (!message) {
      updateStep('message', 'fail', `第 ${messageId} 楼不存在`);
      addLog('warn', '未读取到聊天消息', { messageId, args });
      return;
    }
    updateStep('message', 'ok', `role=${message.role}, name=${message.name || ''}`);
    addLog('info', '读取聊天消息成功', { messageId, message });

    if (message.role !== 'assistant') {
      addLog('info', '不是 assistant 消息，跳过图片处理', { messageId, role: message.role });
      return;
    }

    const sourceSnapshot = captureSource(messageId);
    updateStep('prompt', 'running', '正在提取 <pic prompt="...">');
    const extracted = extractPicPrompts(message.message || '');
    if (!extracted.prompts.length) {
      if (state.settings.autoFallbackWhenNoPic) {
        updateStep('prompt', 'running', '没有发现 <pic>，启用补救生成');
        addLog('info', '消息中没有 pic 标签，启用补救生成', {
          messageId,
          text: message.message,
        });
        const fallbackPrompt = await generateFallbackPromptFromMessage(message);
        await processPromptToImage(fallbackPrompt, {
          messageId,
          sourceSnapshot,
          cleanedMessage: message.message || '',
          keepSteps: true,
          matchText: message.message || '',
        });
        return;
      }
      updateStep('prompt', 'ok', '没有图片标签，跳过');
      addLog('info', '消息中没有 pic 标签', { messageId, text: message.message });
      setStatus('未发现图片标签', 'info');
      return;
    }

    const prompt = extracted.prompts[0];
    updateStep('prompt', 'ok', `找到 ${extracted.prompts.length} 条，使用第一条`);
    addLog('info', '已提取绘图提示词', {
      messageId,
      prompt,
      allPrompts: extracted.prompts,
      cleanedMessage: extracted.cleaned,
    });

    let cleanedMessage = state.settings.removePicTag ? extracted.cleaned : message.message;
    let messageAlreadyCleaned = false;
    if (state.settings.removePicTag) {
      updateStep('write', 'running', '先移除原始 pic 标签');
      await tavern.setChatMessages([{ message_id: messageId, message: cleanedMessage }]);
      messageAlreadyCleaned = true;
      updateStep('write', 'ok', 'pic 标签已移除');
    }

    await processPromptToImage(prompt, {
      messageId,
      sourceSnapshot,
      cleanedMessage,
      messageAlreadyCleaned,
      keepSteps: true,
      matchText: message.message || '',
    });
  } catch (error) {
    addLog('error', '自动处理聊天图片失败', {
      messageId,
      error: error.message,
      stack: error.stack,
    });
    setStatus(`自动处理失败：${error.message}`, 'error');
  } finally {
    state.inFlightMessages.delete(messageId);
  }
}

function getSettingsFromUi() {
  const next = { ...state.settings };
  qa('[data-oair-setting]').forEach(el => {
    const key = el.dataset.oairSetting;
    if (!key) return;
    if (el.type === 'radio') {
      if (el.checked) next[key] = el.value;
    } else if (el.type === 'checkbox') {
      next[key] = el.checked;
    } else if (el.type === 'number') {
      next[key] = Number(el.value);
    } else {
      next[key] = el.value;
    }
  });
  state.settings = { ...defaultSettings, ...next };
  applyImagePromptWordingRules();
  return state.settings;
}

function appendImagePromptWordingRules(text) {
  const value = String(text || '').trim();
  if (value.includes('【image2 绘图提示词措辞控制】')) return value;
  return `${value}\n\n${IMAGE_PROMPT_WORDING_RULES}`.trim();
}

function applyImagePromptWordingRules() {
  state.settings.mainPrompt = appendImagePromptWordingRules(state.settings.mainPrompt);
}

// 旧版本把措辞规则拼在 summaryPrompt / fallbackPrompt 末尾一起保存，迁移时按标记切掉，改由预设条目承担。
function stripImagePromptWordingRules(text) {
  const value = String(text || '');
  const index = value.indexOf('【image2 绘图提示词措辞控制】');
  return (index < 0 ? value : value.slice(0, index)).trim();
}

function normalizePromptEntry(source, index) {
  if (!source || typeof source !== 'object') return null;
  const role = PROMPT_ROLES.includes(source.role) ? source.role : 'user';
  if (source.kind === 'context') {
    const known = CONTEXT_SECTIONS.find(item => item.section === source.section);
    if (!known) return null;
    return {
      id: String(source.id || `context-${known.section}-${index + 1}`),
      kind: 'context',
      section: known.section,
      name: known.name,
      role,
      enabled: source.enabled !== false,
      content: '',
    };
  }
  return {
    id: String(source.id || `prompt-${index + 1}`),
    kind: 'text',
    name: String(source.name ?? '').trim() || `Prompt ${index + 1}`,
    role,
    enabled: source.enabled !== false,
    content: String(source.content ?? ''),
  };
}

function normalizePromptEntries(entries) {
  const used = new Set();
  const result = [];
  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const normalized = normalizePromptEntry(entry, index);
    if (!normalized) continue;
    while (used.has(normalized.id)) normalized.id = `${normalized.id}-copy`;
    used.add(normalized.id);
    result.push(normalized);
  }
  return result;
}

function normalizePromptProfile(source, index) {
  return {
    id: String(source?.id || `profile-${index + 1}`),
    name: String(source?.name ?? '').trim(),
    basedOn: ['summary', 'fallback'].includes(source?.basedOn) ? source.basedOn : 'custom',
    prompts: normalizePromptEntries(source?.prompts),
  };
}

function normalizePromptProfiles(profiles) {
  const list = (Array.isArray(profiles) ? profiles : []).map(normalizePromptProfile);
  if (!list.length) return createDefaultProfiles();
  const used = new Set();
  for (const profile of list) {
    while (used.has(profile.id)) profile.id = `${profile.id}-copy`;
    used.add(profile.id);
    if (!profile.name) profile.name = `预设 ${used.size}`;
  }
  return list;
}

function findPromptProfile(profileId) {
  return state.settings.summaryProfiles.find(profile => profile.id === profileId) ?? null;
}

function resolvePromptProfile(profileId, basedOn) {
  return findPromptProfile(profileId)
    ?? state.settings.summaryProfiles.find(profile => profile.basedOn === basedOn)
    ?? state.settings.summaryProfiles[0];
}

function getSummaryProfile() {
  return resolvePromptProfile(state.settings.summaryProfileId, 'summary');
}

function getFallbackProfile() {
  return resolvePromptProfile(state.settings.fallbackProfileId, 'fallback');
}

function getEditingProfile() {
  return findPromptProfile(state.editingProfileId) ?? getSummaryProfile();
}

function setPromptEntryEnabled(profile, entryId, enabled) {
  const entry = profile.prompts.find(item => item.id === entryId);
  if (entry) entry.enabled = enabled;
}

// 第 4 步用的预设、补救用的预设都从同一个预设库里挑，各自独立选择。
function migratePromptProfiles() {
  const settings = state.settings;
  const legacySummary = typeof settings.summaryPrompt === 'string' ? stripImagePromptWordingRules(settings.summaryPrompt) : null;
  const legacyFallback = typeof settings.fallbackPrompt === 'string' ? stripImagePromptWordingRules(settings.fallbackPrompt) : null;
  const legacyWorldbooks = typeof settings.summaryIncludeWorldbooks === 'boolean' ? settings.summaryIncludeWorldbooks : null;
  const legacyVariables = typeof settings.summaryIncludeVariables === 'boolean' ? settings.summaryIncludeVariables : null;
  const changed = legacySummary !== null || legacyFallback !== null || legacyWorldbooks !== null || legacyVariables !== null;

  for (const profile of settings.summaryProfiles) {
    if (profile.basedOn !== 'summary' && profile.basedOn !== 'fallback') continue;
    const legacy = profile.basedOn === 'summary' ? legacySummary : legacyFallback;
    if (legacy) {
      const entry = profile.prompts.find(item => item.kind === 'text');
      if (entry) entry.content = legacy;
    }
    if (legacyWorldbooks === false) setPromptEntryEnabled(profile, `${profile.basedOn}-context-worldbook`, false);
    if (legacyVariables === true) setPromptEntryEnabled(profile, `${profile.basedOn}-context-variables`, true);
  }

  delete settings.summaryPrompt;
  delete settings.fallbackPrompt;
  delete settings.summaryIncludeWorldbooks;
  delete settings.summaryIncludeVariables;
  return changed;
}

function migratePromptHandlingSettings() {
  delete state.settings.retryUseUltraSafePromptOn403;
  if (String(state.settings.retryStatuses || '').trim() === '403,429,500,502,503,504') {
    state.settings.retryStatuses = '429,500,502,503,504';
  }
  if (String(state.settings.imageSafetyPrefix || '').startsWith('纯SFW安全画面')) {
    state.settings.imageSafetyPrefix = '';
    state.settings.normalizeImagePrompt = false;
  }
}

function writeSettingsToUi() {
  qa('[data-oair-setting]').forEach(el => {
    const key = el.dataset.oairSetting;
    if (!key) return;
    const value = state.settings[key];
    if (el.type === 'radio') {
      el.checked = el.value === String(value ?? '');
    } else if (el.type === 'checkbox') {
      el.checked = Boolean(value);
    } else {
      el.value = value ?? '';
    }
  });
}

function loadSettings() {
  state.settings = { ...defaultSettings, ...tavern.loadSettings() };
  state.settings.referenceCharacters = normalizeReferenceCharacters(state.settings.referenceCharacters);
  state.settings.summaryProfiles = normalizePromptProfiles(state.settings.summaryProfiles);
  state.settings.summaryProfileId = getSummaryProfile().id;
  state.settings.fallbackProfileId = getFallbackProfile().id;
  migratePromptHandlingSettings();
  applyImagePromptWordingRules();
  if (migratePromptProfiles()) {
    tavern.saveSettings(state.settings);
    console.log(`[${NS}] 已把旧的整理/补救提示词迁入提示词预设`);
  }
}

function saveSettings(options = {}) {
  getSettingsFromUi();
  try {
    tavern.saveSettings(state.settings);
    if (!options.silent) {
      addLog('info', '设置已保存', { settings: state.settings });
      setStatus('设置已保存', 'ok');
      notify('success', 'image2 参考图增强版设置已保存');
    }
  } catch (error) {
    addLog('error', '保存设置失败', { error: error.message, stack: error.stack });
    setStatus(`保存失败：${error.message}`, 'error');
    notify('error', `保存失败：${error.message}`);
  }
}

function getLastAssistantMessageId() {
  const { chat } = SillyTavern.getContext();
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    if (tavern.getChatMessages(index)[0]?.role === 'assistant') return index;
  }
  return null;
}

function readTestFloor() {
  const { chat } = SillyTavern.getContext();
  const raw = q('#oair_test_message')?.value?.trim() ?? '';
  const messageId = raw === '' ? getLastAssistantMessageId() : Number(raw);
  if (messageId == null) throw new Error('当前聊天没有 assistant 楼层，请填写楼层号');
  if (!Number.isInteger(messageId) || messageId < 0 || messageId >= chat.length) {
    throw new Error(`楼层号无效：${raw || messageId}（当前共 ${chat.length} 楼，从 0 开始）`);
  }
  const message = tavern.getChatMessages(messageId)[0];
  if (!message) throw new Error(`楼层 ${messageId} 不存在`);
  return { messageId, message, usedDefault: raw === '' };
}

function readTestFloorPrompt() {
  const floor = readTestFloor();
  const extracted = extractPicPrompts(floor.message.message || '');
  const prompt = extracted.prompts[0];
  if (!prompt) throw new Error(`第 ${floor.messageId} 楼没有匹配到提示词`);
  addLog('info', '已从聊天楼层提取提示词', {
    messageId: floor.messageId,
    usedDefaultFloor: floor.usedDefault,
    role: floor.message.role,
    name: floor.message.name || '',
    promptCount: extracted.prompts.length,
    prompt,
  });
  return { messageId: floor.messageId, prompt };
}

function logTestFailure(error) {
  addLog('error', '生图测试失败', { error: error.message, stack: error.stack });
  setStatus(`测试失败：${error.message}`, 'error');
}

async function runImageTest() {
  saveSettings();
  const input = q('#oair_test_prompt');
  let prompt = input?.value?.trim() || '';
  if (!prompt) {
    try {
      const extracted = readTestFloorPrompt();
      prompt = extracted.prompt;
      if (input) input.value = prompt;
      setStatus(`提示词为空，已从第 ${extracted.messageId} 楼提取`, 'ok');
    } catch (error) {
      logTestFailure(error);
      return;
    }
  }
  try {
    await processPromptToImage(prompt, { previewOnly: true });
  } catch {
    // Already logged by processPromptToImage.
  }
}

function runExtractPromptFromMessage() {
  saveSettings();
  try {
    const extracted = readTestFloorPrompt();
    const input = q('#oair_test_prompt');
    if (input) input.value = extracted.prompt;
    setStatus(`已从第 ${extracted.messageId} 楼提取提示词`, 'ok');
  } catch (error) {
    logTestFailure(error);
  }
}

function buildCustomApiForSummary() {
  const s = state.settings;
  const mode = s.summaryApiMode || 'tavern';
  if (mode === 'tavern') {
    return s.summaryModel ? { model: s.summaryModel } : undefined;
  }
  if (mode === 'proxy') {
    return {
      proxy_preset: s.summaryProxyPreset,
      model: s.summaryModel || undefined,
      source: s.summarySource || undefined,
    };
  }
  return {
    apiurl: s.summaryApiUrl,
    key: s.summaryApiKey,
    model: s.summaryModel,
    source: s.summarySource || 'openai',
  };
}

// 按当前预设真正启用的素材条目读取上下文，没被选中的世界书和聊天变量就不读。
async function collectContextSections(sections, { historyEndId = null } = {}) {
  const wanted = new Set(sections.filter(section => section !== 'reply'));
  const context = SillyTavern.getContext();
  const texts = new Map();
  const report = {
    requested: [...wanted],
    characterRead: false,
    worldbooks: [],
    messages: 0,
    historyEnd: historyEndId,
  };

  if (!wanted.size) {
    updateStep('message', 'ok', '当前预设不读取上下文素材');
    addLog('info', '上下文读取完成', { report, texts: {} });
    return texts;
  }

  updateStep('message', 'running', '读取角色卡/世界书激活/聊天历史');

  if (wanted.has('character')) {
    const character = context.characters[context.characterId];
    if (character) {
      const card = { ...character, ...character.data };
      const firstMessages = [card.first_mes, ...(card.alternate_greetings ?? []), ...(card.first_messages ?? [])].filter(Boolean);
      report.characterRead = true;
      texts.set('character', [
        '# 角色卡',
        card.name ? `名称：${card.name}` : '',
        card.description ? `描述：${card.description}` : '',
        card.personality ? `性格：${card.personality}` : '',
        card.scenario ? `场景：${card.scenario}` : '',
        card.mes_example ? `示例对话：${card.mes_example}` : '',
        firstMessages.length ? `开场白：${firstMessages.join('\n')}` : '',
      ].filter(Boolean).join('\n'));
    }
  }

  if (wanted.has('worldbook')) {
    const limit = Number(state.settings.summaryWorldbookEntryLimit);
    const activated = await tavern.getActivatedWorldInfo({ upToMessageId: historyEndId });
    report.worldbooks = activated.map(({ world, uid, name }) => ({ world, uid, name }));
    const bookTexts = activated.slice(0, limit)
      .map(entry => `【${entry.world} / ${entry.name}】\n${clip(entry.content, 900)}`);
    if (bookTexts.length) texts.set('worldbook', `# 世界书片段\n${bookTexts.join('\n\n')}`);
  }

  if (wanted.has('history') && context.chat.length) {
    const last = historyEndId == null ? context.chat.length - 1 : Math.min(historyEndId, context.chat.length - 1);
    const count = Math.max(1, Number(state.settings.summaryMaxChatHistory));
    const start = Math.max(0, last - count + 1);
    const messages = tavern.getChatMessages(`${start}-${last}`, { hide_state: 'unhidden' });
    report.messages = messages.length;
    const text = messages.map(message => {
      const content = message.message.replace(/<pic[^>]*>/g, '').trim();
      return `${message.role}${message.name ? `(${message.name})` : ''}: ${clip(content, 1200)}`;
    }).join('\n\n');
    if (text) texts.set('history', `# 最近聊天记录\n${text}`);
  }

  if (wanted.has('variables')) {
    texts.set('variables', `# 聊天变量\n${safeStringify(context.chatMetadata.variables ?? {})}`);
  }

  const readCount = [...texts.values()].filter(text => String(text || '').trim()).length;
  updateStep('message', readCount ? 'ok' : 'fail', readCount ? '上下文读取成功' : '没有读到可用上下文');
  addLog('info', '上下文读取完成', { report, texts: Object.fromEntries(texts) });
  return texts;
}

// 聊天变量属于敏感素材，只有显式打开「聊天变量」条目才会读取；{{image2_context}} 负责三段剧情素材。
const MACRO_MATERIAL_SECTIONS = ['character', 'worldbook', 'history'];

function profileMaterialSections(profile) {
  const sections = profile.prompts
    .filter(entry => entry.enabled && entry.kind === 'context')
    .map(entry => entry.section);
  if (profileUsesContextMacro(profile)) {
    for (const section of MACRO_MATERIAL_SECTIONS) {
      if (!sections.includes(section)) sections.push(section);
    }
  }
  return [...new Set(sections)].filter(section => section !== 'reply');
}

function profileUsesContextMacro(profile) {
  return profile.prompts.some(entry => entry.enabled && entry.kind === 'text' && /\{\{\s*image2_context\s*\}\}/i.test(entry.content || ''));
}

function contextMacroText(texts) {
  return CONTEXT_SECTIONS
    .filter(({ section }) => section !== 'reply')
    .map(({ section }) => texts.get(section))
    .filter(text => String(text || '').trim())
    .join('\n\n');
}

// 预设自带两个宏：{{image2_context}} 一次插入三段剧情素材，{{image2_reply}} 只插入本次回复正文。
function expandProfileMacros(text, { sourceMessage, texts }) {
  return String(text ?? '')
    .replace(/\{\{\s*image2_context\s*\}\}/gi, () => contextMacroText(texts))
    .replace(/\{\{\s*image2_reply\s*\}\}/gi, () => sourceMessage);
}

function promptEntryText(entry, { sourceMessage, texts }) {
  // 宏只在自定义 Prompt 上展开，内置素材条目直接用读到的原文。
  if (entry.kind !== 'context') return expandProfileMacros(entry.content, { sourceMessage, texts });
  // 素材的小标题由读取时的文本自带，回复正文这里补一个，和旧版写法保持一致。
  if (entry.section === 'reply') return sourceMessage ? `# 本次 assistant 回复\n${sourceMessage}` : '';
  return texts.get(entry.section) ?? '';
}

function buildProfileMessages(profile, { sourceMessage = '', texts = new Map() } = {}) {
  const messages = [];
  const sources = [];
  const skipped = [];
  for (const entry of profile.prompts) {
    if (!entry.enabled) {
      skipped.push({ name: entry.name, reason: 'disabled' });
      continue;
    }
    const content = String(promptEntryText(entry, { sourceMessage, texts }) || '').trim();
    if (!content) {
      skipped.push({ name: entry.name, reason: 'empty' });
      continue;
    }
    messages.push({ role: entry.role, content });
    sources.push(entry.name);
  }
  return { messages, sources, skipped };
}

async function generatePromptByScriptContext({
  profile,
  sourceMessage = '',
  sourceLabel = 'context',
  keepSteps = false,
  historyEndId = null,
} = {}) {

  if (!keepSteps) resetSteps();
  setElapsed(NaN);
  setStatus(sourceLabel === 'fallback' ? '未发现 pic 标签，正在补救生成提示词...' : '正在从上下文整理绘图提示词...', 'running');
  const started = performance.now();

  try {
    updateStep('config', 'running', '读取提示词生成 API 设置');
    const customApi = buildCustomApiForSummary();
    updateStep('config', 'ok', state.settings.summaryApiMode === 'tavern' ? '使用酒馆当前连接' : '使用额外 API 配置');
    addLog('info', '提示词生成 API 配置已读取', {
      sourceLabel,
      profile: { id: profile.id, name: profile.name },
      mode: state.settings.summaryApiMode,
      customApi,
    });

    const sections = profileMaterialSections(profile);
    const texts = await collectContextSections(sections, { historyEndId });
    const hasMaterial = Boolean(String(sourceMessage || '').trim())
      || [...texts.values()].some(text => String(text || '').trim());
    if (!hasMaterial) throw new Error('没有可用于整理的上下文或消息正文');

    const { messages, skipped } = buildProfileMessages(profile, { sourceMessage, texts });
    if (!messages.length) throw new Error(`预设「${profile.name}」没有可发送的 Prompt，请在第 4 步检查条目开关`);

    updateStep('prompt', 'running', sourceLabel === 'fallback' ? '正在补救生成 <pic> 提示词' : '正在调用 AI 整理提示词');
    addLog('info', '已按预设组装提示词请求', {
      sourceLabel,
      profile: { id: profile.id, name: profile.name },
      messages,
      skipped,
    });

    const result = await tavern.generateRaw({
      ordered_prompts: messages,
      custom_api: customApi,
      substitute_macros: true,
    });

    const extracted = extractPicPrompts(result || '');
    const prompt = (extracted.prompts[0] || String(result || '').replace(/^["“]|["”]$/g, '').trim()).trim();
    if (!prompt) throw new Error('AI 没有返回可用绘图提示词');

    const elapsedMs = performance.now() - started;
    updateStep('prompt', 'ok', clip(prompt, 160));
    updateStep('done', 'ok', `提示词生成完成，耗时 ${(elapsedMs / 1000).toFixed(2)} 秒`);
    setElapsed(elapsedMs);
    setStatus(sourceLabel === 'fallback' ? '补救提示词生成成功' : '提示词生成成功', 'ok');
    addLog('info', sourceLabel === 'fallback' ? '已补救生成绘图提示词' : 'AI 已生成绘图提示词', {
      sourceLabel,
      profile: { id: profile.id, name: profile.name },
      rawResult: result,
      prompt,
      elapsedMs: Math.round(elapsedMs),
    });
    return prompt;
  } catch (error) {
    const elapsedMs = performance.now() - started;
    updateStep('done', 'fail', error.message);
    setElapsed(elapsedMs);
    setStatus(`提示词生成失败：${error.message}`, 'error');
    addLog('error', '绘图提示词生成失败', {
      sourceLabel,
      profile: { id: profile?.id, name: profile?.name },
      error: error.message,
      stack: error.stack,
      elapsedMs: Math.round(elapsedMs),
    });
    throw error;
  }
}

async function generateFallbackPromptFromMessage(message) {
  return generatePromptByScriptContext({
    profile: getFallbackProfile(),
    sourceMessage: String(message?.message || '').replace(/<pic[^>]*>/g, '').trim(),
    sourceLabel: 'fallback',
    keepSteps: true,
  });
}

function generatePromptFromContext({ sourceMessage = '', historyEndId = null } = {}) {
  return generatePromptByScriptContext({
    profile: getSummaryProfile(),
    sourceMessage,
    historyEndId,
    sourceLabel: 'context',
    keepSteps: false,
  });
}

async function runContextPromptOnly() {
  saveSettings();
  let floor;
  try {
    floor = readTestFloor();
  } catch (error) {
    logTestFailure(error);
    return;
  }
  try {
    const prompt = await generatePromptFromContext({
      sourceMessage: String(floor.message.message || '').replace(/<pic[^>]*>/g, '').trim(),
      historyEndId: floor.messageId,
    });
    const input = q('#oair_test_prompt');
    if (input) input.value = prompt;
  } catch {
    // Already logged by generatePromptByScriptContext.
  }
}

function persistReferenceSettings() {
  state.settings.referenceCharacters = normalizeReferenceCharacters(state.settings.referenceCharacters);
  saveSettings({ silent: true });
}

function updateReferenceCharacter(characterId, patch) {
  const characters = getReferenceCharacters();
  const index = characters.findIndex(item => item.id === characterId);
  if (index < 0) return;
  characters[index] = normalizeReferenceCharacter({
    ...characters[index],
    ...patch,
    id: characterId,
    updatedAt: Date.now(),
  });
  persistReferenceSettings();
  renderReferenceMatchPreview();
}

function createReferenceCharacter() {
  const nameInput = q('#oair_reference_new_name');
  const aliasInput = q('#oair_reference_new_aliases');
  const name = nameInput?.value?.trim();
  if (!name) {
    setStatus('请先填写角色名', 'error');
    nameInput?.focus();
    return;
  }
  const duplicate = getReferenceCharacters().some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (duplicate) {
    setStatus(`角色“${name}”已经存在`, 'error');
    return;
  }
  const character = normalizeReferenceCharacter({
    id: newId('character'),
    name,
    aliases: aliasInput?.value || '',
    enabled: true,
  });
  state.settings.referenceCharacters.push(character);
  persistReferenceSettings();
  if (nameInput) nameInput.value = '';
  if (aliasInput) aliasInput.value = '';
  renderReferenceCharacters();
  setStatus(`已新建角色参考区：${name}`, 'ok');
  addLog('info', '已新建角色参考区', { character });
}

async function handleReferenceFiles(characterId, files) {
  const character = getReferenceCharacters().find(item => item.id === characterId);
  if (!character) throw new Error('角色不存在');
  const selected = Array.from(files || []);
  if (!selected.length) return;
  setStatus(`正在导入 ${character.name} 的 ${selected.length} 张参考图...`, 'running');
  let imported = 0;
  for (const file of selected) {
    try {
      const prepared = await prepareReferenceFile(file);
      const record = {
        id: newId('image'),
        characterId,
        fileName: referenceFileName(file.name, prepared.mimeType, `reference-${Date.now()}`),
        mimeType: prepared.mimeType,
        size: prepared.size,
        width: prepared.width,
        height: prepared.height,
        dataUrl: prepared.dataUrl,
        createdAt: Date.now() + imported,
      };
      await putReferenceImageRecord(record);
      imported += 1;
    } catch (error) {
      addLog('error', '参考图导入失败', { character: character.name, fileName: file?.name, error: error.message });
    }
  }
  await refreshReferenceImages();
  setStatus(`已为 ${character.name} 导入 ${imported}/${selected.length} 张参考图`, imported ? 'ok' : 'error');
  addLog('info', '角色参考图导入完成', { character: character.name, imported, total: selected.length });
}

async function removeReferenceImage(imageId) {
  const record = state.referenceImages.get(imageId);
  if (!record) return;
  await deleteReferenceImageRecord(imageId);
  state.referenceImages.delete(imageId);
  renderReferenceCharacters();
  renderReferenceMatchPreview();
  setStatus('参考图已删除', 'ok');
  addLog('info', '参考图已删除', { imageId, characterId: record.characterId, fileName: record.fileName });
}

async function removeReferenceCharacter(characterId) {
  const character = getReferenceCharacters().find(item => item.id === characterId);
  if (!character) return;
  const confirmed = (state.uiWindow || W).confirm?.(`确定删除角色“${character.name}”及其全部参考图吗？`);
  if (confirmed === false) return;
  await deleteReferenceImagesForCharacter(characterId);
  state.settings.referenceCharacters = getReferenceCharacters().filter(item => item.id !== characterId);
  persistReferenceSettings();
  await refreshReferenceImages();
  setStatus(`角色“${character.name}”已删除`, 'ok');
  addLog('info', '角色参考区已删除', { characterId, name: character.name });
}

function downloadTextFile(fileName, text, mimeType = 'application/json') {
  const doc = uiDoc();
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  const URLApi = state.uiWindow?.URL || W.URL || URL;
  const url = URLApi.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = fileName;
  doc.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URLApi.revokeObjectURL(url), 1000);
}

function buildReferenceExport(characterIds = null) {
  const allowed = characterIds ? new Set(characterIds) : null;
  const characters = getReferenceCharacters().filter(item => !allowed || allowed.has(item.id));
  const characterSet = new Set(characters.map(item => item.id));
  const images = [...state.referenceImages.values()].filter(item => characterSet.has(item.characterId));
  return {
    type: 'oair-image2-character-reference-library',
    version: 1,
    exportedAt: new Date().toISOString(),
    characters,
    images,
  };
}

function exportReferenceLibrary(characterId = null) {
  const payload = buildReferenceExport(characterId ? [characterId] : null);
  const label = characterId
    ? payload.characters[0]?.name?.replace(/[\\/:*?"<>|]/g, '_') || 'character'
    : 'all-characters';
  downloadTextFile(`image2-reference-${label}.json`, JSON.stringify(payload, null, 2));
  setStatus(`已导出 ${payload.characters.length} 个角色、${payload.images.length} 张参考图`, 'ok');
  addLog('info', '参考图库已导出', {
    characters: payload.characters.map(item => item.name),
    imageCount: payload.images.length,
  });
}

async function importReferenceLibrary(file) {
  if (!file) return;
  const raw = await file.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(`导入文件不是有效 JSON：${error.message}`);
  }
  if (payload?.type !== 'oair-image2-character-reference-library' || !Array.isArray(payload.characters)) {
    throw new Error('不是 image2 角色参考图库导出文件');
  }

  const currentCharacters = getReferenceCharacters();
  const usedCharacterIds = new Set(currentCharacters.map(item => item.id));
  const idMap = new Map();
  const importedCharacters = [];
  for (const source of payload.characters) {
    const oldId = String(source.id || '');
    let id = oldId && !usedCharacterIds.has(oldId) ? oldId : newId('character');
    usedCharacterIds.add(id);
    let name = String(source.name || '').trim() || '未命名角色';
    const baseName = name;
    let suffix = 2;
    while ([...currentCharacters, ...importedCharacters].some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      name = `${baseName} (${suffix})`;
      suffix += 1;
    }
    const character = normalizeReferenceCharacter({ ...source, id, name });
    idMap.set(oldId, id);
    importedCharacters.push(character);
  }

  let imageCount = 0;
  for (const source of Array.isArray(payload.images) ? payload.images : []) {
    const characterId = idMap.get(String(source.characterId || ''));
    if (!characterId || !isDataImageUrl(source.dataUrl)) continue;
    const maxBytes = Math.max(1, Number(state.settings.referenceMaxImageMB) || 8) * 1024 * 1024;
    if (String(source.dataUrl).length > maxBytes * 1.5) continue;
    const record = {
      id: state.referenceImages.has(source.id) ? newId('image') : String(source.id || newId('image')),
      characterId,
      fileName: String(source.fileName || 'imported-reference.png'),
      mimeType: String(source.mimeType || 'image/png'),
      size: Number(source.size) || 0,
      width: Number(source.width) || 0,
      height: Number(source.height) || 0,
      dataUrl: String(source.dataUrl),
      createdAt: Number(source.createdAt) || Date.now() + imageCount,
    };
    await putReferenceImageRecord(record);
    imageCount += 1;
  }

  state.settings.referenceCharacters = [...currentCharacters, ...importedCharacters];
  persistReferenceSettings();
  await refreshReferenceImages();
  setStatus(`已导入 ${importedCharacters.length} 个角色、${imageCount} 张参考图`, 'ok');
  addLog('info', '参考图库导入完成', {
    characters: importedCharacters.map(item => item.name),
    imageCount,
  });
}

function makePromptAction(text, action, title, disabled = false) {
  const button = makeEl('button');
  button.type = 'button';
  button.className = 'oair-btn secondary oair-prompt-action';
  button.textContent = text;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.dataset.promptAction = action;
  button.disabled = disabled;
  return button;
}

function promptEntryPreview(entry) {
  if (entry.kind === 'context') return MATERIAL_SECTION_HINTS[entry.section] ?? '';
  const text = entry.content.replace(/\s+/g, ' ').trim();
  return text ? clip(text, 90) : '（内容为空，展开后填写）';
}

function makePromptEntryCard(entry, index, total) {
  const card = makeEl('div');
  card.className = 'oair-prompt-card';
  card.dataset.promptId = entry.id;
  card.classList.toggle('is-disabled', !entry.enabled);

  const head = makeEl('div');
  head.className = 'oair-prompt-head';
  const enable = makeEl('input');
  enable.type = 'checkbox';
  enable.checked = entry.enabled;
  enable.title = '启用这条 Prompt';
  enable.setAttribute('aria-label', '启用这条 Prompt');
  enable.addEventListener('change', () => {
    entry.enabled = enable.checked;
    card.classList.toggle('is-disabled', !entry.enabled);
    savePromptProfiles();
  });
  head.append(enable);

  if (entry.kind === 'context') {
    const name = makeEl('span');
    name.className = 'oair-prompt-name';
    name.textContent = entry.name;
    const tag = makeEl('span');
    tag.className = 'oair-prompt-tag';
    tag.textContent = '内置素材';
    head.append(name, tag);
  } else {
    const name = makeEl('input');
    name.type = 'text';
    name.className = 'oair-prompt-name';
    name.value = entry.name;
    name.placeholder = 'Prompt 名称';
    name.setAttribute('aria-label', 'Prompt 名称');
    name.addEventListener('input', () => {
      entry.name = name.value;
      savePromptProfiles();
    });
    head.append(name);
  }

  const role = makeEl('select');
  role.className = 'oair-prompt-role';
  role.setAttribute('aria-label', '消息角色');
  for (const value of PROMPT_ROLES) {
    const option = makeEl('option');
    option.value = value;
    option.textContent = PROMPT_ROLE_LABELS[value];
    role.append(option);
  }
  role.value = entry.role;
  role.addEventListener('change', () => {
    entry.role = role.value;
    savePromptProfiles();
  });
  head.append(role);

  const body = makeEl('div');
  body.className = 'oair-prompt-body';
  body.hidden = !state.expandedPromptEntries.has(entry.id);
  if (entry.kind === 'context') {
    const hint = makeEl('div');
    hint.className = 'oair-help';
    hint.textContent = `生成时由插件填入：${MATERIAL_SECTION_HINTS[entry.section] ?? ''}`;
    body.append(hint);
  } else {
    const content = makeEl('textarea');
    content.rows = 6;
    content.className = 'oair-prompt-content';
    content.value = entry.content;
    content.placeholder = '支持酒馆宏（{{char}}、{{getvar::名字}} 等），也可以用 {{image2_context}} 插入角色卡、世界书和聊天记录、用 {{image2_reply}} 插入本次回复。';
    content.setAttribute('aria-label', 'Prompt 内容');
    content.addEventListener('input', () => {
      entry.content = content.value;
      savePromptProfiles();
    });
    body.append(content);
  }

  const preview = makeEl('div');
  preview.className = 'oair-prompt-preview';
  preview.textContent = promptEntryPreview(entry);

  const toggle = makePromptAction(body.hidden ? '编辑' : '收起', 'toggle', '展开或收起这条 Prompt 的内容');
  toggle.addEventListener('click', () => {
    body.hidden = !body.hidden;
    toggle.textContent = body.hidden ? '编辑' : '收起';
    if (body.hidden) state.expandedPromptEntries.delete(entry.id);
    else state.expandedPromptEntries.add(entry.id);
  });

  const up = makePromptAction('↑', 'up', '上移', index === 0);
  up.addEventListener('click', () => movePromptEntry(entry.id, -1));
  const down = makePromptAction('↓', 'down', '下移', index === total - 1);
  down.addEventListener('click', () => movePromptEntry(entry.id, 1));
  const remove = makePromptAction('删除', 'delete', '删除这条 Prompt');
  remove.classList.add('danger');
  remove.addEventListener('click', () => deletePromptEntry(entry.id));

  const actions = makeEl('div');
  actions.className = 'oair-prompt-actions';
  actions.append(up, down, toggle, remove);

  card.append(head, actions, preview, body);
  return card;
}

function renderPromptProfilePickers() {
  const profiles = state.settings.summaryProfiles;
  const fill = (selector, profileId, basedOn) => {
    const select = q(selector);
    if (!select) return;
    select.innerHTML = '';
    for (const profile of profiles) {
      const option = makeEl('option');
      option.value = profile.id;
      option.textContent = profile.name || profile.id;
      select.append(option);
    }
    select.value = resolvePromptProfile(profileId, basedOn).id;
  };
  fill('#oair_summary_profile', state.settings.summaryProfileId, 'summary');
  fill('#oair_fallback_profile', state.settings.fallbackProfileId, 'fallback');
  fill('#oair_profile_select', getEditingProfile().id, null);
}

function renderPromptProfileEditor() {
  const profile = getEditingProfile();
  state.editingProfileId = profile.id;
  const nameInput = q('#oair_profile_name');
  if (nameInput) nameInput.value = profile.name;
  const count = q('#oair_profile_entry_count');
  if (count) count.textContent = String(profile.prompts.length);
  const list = q('#oair_profile_prompt_list');
  if (list) {
    list.replaceChildren();
    profile.prompts.forEach((entry, index) => list.append(makePromptEntryCard(entry, index, profile.prompts.length)));
  }
  renderPromptProfilePickers();
}

function savePromptProfiles() {
  saveSettings({ silent: true });
}

function commitPromptProfileChange() {
  savePromptProfiles();
  renderPromptProfileEditor();
  setStatus('提示词预设已保存', 'ok');
}

function createPromptProfile() {
  const source = createDefaultProfileFor('summary');
  const profile = {
    id: newId('profile'),
    name: `新预设 ${state.settings.summaryProfiles.length + 1}`,
    basedOn: 'summary',
    prompts: source.prompts,
  };
  state.settings.summaryProfiles.push(profile);
  state.editingProfileId = profile.id;
  commitPromptProfileChange();
  addLog('info', '已新建提示词预设', { profileId: profile.id, entries: profile.prompts.length });
}

function copyPromptProfile() {
  const current = getEditingProfile();
  const profile = {
    ...structuredClone(current),
    id: newId('profile'),
    name: `${current.name || '预设'} 副本`,
  };
  state.settings.summaryProfiles.push(profile);
  state.editingProfileId = profile.id;
  commitPromptProfileChange();
  addLog('info', '已复制提示词预设', { from: current.id, to: profile.id });
}

function deletePromptProfile() {
  const profile = getEditingProfile();
  if (state.settings.summaryProfiles.length <= 1) {
    setStatus('至少要保留一个预设', 'error');
    return;
  }
  if (!W.confirm(`删除预设「${profile.name || profile.id}」？`)) return;
  state.settings.summaryProfiles = state.settings.summaryProfiles.filter(item => item.id !== profile.id);
  state.settings.summaryProfileId = resolvePromptProfile(state.settings.summaryProfileId, 'summary').id;
  state.settings.fallbackProfileId = resolvePromptProfile(state.settings.fallbackProfileId, 'fallback').id;
  state.editingProfileId = state.settings.summaryProfileId;
  commitPromptProfileChange();
  addLog('info', '已删除提示词预设', { profileId: profile.id, name: profile.name });
}

function resetPromptProfilePrompts() {
  const profile = getEditingProfile();
  const source = createDefaultProfileFor(profile.basedOn);
  if (!source) {
    setStatus('这个预设没有对应的默认条目', 'error');
    return;
  }
  if (!W.confirm(`把预设「${profile.name || profile.id}」的条目恢复为默认？`)) return;
  profile.prompts = source.prompts;
  state.expandedPromptEntries.clear();
  commitPromptProfileChange();
}

function addPromptEntry() {
  const profile = getEditingProfile();
  const entry = {
    id: newId('prompt'),
    kind: 'text',
    name: `Prompt ${profile.prompts.length + 1}`,
    role: 'user',
    enabled: true,
    content: '',
  };
  profile.prompts.push(entry);
  state.expandedPromptEntries.add(entry.id);
  commitPromptProfileChange();
}

function movePromptEntry(entryId, offset) {
  const profile = getEditingProfile();
  const index = profile.prompts.findIndex(entry => entry.id === entryId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= profile.prompts.length) return;
  const [entry] = profile.prompts.splice(index, 1);
  profile.prompts.splice(target, 0, entry);
  commitPromptProfileChange();
}

function deletePromptEntry(entryId) {
  const profile = getEditingProfile();
  const entry = profile.prompts.find(item => item.id === entryId);
  if (!entry) return;
  if (!W.confirm(`删除 Prompt「${entry.name || entry.id}」？`)) return;
  profile.prompts = profile.prompts.filter(item => item.id !== entryId);
  state.expandedPromptEntries.delete(entryId);
  commitPromptProfileChange();
}

function exportPromptProfiles() {
  const payload = {
    type: PROMPT_PROFILE_EXPORT_TYPE,
    version: 1,
    exportedAt: new Date().toISOString(),
    profiles: state.settings.summaryProfiles,
  };
  downloadTextFile('image2-prompt-profiles.json', JSON.stringify(payload, null, 2));
  setStatus(`已导出 ${payload.profiles.length} 个预设`, 'ok');
  addLog('info', '提示词预设已导出', {
    profiles: payload.profiles.map(profile => ({ id: profile.id, name: profile.name, entries: profile.prompts.length })),
  });
}

async function importPromptProfiles(file) {
  if (!file) return;
  const raw = await file.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(`导入文件不是有效 JSON：${error.message}`);
  }
  if (payload?.type !== PROMPT_PROFILE_EXPORT_TYPE || !Array.isArray(payload.profiles)) {
    throw new Error('不是 image2 提示词预设导出文件');
  }

  const existing = state.settings.summaryProfiles;
  const usedIds = new Set(existing.map(profile => profile.id));
  const usedNames = new Set(existing.map(profile => profile.name.toLocaleLowerCase()));
  const imported = [];
  for (const source of payload.profiles) {
    const profile = normalizePromptProfile(source, imported.length);
    if (usedIds.has(profile.id)) profile.id = newId('profile');
    usedIds.add(profile.id);
    let name = profile.name || '导入的预设';
    const baseName = name;
    let suffix = 2;
    while (usedNames.has(name.toLocaleLowerCase())) {
      name = `${baseName} (${suffix})`;
      suffix += 1;
    }
    profile.name = name;
    usedNames.add(name.toLocaleLowerCase());
    imported.push(profile);
  }
  if (!imported.length) throw new Error('导入文件里没有可用的预设');

  state.settings.summaryProfiles = [...existing, ...imported];
  state.editingProfileId = imported[0].id;
  commitPromptProfileChange();
  addLog('info', '提示词预设导入完成', {
    profiles: imported.map(profile => ({ id: profile.id, name: profile.name, entries: profile.prompts.length })),
  });
}

function bindPromptProfileEditor() {
  const editor = q('#oair_profile_editor');
  if (!editor) return;

  bindDom('#oair_btn_edit_profiles', 'click', () => {
    editor.hidden = !editor.hidden;
    if (!editor.hidden) renderPromptProfileEditor();
    setStatus(editor.hidden ? '已收起预设编辑器' : '正在编辑提示词预设', 'info');
  });
  bindDom('#oair_profile_select', 'change', event => {
    state.editingProfileId = event.target.value;
    renderPromptProfileEditor();
  });
  bindDom('#oair_profile_name', 'input', event => {
    getEditingProfile().name = event.target.value;
    savePromptProfiles();
    renderPromptProfilePickers();
  });
  bindDom('#oair_profile_new', 'click', createPromptProfile);
  bindDom('#oair_profile_copy', 'click', copyPromptProfile);
  bindDom('#oair_profile_delete', 'click', deletePromptProfile);
  bindDom('#oair_profile_reset_prompts', 'click', resetPromptProfilePrompts);
  bindDom('#oair_profile_add_prompt', 'click', addPromptEntry);
  bindDom('#oair_profile_export', 'click', exportPromptProfiles);
  bindDom('#oair_profile_import', 'click', () => q('#oair_profile_import_file')?.click());
  bindDom('#oair_profile_import_file', 'change', event => {
    const file = event.target?.files?.[0];
    importPromptProfiles(file).catch(error => {
      setStatus(`导入预设失败：${error.message}`, 'error');
      addLog('error', '提示词预设导入失败', { fileName: file?.name, error: error.message });
    }).finally(() => {
      if (event.target) event.target.value = '';
    });
  });
}

const SKIP_REASON_LABELS = { disabled: '已关闭', empty: '没有内容' };

function previewFloorLabel(floor) {
  const name = floor.message.name || floor.message.role;
  const suffix = floor.usedDefault ? '，楼层留空时取最后一条 assistant' : '';
  return `第 ${floor.messageId} 楼 ${name}${suffix}`;
}

function renderProfilePreview(container, { profile, floor, rendered, skipped }) {
  container.hidden = false;
  container.replaceChildren();

  const head = makeEl('div');
  head.className = 'oair-preview-head';
  const title = makeEl('span');
  title.textContent = `预设预览 · ${profile.name}`;
  const badge = makeEl('span');
  badge.className = 'oair-badge';
  badge.textContent = `${rendered.length} 条消息`;
  const hide = makeEl('button');
  hide.type = 'button';
  hide.className = 'oair-btn secondary oair-preview-hide';
  hide.textContent = '收起';
  hide.addEventListener('click', () => {
    container.hidden = true;
  });
  head.append(title, badge, hide);
  container.append(head);

  const meta = makeEl('div');
  meta.className = 'oair-help';
  meta.textContent = `${previewFloorLabel(floor)}；宏已按当前聊天替换，{{random}} 这类宏每次取值可能不同。预览只组装消息，不调用 AI，也不改动聊天。`;
  container.append(meta);

  if (!rendered.length) {
    const empty = makeEl('div');
    empty.className = 'oair-preview-empty';
    empty.textContent = '当前预设没有可发送的 Prompt，打开条目或填写内容后再看。';
    container.append(empty);
  }

  const list = makeEl('div');
  list.className = 'oair-preview-messages';
  for (const item of rendered) {
    const box = makeEl('div');
    box.className = 'oair-preview-message';
    box.dataset.role = item.role;
    const role = makeEl('div');
    role.className = 'oair-preview-role';
    role.textContent = `${PROMPT_ROLE_LABELS[item.role] ?? item.role} · ${item.source} · ${item.content.length} 字`;
    const pre = makeEl('pre');
    pre.textContent = item.content;
    box.append(role, pre);
    list.append(box);
  }
  container.append(list);

  if (skipped.length) {
    const note = makeEl('div');
    note.className = 'oair-help';
    note.textContent = `未发送：${skipped.map(item => `${item.name}（${SKIP_REASON_LABELS[item.reason] ?? item.reason}）`).join('、')}`;
    container.append(note);
  }
}

async function previewCurrentProfile() {
  const container = q('#oair_profile_preview');
  if (!container) return;
  saveSettings({ silent: true });
  const profile = getSummaryProfile();
  try {
    const floor = readTestFloor();
    const sourceMessage = String(floor.message.message || '').replace(/<pic[^>]*>/g, '').trim();
    const texts = await collectContextSections(profileMaterialSections(profile), { historyEndId: floor.messageId });
    const { messages, sources, skipped } = buildProfileMessages(profile, { sourceMessage, texts });
    const context = SillyTavern.getContext();
    const rendered = messages.map((message, index) => ({
      role: message.role,
      source: sources[index],
      content: context.substituteParams(message.content),
    }));
    renderProfilePreview(container, { profile, floor, rendered, skipped });
    setStatus(`已预览预设「${profile.name}」：${rendered.length} 条消息`, 'ok');
    addLog('info', '预设预览完成', {
      profile: { id: profile.id, name: profile.name },
      floor: { messageId: floor.messageId, usedDefaultFloor: floor.usedDefault },
      messages: rendered.map(item => ({ role: item.role, source: item.source, chars: item.content.length })),
      skipped,
    });
  } catch (error) {
    container.hidden = false;
    container.replaceChildren();
    const box = makeEl('div');
    box.className = 'oair-preview-error';
    box.textContent = `预览失败：${error.message}`;
    container.append(box);
    setStatus(`预览失败：${error.message}`, 'error');
    addLog('error', '预设预览失败', { error: error.message, stack: error.stack });
  }
}

function bindProfilePreview() {
  bindDom('#oair_btn_preview_profile', 'click', () => runWithButtonBusy('#oair_btn_preview_profile', '组装中...', previewCurrentProfile));
}

function makeReferenceButton(text, className = 'secondary') {
  const button = makeEl('button');
  button.type = 'button';
  button.className = `oair-btn ${className}`.trim();
  button.textContent = text;
  return button;
}

function renderReferenceCharacters() {
  const list = q('#oair_reference_character_list');
  if (!list) return;
  list.innerHTML = '';
  const characters = getReferenceCharacters();
  const count = q('#oair_reference_character_count');
  if (count) count.textContent = String(characters.length);
  if (!characters.length) {
    const empty = makeEl('div');
    empty.className = 'oair-reference-empty';
    empty.textContent = '还没有角色参考区。先填写角色名并新建。';
    list.appendChild(empty);
    return;
  }

  for (const character of characters) {
    const images = referenceImagesForCharacter(character.id);
    const card = makeEl('section');
    card.className = 'oair-reference-card';
    card.dataset.characterId = character.id;

    const head = makeEl('div');
    head.className = 'oair-reference-card-head';
    const enabled = makeEl('input');
    enabled.type = 'checkbox';
    enabled.checked = character.enabled;
    enabled.title = '启用这个角色的参考图匹配';
    enabled.addEventListener('change', () => updateReferenceCharacter(character.id, { enabled: enabled.checked }));
    const title = makeEl('strong');
    title.textContent = character.name;
    const badge = makeEl('span');
    badge.className = 'oair-badge';
    badge.textContent = `${images.length} 图`;
    head.append(enabled, title, badge);

    const fields = makeEl('div');
    fields.className = 'oair-grid-2';
    const nameField = makeEl('label');
    nameField.className = 'oair-field';
    nameField.textContent = '角色名';
    const nameInput = makeEl('input');
    nameInput.value = character.name;
    nameInput.addEventListener('change', () => {
      const value = nameInput.value.trim();
      if (value) updateReferenceCharacter(character.id, { name: value });
      renderReferenceCharacters();
    });
    nameField.appendChild(nameInput);
    const aliasField = makeEl('label');
    aliasField.className = 'oair-field';
    aliasField.textContent = '别名（逗号分隔）';
    const aliasInput = makeEl('input');
    aliasInput.value = character.aliases.join(', ');
    aliasInput.addEventListener('change', () => updateReferenceCharacter(character.id, { aliases: aliasInput.value }));
    aliasField.appendChild(aliasInput);
    fields.append(nameField, aliasField);

    const notesField = makeEl('label');
    notesField.className = 'oair-field';
    notesField.textContent = '角色备注';
    const notesInput = makeEl('textarea');
    notesInput.rows = 2;
    notesInput.value = character.notes;
    notesInput.placeholder = '可记录外观识别点、服装版本或参考图用途。';
    notesInput.addEventListener('change', () => updateReferenceCharacter(character.id, { notes: notesInput.value }));
    notesField.appendChild(notesInput);

    const actions = makeEl('div');
    actions.className = 'oair-btn-row';
    const upload = makeReferenceButton('上传参考图', '');
    const fileInput = makeEl('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.hidden = true;
    upload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      handleReferenceFiles(character.id, fileInput.files).catch(error => {
        setStatus(`参考图导入失败：${error.message}`, 'error');
        addLog('error', '参考图导入失败', { character: character.name, error: error.message });
      });
    });
    const exportButton = makeReferenceButton('导出角色');
    exportButton.addEventListener('click', () => exportReferenceLibrary(character.id));
    const deleteButton = makeReferenceButton('删除角色', 'danger');
    deleteButton.addEventListener('click', () => removeReferenceCharacter(character.id).catch(error => {
      setStatus(`删除失败：${error.message}`, 'error');
    }));
    actions.append(upload, exportButton, deleteButton, fileInput);

    const imageGrid = makeEl('div');
    imageGrid.className = 'oair-reference-image-grid';
    for (const imageRecord of images) {
      const item = makeEl('div');
      item.className = 'oair-reference-image';
      const image = makeEl('img');
      image.src = imageRecord.dataUrl;
      image.alt = `${character.name} reference`;
      image.loading = 'lazy';
      bindImageActions(image, imageRecord.dataUrl, `${character.name} 参考图`);
      const meta = makeEl('div');
      meta.className = 'oair-reference-image-meta';
      meta.textContent = `${imageRecord.fileName || '参考图'}\n${imageRecord.width || '?'}x${imageRecord.height || '?'} · ${Math.max(1, Math.round((imageRecord.size || 0) / 1024))} KB`;
      const remove = makeReferenceButton('删除图片', 'danger');
      remove.addEventListener('click', () => removeReferenceImage(imageRecord.id).catch(error => {
        setStatus(`删除图片失败：${error.message}`, 'error');
      }));
      item.append(image, meta, remove);
      imageGrid.appendChild(item);
    }

    card.append(head, fields, notesField, actions, imageGrid);
    list.appendChild(card);
  }
}

function renderReferenceMatchPreview() {
  const output = q('#oair_reference_match_preview');
  if (!output) return;
  const prompt = q('#oair_test_prompt')?.value || '';
  if (!prompt.trim()) {
    output.textContent = '在“测试与图库”填写提示词后，这里会显示角色匹配结果。';
    return;
  }
  const context = resolveReferenceContext(prompt);
  output.textContent = context.images.length
    ? `将匹配：${context.characters.map(item => `${item.name}（${item.imageCount} 图）`).join('、')}`
    : '没有匹配到同时启用且已上传图片的角色，将使用普通文生图。';
}

function switchPanelTab(tabName) {
  state.activeTab = tabName;
  if (!generatedGallery) generatedGallery = createGallery(state.panel, { openLightbox: openImageLightbox });
  state.panel.dataset.oairTab = tabName;
  if (tabName === 'gallery') generatedGallery.load().catch(error => setStatus(error.message, 'error'));
  qa('[data-oair-tab]').forEach(button => {
    const active = button.dataset.oairTab === state.activeTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  qa('[data-oair-tab-pane]').forEach(pane => {
    pane.hidden = pane.dataset.oairTabPane !== state.activeTab;
  });
  if (state.activeTab === 'references') {
    renderReferenceCharacters();
    renderReferenceMatchPreview();
  }
}

function setPanelVisible(visible) {
  if (!state.panel) return;
  state.panel.hidden = !visible;
  if (visible) syncPanelLayout();
}

// 自定义酒馆可能换掉了栏位 id，按常见顺序取第一个真正占位的元素。
const TAVERN_BOTTOM_BAR_IDS = ['send-form', 'send_form', 'form_sheld'];
const PANEL_MIN_WIDTH = 320;
const PANEL_MIN_HEIGHT = 240;

// 与酒馆自身的移动端判断保持一致；拿不到 isMobile 时退回窗口宽度。
function useFullscreenPanelLayout() {
  const win = state.uiWindow || W;
  let stMobile = null;
  try {
    const isMobile = SillyTavern.getContext().isMobile;
    if (typeof isMobile === 'function') stMobile = Boolean(isMobile());
  } catch {
    stMobile = null;
  }
  const narrow = win.matchMedia?.('(max-width: 1000px)').matches ?? win.innerWidth <= 1000;
  return stMobile === null ? narrow : stMobile || narrow;
}

function measureTavernBarSpace() {
  const doc = uiDoc();
  const win = state.uiWindow || W;
  const topBar = doc.getElementById('top-bar');
  const top = topBar ? Math.max(0, topBar.getBoundingClientRect().bottom) : 0;
  let bottom = 0;
  for (const id of TAVERN_BOTTOM_BAR_IDS) {
    const bar = doc.getElementById(id);
    if (!bar) continue;
    const rect = bar.getBoundingClientRect();
    if (rect.height <= 0) continue;
    bottom = Math.max(0, win.innerHeight - rect.top);
    break;
  }
  return { top, bottom };
}

function clampPanelPosition(position) {
  const win = state.uiWindow || W;
  const rect = state.panel?.getBoundingClientRect();
  const width = rect?.width ?? 0;
  const height = rect?.height ?? 0;
  // 面板隐藏时没有布局盒，此时保留原坐标，等显示后再校正。
  if (!width || !height) return position;
  return {
    left: Math.min(Math.max(position.left, 0), Math.max(0, win.innerWidth - width)),
    top: Math.min(Math.max(position.top, 0), Math.max(0, win.innerHeight - height)),
  };
}

function clampPanelSize(size, bounds) {
  const win = state.uiWindow || W;
  // bounds 用来限制“向右/向下最多能长到哪”，避免缩放结束后面板被位置夹取推回左边。
  const maxWidth = bounds?.width ?? win.innerWidth;
  const maxHeight = bounds?.height ?? win.innerHeight;
  return {
    width: Math.min(Math.max(size.width, PANEL_MIN_WIDTH), Math.max(PANEL_MIN_WIDTH, maxWidth)),
    height: Math.min(Math.max(size.height, PANEL_MIN_HEIGHT), Math.max(PANEL_MIN_HEIGHT, maxHeight)),
  };
}

function applyPanelSize() {
  const panel = state.panel;
  if (!panel) return;
  if (!state.panelSize) {
    panel.style.width = '';
    panel.style.height = '';
    return;
  }
  // 只约束实际写入的尺寸，视口变大后仍回到用户设定的值。
  const size = clampPanelSize(state.panelSize);
  panel.style.width = `${size.width}px`;
  panel.style.height = `${size.height}px`;
}

function syncPanelLayout() {
  const panel = state.panel;
  if (!panel) return;
  const win = state.uiWindow || W;
  if (useFullscreenPanelLayout()) {
    const { top, bottom } = measureTavernBarSpace();
    panel.classList.add('oair-panel-fullscreen');
    panel.classList.remove('oair-panel-moved');
    panel.style.left = '';
    panel.style.top = top > 0 ? `${top}px` : '';
    panel.style.bottom = bottom > 0 ? `${bottom}px` : '';
    // 页面根元素带 transform 时，fixed 元素靠 top/bottom 拉伸会失效，高度按测到的栏位直接算；
    // 两条栏位都没测到时清掉高度，交回 CSS 的 env(safe-area-inset-*) 定位。
    panel.style.height = top > 0 || bottom > 0
      ? `${Math.max(PANEL_MIN_HEIGHT, win.innerHeight - top - bottom)}px`
      : '';
    panel.style.width = '';
    return;
  }
  panel.classList.remove('oair-panel-fullscreen');
  panel.style.bottom = '';
  applyPanelSize();
  if (!state.panelPosition) {
    panel.classList.remove('oair-panel-moved');
    panel.style.left = '';
    panel.style.top = '';
    return;
  }
  // 视口变化时只约束实际写入的坐标，保留用户拖拽出来的值。
  const position = clampPanelPosition(state.panelPosition);
  panel.classList.add('oair-panel-moved');
  panel.style.left = `${position.left}px`;
  panel.style.top = `${position.top}px`;
}

function readStoredPanelPosition() {
  try {
    const saved = JSON.parse((state.uiWindow || W).localStorage.getItem(PANEL_POSITION_KEY) || 'null');
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      return { left: saved.left, top: saved.top };
    }
  } catch {
    // 坐标记录损坏时忽略，回到居中布局。
  }
  return null;
}

function readStoredPanelSize() {
  try {
    const saved = JSON.parse((state.uiWindow || W).localStorage.getItem(PANEL_SIZE_KEY) || 'null');
    if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
      return { width: saved.width, height: saved.height };
    }
  } catch {
    // 尺寸记录损坏时忽略，使用样式里的默认尺寸。
  }
  return null;
}

function persistPanelLayout() {
  const win = state.uiWindow || W;
  try {
    win.localStorage.setItem(PANEL_POSITION_KEY, JSON.stringify(state.panelPosition));
    win.localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(state.panelSize));
  } catch {
    // 存储不可用时仅本次会话内保持布局。
  }
}

function enablePanelResize() {
  const panel = state.panel;
  const win = state.uiWindow || W;
  let resize = null;

  const resizePanel = (width, height) => {
    const rect = panel.getBoundingClientRect();
    state.panelSize = clampPanelSize({ width, height }, {
      width: win.innerWidth - rect.left,
      height: win.innerHeight - rect.top,
    });
    panel.style.width = `${state.panelSize.width}px`;
    panel.style.height = `${state.panelSize.height}px`;
  };
  // 居中布局下缩放会让左右两边一起动，这里先把左上角定住。
  const pinTopLeft = () => {
    const rect = panel.getBoundingClientRect();
    state.panelPosition = clampPanelPosition({ left: rect.left, top: rect.top });
    panel.classList.add('oair-panel-moved');
    panel.style.left = `${state.panelPosition.left}px`;
    panel.style.top = `${state.panelPosition.top}px`;
    panel.style.bottom = '';
  };

  for (const handle of panel.querySelectorAll('.oair-resize')) {
    const axis = handle.dataset.resize;
    const onPointerDown = event => {
      if (event.button !== 0 || event.isPrimary === false || useFullscreenPanelLayout()) return;
      const rect = panel.getBoundingClientRect();
      resize = { axis, width: rect.width, height: rect.height, x: event.clientX, y: event.clientY };
      pinTopLeft();
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    };
    const onPointerMove = event => {
      if (!resize) return;
      resizePanel(
        resize.axis.includes('e') ? resize.width + event.clientX - resize.x : resize.width,
        resize.axis.includes('s') ? resize.height + event.clientY - resize.y : resize.height,
      );
    };
    const onPointerUp = () => {
      if (!resize) return;
      resize = null;
      persistPanelLayout();
      syncPanelLayout();
    };

    handle.addEventListener('pointerdown', onPointerDown);
    win.addEventListener('pointermove', onPointerMove);
    win.addEventListener('pointerup', onPointerUp);
    win.addEventListener('pointercancel', onPointerUp);
    state.disposers.push(() => {
      handle.removeEventListener('pointerdown', onPointerDown);
      win.removeEventListener('pointermove', onPointerMove);
      win.removeEventListener('pointerup', onPointerUp);
      win.removeEventListener('pointercancel', onPointerUp);
    });
  }
}

function enablePanelDrag() {
  const panel = state.panel;
  const win = state.uiWindow || W;
  const handle = panel?.querySelector('.oair-head');
  if (!handle) return;
  let drag = null;

  const movePanel = (left, top) => {
    state.panelPosition = clampPanelPosition({ left, top });
    panel.classList.add('oair-panel-moved');
    panel.style.left = `${state.panelPosition.left}px`;
    panel.style.top = `${state.panelPosition.top}px`;
    panel.style.bottom = '';
  };
  const onPointerDown = event => {
    if (event.button !== 0 || event.isPrimary === false || useFullscreenPanelLayout()) return;
    if (event.target.closest('button, input, label, select, textarea, a')) return;
    const rect = panel.getBoundingClientRect();
    drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    movePanel(rect.left, rect.top);
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = event => {
    if (!drag) return;
    movePanel(event.clientX - drag.x, event.clientY - drag.y);
  };
  const onPointerUp = () => {
    if (!drag) return;
    drag = null;
    persistPanelLayout();
  };

  handle.addEventListener('pointerdown', onPointerDown);
  win.addEventListener('pointermove', onPointerMove);
  win.addEventListener('pointerup', onPointerUp);
  win.addEventListener('pointercancel', onPointerUp);
  state.disposers.push(() => {
    handle.removeEventListener('pointerdown', onPointerDown);
    win.removeEventListener('pointermove', onPointerMove);
    win.removeEventListener('pointerup', onPointerUp);
    win.removeEventListener('pointercancel', onPointerUp);
  });
}

function bindPanelLayout() {
  const win = state.uiWindow || W;
  let queued = false;
  const queueSync = () => {
    if (queued) return;
    queued = true;
    (win.requestAnimationFrame || (callback => callback()))(() => {
      queued = false;
      syncPanelLayout();
    });
  };
  syncPanelLayout();
  win.addEventListener('resize', queueSync);
  win.addEventListener('orientationchange', queueSync);
  win.visualViewport?.addEventListener('resize', queueSync);
  win.visualViewport?.addEventListener('scroll', queueSync);
  state.disposers.push(() => {
    win.removeEventListener('resize', queueSync);
    win.removeEventListener('orientationchange', queueSync);
    win.visualViewport?.removeEventListener('resize', queueSync);
    win.visualViewport?.removeEventListener('scroll', queueSync);
  });
}

function bindDom(selector, event, handler) {
  const el = q(selector);
  if (!el) return;
  el.addEventListener(event, handler);
  state.disposers.push(() => el.removeEventListener(event, handler));
}

async function runWithButtonBusy(selector, busyText, handler) {
  const button = q(selector);
  if (button && state.busyButtons.has(selector)) return;
  const originalText = button?.textContent;
  if (button) {
    state.busyButtons.add(selector);
    button.disabled = true;
    button.textContent = busyText;
  }
  try {
    await handler();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
      state.busyButtons.delete(selector);
    }
  }
}

function makeUi() {
  const doc = initUiTarget();
  const oldPanel = q('#oair_panel');
  oldPanel?.remove();

  const panel = makeEl('div');
  panel.id = 'oair_panel';
  panel.hidden = true;
  panel.innerHTML = panelHtml;
  const collapsedSections = JSON.parse(state.uiWindow.localStorage.getItem(SECTION_STATE_KEY) || '{}');
  panel.querySelectorAll('[data-oair-section]').forEach(section => {
    const key = section.dataset.oairSection;
    const details = doc.createElement('details');
    details.className = section.className;
    details.dataset.oairSection = key;
    details.open = collapsedSections[key] !== true;
    const title = section.querySelector('.oair-section-title');
    const summary = doc.createElement('summary');
    summary.className = title.className;
    summary.append(...title.childNodes);
    title.remove();
    const body = doc.createElement('div');
    body.className = 'oair-section-body';
    body.append(...section.childNodes);
    details.append(summary, body);
    section.replaceWith(details);
    const onToggle = () => {
      collapsedSections[key] = !details.open;
      state.uiWindow.localStorage.setItem(SECTION_STATE_KEY, JSON.stringify(collapsedSections));
    };
    details.addEventListener('toggle', onToggle);
    state.disposers.push(() => details.removeEventListener('toggle', onToggle));
  });
  doc.body.appendChild(panel);
  state.panel = panel;
  state.panelPosition = readStoredPanelPosition();
  state.panelSize = readStoredPanelSize();
  enablePanelDrag();
  enablePanelResize();
  bindPanelLayout();
  generatedGallery = createGallery(panel, { openLightbox: openImageLightbox });

  state.entries = createEntries({
    doc,
    onToggle: () => setPanelVisible(state.panel.hidden),
    onChange: entryPoint => {
      state.settings.entryPoint = entryPoint;
      saveSettings({ silent: true });
      state.entries.apply(entryPoint);
      addLog('info', '生图入口已切换', { entryPoint });
    },
  });
  state.entries.apply(state.settings.entryPoint);

  renderPromptProfileEditor();
  writeSettingsToUi();
  resetSteps();
  renderLogs();
  renderReferenceCharacters();
  renderReferenceMatchPreview();
  bindPromptProfileEditor();
  bindProfilePreview();

  state.disposers.push(() => panel.remove());
  const onKeyDown = event => {
    if (event.key === 'Escape') closeImageLightbox();
  };
  doc.addEventListener('keydown', onKeyDown);
  state.disposers.push(() => doc.removeEventListener('keydown', onKeyDown));

  bindDom('#oair_btn_close', 'click', () => setPanelVisible(false));
  bindDom('#oair_btn_save', 'click', saveSettings);
  qa('[data-oair-tab]').forEach(button => {
    const handler = () => switchPanelTab(button.dataset.oairTab);
    button.addEventListener('click', handler);
    state.disposers.push(() => button.removeEventListener('click', handler));
  });
  bindDom('#oair_test_prompt', 'input', renderReferenceMatchPreview);
  bindDom('#oair_btn_save_reference_settings', 'click', saveSettings);
  bindDom('#oair_btn_reset_reference_prompt', 'click', () => {
    state.settings.referencePromptTemplate = DEFAULT_REFERENCE_PROMPT_TEMPLATE;
    writeSettingsToUi();
    saveSettings();
    setStatus('默认图生图提示词模板已恢复', 'ok');
  });
  bindDom('#oair_btn_add_reference_character', 'click', createReferenceCharacter);
  bindDom('#oair_reference_new_name', 'keydown', event => {
    if (event.key === 'Enter') createReferenceCharacter();
  });
  bindDom('#oair_btn_export_reference_library', 'click', () => exportReferenceLibrary());
  bindDom('#oair_btn_import_reference_library', 'click', () => q('#oair_reference_import_file')?.click());
  bindDom('#oair_reference_import_file', 'change', event => {
    const file = event.target?.files?.[0];
    importReferenceLibrary(file).catch(error => {
      setStatus(`导入图库失败：${error.message}`, 'error');
      addLog('error', '参考图库导入失败', { fileName: file?.name, error: error.message });
    }).finally(() => {
      if (event.target) event.target.value = '';
    });
  });
  bindDom('#oair_btn_reset_main_prompt', 'click', () => {
    state.settings.mainPrompt = DEFAULT_MAIN_PROMPT;
    writeSettingsToUi();
    saveSettings();
    setStatus('默认注入规则已恢复', 'ok');
  });
  bindDom('#oair_btn_test', 'click', () => runWithButtonBusy('#oair_btn_test', '生成中...', runImageTest));
  bindDom('#oair_btn_context_prompt', 'click', () => runWithButtonBusy('#oair_btn_context_prompt', '整理中...', runContextPromptOnly));
  bindDom('#oair_btn_extract_prompt', 'click', () => runWithButtonBusy('#oair_btn_extract_prompt', '提取中...', runExtractPromptFromMessage));
  bindDom('#oair_gallery_refresh', 'click', event => {
    event.preventDefault();
    event.stopPropagation();
    generatedGallery.load().catch(error => setStatus(error.message, 'error'));
  });
  bindDom('#oair_btn_clear_log', 'click', () => {
    state.logs = [];
    renderLogs();
    setStatus('日志已清空', 'ok');
  });
  bindDom('#oair_btn_copy_log', 'click', async () => {
    const text = state.logs.map(item => `${item.time} [${item.level}] ${item.title}\n${safeStringify(item.payload)}`).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setStatus('日志已复制', 'ok');
    } catch (error) {
      setStatus(`复制日志失败：${error.message}`, 'error');
    }
  });
}

function bindEvent(eventName, handler) {
  const context = SillyTavern.getContext();
  context.eventSource.on(eventName, handler);
  state.disposers.push(() => context.eventSource.removeListener(eventName, handler));
}

export async function init() {
  window[NS]?.destroy('reload');
  const response = await fetch(new URL('./panel.html', import.meta.url), { cache: 'no-store' });
  if (!response.ok) throw new Error(`面板加载失败：${response.status}`);
  panelHtml = await response.text();
  loadSettings();
  makeUi();
  const context = SillyTavern.getContext();
  const tavernEvents = context.eventTypes;
  bindEvent(tavernEvents.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
  bindEvent(tavernEvents.MESSAGE_RECEIVED, onMessageReceived);
  const clearInjection = () => tavern.uninjectPrompts([INJECT_ID]);
  bindEvent(tavernEvents.GENERATION_ENDED, clearInjection);
  bindEvent(tavernEvents.GENERATION_STOPPED, clearInjection);
  bindEvent(tavernEvents.CHAT_CHANGED, clearInjection);
  const onPageHide = () => destroy('pagehide');
  window.addEventListener('pagehide', onPageHide, { once: true });
  state.disposers.push(() => window.removeEventListener('pagehide', onPageHide));
  W[NS] = { state, destroy, open: () => setPanelVisible(true), close: () => setPanelVisible(false), runImageTest, runExtractPromptFromMessage, generatePromptFromContext, processPromptToImage, matchReferenceCharacters, exportReferenceLibrary };

  await refreshReferenceImages();

  setStatus('就绪', 'info');
  addLog('info', 'image2 角色参考图增强版已启动', {
    integration: 'SillyTavern native extension',
    settings: state.settings,
    referenceCharacters: getReferenceCharacters().map(character => ({
      id: character.id,
      name: character.name,
      aliases: character.aliases,
      enabled: character.enabled,
      imageCount: referenceImagesForCharacter(character.id).length,
    })),
  });
}

function destroy(reason = 'manual') {
  try {
    tavern.uninjectPrompts([INJECT_ID]);
  } catch {
    // Ignore cleanup errors.
  }
  const URLApi = state.uiWindow?.URL || W.URL || URL;
  for (const objectUrl of state.objectUrls) {
    try {
      URLApi.revokeObjectURL(objectUrl);
    } catch {
      // Ignore URL cleanup errors.
    }
  }
  state.objectUrls.clear();
  state.referenceDb?.close();
  state.referenceDb = null;
  state.entries?.destroy();
  state.entries = null;
  qa('.oair-chat-image').forEach(el => el.remove());
  q('#oair_lightbox')?.remove();
  while (state.disposers.length) {
    const dispose = state.disposers.pop();
    try {
      dispose();
    } catch {
      // Ignore cleanup errors.
    }
  }
  q('#oair_panel')?.remove();
  console.log(`[${NS}] destroyed: ${reason}`);
}

