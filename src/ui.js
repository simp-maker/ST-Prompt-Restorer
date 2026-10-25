// Main window (opened as a SillyTavern popup).

import { addRecord, clearChunkCache, deleteChat, deleteRecord, hasHash, listChats } from './db.js';
import { CHROMIUM_IDB_VALUE_LIMIT, getStChat, listStKeys, scanStChats } from './stdb.js';
import { clearStCache, countEntries, createNavigator, getEntriesPage, getLatestEntry } from './entries.js';
import {
    DETAILED_FIELDS,
    TYPE_LABELS,
    formatField,
    formatReadable,
    formatSeparator,
    generateJsonl,
    processValue,
    roleLabel,
} from './format.js';
import { openViewer } from './viewer.js';
import { pickDetails } from './capture.js';
import { renderWiPanel } from './wipanel.js';
import {
    contentToText,
    copyText,
    downloadText,
    el,
    estimateBytes,
    formatBytes,
    formatDate,
    formatShortDate,
    hashPrompt,
    icon,
    iconButton,
    isNotEmpty,
    safeFileName,
    stripDataUris,
} from './utils.js';

const METADATA_KEY = 'sillyTavernBackupTool_metadata_v4';

const SOURCES = [
    { id: 'ext', label: '확장 저장소', icon: 'fa-box-archive', note: '이 확장이 보낼 때마다 저장한 기록입니다. 스와이프·재생성도 따로 남고, 같은 내용은 한 번만 저장됩니다.' },
    { id: 'st', label: 'ST 기본 저장소', icon: 'fa-database', note: 'SillyTavern이 브라우저에 저장한 기록입니다. 메시지마다 마지막 프롬프트 하나만 남아 있고, 여기서는 읽기만 합니다.' },
    { id: 'wi', label: '월드인포 백업', icon: 'fa-book-atlas', note: '월드인포 북이나 엔트리를 지우기 직전의 내용입니다. 보거나 다시 넣을 수 있습니다.' },
];

const MODES = [
    { id: 'rawPrompt', label: '마지막 프롬프트', icon: 'fa-message' },
    { id: 'selected', label: '세부 정보', icon: 'fa-list-ul' },
    { id: 'all', label: '전체 기록', icon: 'fa-timeline' },
];

const state = {
    source: 'ext',
    items: [],
    selectedKeys: [],
    hideEmpty: true,
    favoritesOnly: false,
    mode: null,
    field: null,
    page: 0,
    loaded: false,
    loadToken: 0,
    scanToken: 0,
    scanning: false,
    latestCache: new Map(),
    dirty: false,
};

let root = null;
let popupOpen = false;
const DOM = {};
let getSettings = () => ({});
let saveSettings = () => { };

export function initUi(opts) {
    getSettings = opts.getSettings;
    saveSettings = opts.saveSettings;
}

// ---------------------------------------------------------------- small helpers

function getMetadata() {
    try { return JSON.parse(localStorage.getItem(METADATA_KEY)) || {}; } catch { return {}; }
}
function saveMetadata(m) {
    try { localStorage.setItem(METADATA_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

function setStatus(message, tone = '') {
    if (!DOM.status) return;
    DOM.status.textContent = message || '';
    DOM.status.dataset.tone = tone;
}

function displayName(item) {
    return item?.metadata?.displayName || item?.key || '';
}

function findItem(key) {
    return state.items.find(i => i.key === key);
}

function chip(text, opts = {}) {
    return el('span', { class: `pr-chip ${opts.cls || ''}`.trim(), title: opts.title || null }, opts.icon ? icon(opts.icon) : null, text);
}

function btn(label, onClick, { iconName, cls = '', title } = {}) {
    const b = el('button', { class: `pr-btn ${cls}`.trim(), type: 'button', title: title || null }, iconName ? icon(iconName) : null, label ? el('span', {}, label) : null);
    if (onClick) b.addEventListener('click', onClick);
    return b;
}

function segmented(items, current, onPick, cls = '') {
    const wrap = el('div', { class: `pr-seg ${cls}`.trim(), role: 'tablist' });
    for (const it of items) {
        const b = el('button', { class: 'pr-seg-btn', type: 'button', role: 'tab', 'aria-selected': String(it.id === current), dataset: { id: it.id } },
            it.icon ? icon(it.icon) : null, el('span', {}, it.label));
        b.addEventListener('click', () => onPick(it.id));
        wrap.append(b);
    }
    return wrap;
}

function setSegmented(wrap, current) {
    wrap?.querySelectorAll('.pr-seg-btn').forEach(b => b.setAttribute('aria-selected', String(b.dataset.id === current)));
}

function toggle(label, checked, onChange, title) {
    const input = el('input', { type: 'checkbox' });
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'pr-toggle', title: title || null }, input, el('span', { class: 'pr-toggle-ui' }), el('span', {}, label));
}

function hueOf(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h % 360;
}

function avatarFor(item) {
    const ctx = SillyTavern.getContext();
    let file = item.avatar || null;
    const name = item.charName || String(item.key).split(' - ')[0];
    if (!file && name && Array.isArray(ctx.characters)) {
        file = ctx.characters.find(c => c?.name === name)?.avatar || null;
    }
    const box = el('span', { class: 'pr-ava', style: { '--ava-h': String(hueOf(name || '?')) } }, (name || '?').trim().slice(0, 1).toUpperCase());
    if (file) {
        const img = el('img', { alt: '', loading: 'lazy', src: `/thumbnail?type=avatar&file=${encodeURIComponent(file)}` });
        img.addEventListener('error', () => img.remove());
        box.append(img);
    }
    return box;
}

function applyTheme() {
    if (!root) return;
    const theme = getSettings().theme || 'st';
    root.classList.remove('pr-theme-st', 'pr-theme-dark', 'pr-theme-light');
    root.classList.add(`pr-theme-${theme}`);
    if (DOM.themeBtn) {
        DOM.themeBtn.replaceChildren(icon(theme === 'light' ? 'fa-sun' : theme === 'dark' ? 'fa-moon' : 'fa-palette'));
        DOM.themeBtn.title = `테마: ${theme === 'st' ? 'ST 테마 따르기' : theme === 'dark' ? '다크' : '라이트'} (눌러서 바꾸기)`;
    }
}

export function refreshTheme() {
    applyTheme();
}

async function latestEntry(key) {
    const cacheKey = `${state.source}:${key}`;
    if (state.latestCache.has(cacheKey)) return state.latestCache.get(cacheKey);
    const entry = await getLatestEntry(state.source, key);
    state.latestCache.set(cacheKey, entry);
    return entry;
}

async function selectedLatest() {
    const out = [];
    for (const key of state.selectedKeys) {
        const item = findItem(key);
        if (item) out.push({ item, entry: await latestEntry(key) });
    }
    return out;
}

function previewOpts(field) {
    const isRaw = state.mode === 'rawPrompt' || field === 'rawPrompt';
    const s = getSettings();
    return { readingMode: s.readingMode !== false && isRaw, spacing: s.spacingMode !== false, keepEscapes: !!s.keepEscapes };
}

// ---------------------------------------------------------------- build

function buildRoot() {
    root = el('div', { class: 'pr-root pr-main' });

    // header
    DOM.themeBtn = iconButton('fa-palette', '테마', () => {
        const order = ['st', 'dark', 'light'];
        const cur = getSettings().theme || 'st';
        saveSettings({ theme: order[(order.indexOf(cur) + 1) % order.length] });
        applyTheme();
    });
    DOM.reloadBtn = iconButton('fa-rotate-right', '목록 다시 불러오기', () => reloadAll());
    const header = el('header', { class: 'pr-head' },
        el('div', { class: 'pr-brand' }, el('span', { class: 'pr-brand-mark' }, icon('fa-clock-rotate-left')), el('span', { class: 'pr-brand-name' }, '프롬프트 복원기')),
        el('div', { class: 'pr-head-actions' }, DOM.reloadBtn, DOM.themeBtn));

    DOM.sourceSeg = segmented(SOURCES, state.source, (id) => switchSource(id), 'pr-seg-source');
    DOM.sourceNote = el('p', { class: 'pr-note' });
    DOM.scanRow = el('div', { class: 'pr-scan-row' });

    // chat panel
    DOM.search = el('input', { type: 'search', class: 'pr-input pr-search-input', placeholder: '채팅 이름이나 캐릭터 설명으로 찾기' });
    DOM.search.addEventListener('input', renderList);
    DOM.sort = el('select', { class: 'pr-input pr-select', title: '정렬' },
        el('option', { value: 'recent' }, '최근 저장순'),
        el('option', { value: 'name' }, '이름순'),
        el('option', { value: 'size' }, '용량순'),
        el('option', { value: 'count' }, '기록 많은 순'));
    DOM.sort.addEventListener('change', renderList);
    DOM.favBtn = iconButton('fa-star', '즐겨찾기만 보기', () => {
        state.favoritesOnly = !state.favoritesOnly;
        DOM.favBtn.classList.toggle('on', state.favoritesOnly);
        renderList();
    });
    DOM.emptyBtn = iconButton('fa-eye-slash', '빈 채팅 숨기기', () => {
        state.hideEmpty = !state.hideEmpty;
        DOM.emptyBtn.classList.toggle('on', state.hideEmpty);
        renderList();
    });
    DOM.emptyBtn.classList.add('on');
    DOM.currentBtn = btn('현재 채팅', () => selectCurrentChat(true), { iconName: 'fa-location-crosshairs', cls: 'pr-btn-label-wide', title: '지금 열려 있는 채팅을 선택합니다' });

    DOM.listInfo = el('span', { class: 'pr-list-info' });
    DOM.listTools = el('div', { class: 'pr-list-tools' },
        el('button', { class: 'pr-link', type: 'button', onclick: selectAllVisible }, '보이는 것 모두 선택'),
        el('button', { class: 'pr-link', type: 'button', onclick: () => { state.selectedKeys = []; afterSelectionChange(); } }, '선택 해제'));
    DOM.list = el('div', { class: 'pr-list', role: 'listbox', 'aria-multiselectable': 'true' });
    DOM.desc = el('details', { class: 'pr-desc' });

    DOM.chatPanel = el('section', { class: 'pr-panel pr-chat-panel' },
        el('div', { class: 'pr-toolbar' },
            el('div', { class: 'pr-search' }, icon('fa-magnifying-glass'), DOM.search),
            DOM.sort, DOM.favBtn, DOM.emptyBtn, DOM.currentBtn),
        el('div', { class: 'pr-list-head' }, DOM.listInfo, DOM.listTools),
        DOM.list,
        DOM.desc);

    // view panel
    DOM.modeSeg = segmented(MODES, null, (id) => previewData(id), 'pr-seg-mode');
    DOM.sourceActions = el('div', { class: 'pr-source-actions' });
    DOM.viewOptions = el('div', { class: 'pr-view-options' });
    DOM.fieldChips = el('div', { class: 'pr-fields' });
    DOM.previewText = el('div', { class: 'pr-preview-text' });
    DOM.preview = el('div', { class: 'pr-preview', tabindex: '0' }, DOM.previewText);
    DOM.previewActions = el('div', { class: 'pr-preview-actions' });
    DOM.viewPanel = el('section', { class: 'pr-panel pr-view-panel' },
        el('div', { class: 'pr-view-head' }, DOM.modeSeg, DOM.sourceActions),
        DOM.viewOptions,
        DOM.fieldChips,
        DOM.preview,
        DOM.previewActions);

    DOM.wiPanel = el('section', { class: 'pr-panel pr-wi-panel' });
    DOM.status = el('div', { class: 'pr-status', role: 'status', 'aria-live': 'polite' });

    root.append(header, DOM.sourceSeg, DOM.sourceNote, DOM.scanRow, DOM.chatPanel, DOM.viewPanel, DOM.wiPanel, DOM.status);

    state.source = ['ext', 'st', 'wi'].includes(getSettings().defaultSource) ? getSettings().defaultSource : 'ext';
    updateSourceUi();
}

function updateSourceUi() {
    setSegmented(DOM.sourceSeg, state.source);
    const src = SOURCES.find(s => s.id === state.source);
    DOM.sourceNote.textContent = src?.note || '';
    const isWi = state.source === 'wi';
    DOM.chatPanel.hidden = isWi;
    DOM.viewPanel.hidden = isWi || !state.selectedKeys.length;
    DOM.wiPanel.hidden = !isWi;
    DOM.currentBtn.hidden = isWi;
    DOM.sort.querySelector('option[value="recent"]').disabled = state.source !== 'ext';
    if (state.source !== 'ext' && DOM.sort.value === 'recent') DOM.sort.value = 'name';
    if (state.source === 'ext' && !state.loaded) DOM.sort.value = 'recent';
    renderScanRow();
}

function renderScanRow() {
    DOM.scanRow.replaceChildren();
    if (state.source !== 'st') { DOM.scanRow.hidden = true; return; }
    DOM.scanRow.hidden = false;
    DOM.scanRow.append(toggle('기록 개수·용량·설명까지 읽기', getSettings().stScanDetails !== false, (v) => {
        saveSettings({ stScanDetails: v });
        if (v && state.loaded && !state.scanning) startStScan();
        if (!v) state.scanToken++;
    }, '채팅이 많으면 시간이 걸립니다. 한 번에 하나씩 읽어서 메모리는 적게 씁니다.'));
    if (state.scanning) DOM.scanRow.append(btn('읽기 멈추기', () => { state.scanToken++; }, { iconName: 'fa-stop', cls: 'pr-btn-quiet' }));
}

async function switchSource(id) {
    if (state.source === id) return;
    state.scanToken++;
    state.source = id;
    saveSettings({ defaultSource: id });
    state.items = [];
    state.selectedKeys = [];
    state.loaded = false;
    state.mode = null;
    state.latestCache.clear();
    updateSourceUi();
    if (id === 'wi') { await showWi(); return; }
    await loadList();
}

async function showWi() {
    setStatus('');
    await renderWiPanel(DOM.wiPanel, { getSettings, saveSettings, setStatus });
}

function reloadAll() {
    state.scanToken++;
    state.latestCache.clear();
    clearStCache();
    clearChunkCache();
    if (state.source === 'wi') { showWi(); return; }
    loadList({ keepSelection: true });
}

// ---------------------------------------------------------------- list loading

async function loadList({ keepSelection = false } = {}) {
    const token = ++state.loadToken;
    state.scanToken++;
    setStatus('불러오는 중…');
    const metadata = getMetadata();
    const prev = keepSelection ? [...state.selectedKeys] : [];
    try {
        if (state.source === 'ext') {
            const chats = await listChats();
            if (token !== state.loadToken) return;
            state.items = chats.map(s => ({
                key: s.chatId, count: s.count || 0, bytes: s.bytes || 0, stored: s.stored || 0, lastTs: s.lastTs || 0,
                descSnippet: s.descSnippet || '', hasPrompt: (s.count || 0) > 0, charName: s.charName, avatar: s.avatar,
                isGroup: s.isGroup, scanned: true, metadata: metadata[s.chatId] || {},
            }));
        } else {
            const keys = await listStKeys();
            if (token !== state.loadToken) return;
            const old = new Map(state.items.map(i => [i.key, i]));
            state.items = keys.map(k => {
                const o = old.get(k);
                return o?.scanned ? { ...o, metadata: metadata[k] || {} } : {
                    key: k, count: null, bytes: null, lastTs: 0, descSnippet: '', hasPrompt: true, scanned: false, metadata: metadata[k] || {},
                };
            });
        }
    } catch (e) {
        console.error(e);
        setStatus(`저장소를 열지 못했습니다: ${e?.message ?? e}`, 'error');
        return;
    }
    state.loaded = true;
    state.selectedKeys = prev.filter(k => state.items.some(i => i.key === k));
    renderList();
    afterSelectionChange({ keepMode: keepSelection });
    setStatus(`채팅 ${state.items.length}개를 불러왔습니다.`);
    if (state.source === 'st' && getSettings().stScanDetails !== false) startStScan();
}

async function startStScan() {
    const token = ++state.scanToken;
    state.scanning = true;
    renderScanRow();
    const total = state.items.length;
    let done = 0;
    let last = 0;
    await scanStChats((key, summary) => {
        if (token !== state.scanToken) return;
        done++;
        const item = findItem(key);
        if (item && !summary.error) Object.assign(item, summary, { scanned: true });
        if (Date.now() - last > 400) {
            last = Date.now();
            renderList();
            setStatus(`기록을 읽는 중… ${done}/${total}`);
        }
    }, () => token !== state.scanToken);
    const stopped = token !== state.scanToken;
    state.scanning = false;
    renderScanRow();
    renderList();
    if (stopped) { setStatus(`읽기를 멈췄습니다 (${done}/${total}).`); return; }
    const big = state.items.filter(i => i.bytes > CHROMIUM_IDB_VALUE_LIMIT * 0.8).length;
    setStatus(big ? `채팅 ${total}개를 읽었습니다. ${big}개는 기록이 100MB를 넘습니다.` : `채팅 ${total}개를 읽었습니다.`, big ? 'warn' : '');
}

function selectCurrentChat(announce) {
    const ctx = SillyTavern.getContext();
    const chatId = ctx.getCurrentChatId?.();
    if (!chatId) { if (announce) setStatus('열려 있는 채팅이 없습니다.'); return false; }
    const item = findItem(chatId);
    if (!item) { if (announce) setStatus('현재 채팅의 기록이 이 저장소에 없습니다.'); return false; }
    state.selectedKeys = [chatId];
    DOM.search.value = '';
    state.favoritesOnly = false;
    DOM.favBtn.classList.remove('on');
    renderList();
    afterSelectionChange();
    DOM.list.querySelector('.pr-row.selected')?.scrollIntoView({ block: 'nearest' });
    if (announce) setStatus(`현재 채팅을 선택했습니다: ${displayName(item)}`);
    return true;
}

// ---------------------------------------------------------------- list rendering

function filteredItems() {
    const term = DOM.search.value.trim().toLowerCase();
    return state.items.filter(item => {
        if (state.favoritesOnly && !item.metadata.isFavorite) return false;
        if (state.hideEmpty && item.scanned && (!item.count || !item.hasPrompt)) return false;
        if (term) {
            const hay = `${displayName(item)}\n${item.descSnippet || ''}`.toLowerCase();
            if (!hay.includes(term)) return false;
        }
        return true;
    }).sort((a, b) => {
        if (!!a.metadata.isFavorite !== !!b.metadata.isFavorite) return a.metadata.isFavorite ? -1 : 1;
        switch (DOM.sort.value) {
            case 'size': return (b.stored || b.bytes || -1) - (a.stored || a.bytes || -1);
            case 'count': return (b.count ?? -1) - (a.count ?? -1);
            case 'recent': return (b.lastTs || 0) - (a.lastTs || 0);
            default: return displayName(a).localeCompare(displayName(b));
        }
    });
}

function renderList() {
    if (!DOM.list) return;
    const items = filteredItems();
    const frag = document.createDocumentFragment();
    for (const item of items) frag.append(renderRow(item));
    if (!items.length) {
        const msg = state.items.length
            ? '조건에 맞는 채팅이 없습니다. 검색어나 필터를 바꿔 보세요.'
            : state.source === 'ext'
                ? '아직 저장된 기록이 없습니다. 메시지를 보내면 여기에 쌓입니다. 예전 기록은 "ST 기본 저장소"에서 볼 수 있습니다.'
                : 'ST 기본 저장소가 비어 있습니다.';
        frag.append(el('div', { class: 'pr-empty' }, msg));
    }
    DOM.list.replaceChildren(frag);
    DOM.listInfo.textContent = `채팅 ${items.length}개${state.selectedKeys.length ? ` 중 ${state.selectedKeys.length}개 선택` : ''}`;
}

function renderRow(item) {
    const selected = state.selectedKeys.includes(item.key);
    const row = el('div', { class: `pr-row${selected ? ' selected' : ''}`, role: 'option', 'aria-selected': String(selected), tabindex: '0', dataset: { key: item.key } });
    const pick = el('input', { type: 'checkbox', class: 'pr-pick', title: '여러 개 선택', 'aria-label': `${displayName(item)} 선택` });
    pick.checked = selected;
    pick.addEventListener('click', e => e.stopPropagation());
    pick.addEventListener('change', () => toggleKey(item.key, pick.checked));
    const meta = el('div', { class: 'pr-row-meta' });
    if (item.scanned) {
        meta.append(chip(`기록 ${item.count ?? 0}`));
        if (state.source === 'ext' && item.stored) {
            meta.append(chip(formatBytes(item.stored), { title: `원래 크기 ${formatBytes(item.bytes)} → 중복을 빼고 실제로 쓴 공간 ${formatBytes(item.stored)}` }));
        } else if (item.bytes != null) {
            meta.append(chip(formatBytes(item.bytes)));
        }
    }
    if (item.lastTs) meta.append(chip(formatShortDate(item.lastTs), { title: `마지막 저장 ${formatDate(item.lastTs)}` }));
    if (state.source === 'st' && item.bytes > CHROMIUM_IDB_VALUE_LIMIT * 0.8) {
        meta.append(chip('100MB 넘음', { cls: 'pr-chip-warn', icon: 'fa-triangle-exclamation', title: '기록이 매우 큽니다. 일부 브라우저(시크릿 모드 등)는 한 항목이 약 127MB를 넘으면 저장을 거부하고, ST는 그 오류를 보여주지 않습니다. 설정의 "현재 채팅 점검"으로 확인할 수 있습니다.' }));
    }
    const star = el('button', { class: `pr-star${item.metadata.isFavorite ? ' on' : ''}`, type: 'button', title: '즐겨찾기', 'aria-pressed': String(!!item.metadata.isFavorite) },
        el('i', { class: `${item.metadata.isFavorite ? 'fa-solid' : 'fa-regular'} fa-star` }));
    star.addEventListener('click', (e) => {
        e.stopPropagation();
        const on = !item.metadata.isFavorite;
        const m = getMetadata();
        m[item.key] = { ...m[item.key], isFavorite: on };
        saveMetadata(m);
        item.metadata.isFavorite = on;
        star.classList.toggle('on', on);
        star.setAttribute('aria-pressed', String(on));
        star.firstChild.className = `${on ? 'fa-solid' : 'fa-regular'} fa-star`;
    });
    row.append(pick, avatarFor(item), el('div', { class: 'pr-row-main' }, el('div', { class: 'pr-row-name', title: displayName(item) }, displayName(item)), meta), star);
    const activate = () => {
        if (state.selectedKeys.length > 1) toggleKey(item.key, !selected);
        else {
            state.selectedKeys = selected ? [] : [item.key];
            renderList();
            afterSelectionChange();
        }
    };
    row.addEventListener('click', activate);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
    return row;
}

function toggleKey(key, on) {
    if (on) { if (!state.selectedKeys.includes(key)) state.selectedKeys.push(key); } else state.selectedKeys = state.selectedKeys.filter(k => k !== key);
    renderList();
    afterSelectionChange();
}

function selectAllVisible() {
    const keys = filteredItems().map(i => i.key);
    state.selectedKeys = [...new Set([...state.selectedKeys, ...keys])];
    renderList();
    afterSelectionChange();
}

function afterSelectionChange({ keepMode = false } = {}) {
    const n = state.selectedKeys.length;
    DOM.viewPanel.hidden = state.source === 'wi' || n === 0;
    if (!keepMode || !n) {
        state.mode = null;
        state.field = null;
        setSegmented(DOM.modeSeg, null);
        DOM.viewOptions.replaceChildren();
        DOM.fieldChips.replaceChildren();
        DOM.previewText.replaceChildren(el('div', { class: 'pr-hint' }, n ? '위에서 볼 방식을 고르세요.' : ''));
        DOM.preview.hidden = !n;
        DOM.previewActions.replaceChildren();
    } else if (state.mode) {
        rerender();
    }
    renderSourceActions();
    renderDesc();
    DOM.listInfo.textContent = `채팅 ${filteredItems().length}개${n ? ` 중 ${n}개 선택` : ''}`;
}

function renderSourceActions() {
    DOM.sourceActions.replaceChildren();
    if (!state.selectedKeys.length) return;
    if (state.source === 'ext') {
        DOM.sourceActions.append(btn('선택한 채팅 기록 삭제', deleteSelectedChats, { iconName: 'fa-trash-can', cls: 'pr-btn-danger pr-btn-quiet', title: '확장 저장소에서 선택한 채팅의 기록을 모두 지웁니다' }));
    } else if (state.source === 'st') {
        DOM.sourceActions.append(btn('확장 저장소로 복사', importSelectedFromSt, { iconName: 'fa-file-import', cls: 'pr-btn-quiet', title: 'ST 기본 저장소의 기록을 확장 저장소로 복사합니다. 이미 있는 기록은 건너뜁니다.' }));
    }
}

let descToken = 0;
async function renderDesc() {
    const token = ++descToken;
    const keys = state.selectedKeys.slice(0, 5);
    DOM.desc.replaceChildren();
    DOM.desc.hidden = true;
    const descs = [];
    for (const key of keys) {
        const item = findItem(key);
        if (!item) continue;
        let d = item.descSnippet;
        if (!d && state.source === 'ext') {
            try { d = (await latestEntry(key))?.fields?.charDescription || ''; } catch { d = ''; }
        }
        if (isNotEmpty(d)) descs.push({ name: displayName(item), d });
    }
    if (token !== descToken || !descs.length) return;
    DOM.desc.append(el('summary', {}, icon('fa-user'), el('span', {}, descs.length > 1 ? `캐릭터 설명 ${descs.length}개` : '캐릭터 설명')));
    for (const x of descs) {
        DOM.desc.append(el('div', { class: 'pr-desc-item' }, el('div', { class: 'pr-desc-name' }, x.name), el('div', { class: 'pr-desc-text' }, processValue(x.d, {}))));
    }
    DOM.desc.hidden = false;
}

// ---------------------------------------------------------------- preview modes

function renderViewOptions() {
    DOM.viewOptions.replaceChildren();
    const s = getSettings();
    const isRaw = state.mode === 'rawPrompt' || (state.mode === 'selected' && state.field === 'rawPrompt');
    if (isRaw) {
        DOM.viewOptions.append(toggle('읽기 모드', s.readingMode !== false, v => { saveSettings({ readingMode: v }); rerender(); }, '켜면 "역할: 내용" 형식, 끄면 원본 JSON'));
        if (s.readingMode !== false) DOM.viewOptions.append(toggle('메시지 사이 띄우기', s.spacingMode !== false, v => { saveSettings({ spacingMode: v }); rerender(); }));
    }
    DOM.viewOptions.append(toggle('\\n 같은 이스케이프 그대로 두기', !!s.keepEscapes, v => { saveSettings({ keepEscapes: v }); rerender(); }));
    if (state.selectedKeys.length > 1 && state.mode !== 'all') {
        DOM.viewOptions.append(toggle('여러 채팅을 한 파일로 받기', !!s.combineDownloads, v => saveSettings({ combineDownloads: v })));
    }
}

function rerender() {
    if (state.mode === 'rawPrompt') return showRawPrompt();
    if (state.mode === 'selected') return state.field ? showField(state.field) : showFields();
    if (state.mode === 'all') return showHistory();
}

async function previewData(mode) {
    if (!state.selectedKeys.length) return;
    state.mode = mode;
    state.field = null;
    state.page = 0;
    setSegmented(DOM.modeSeg, mode);
    DOM.fieldChips.replaceChildren();
    DOM.preview.hidden = false;
    DOM.previewText.replaceChildren(el('div', { class: 'pr-hint' }, '불러오는 중…'));
    try {
        await rerender();
        setStatus('');
    } catch (e) {
        console.error(e);
        DOM.previewText.replaceChildren(el('div', { class: 'pr-hint pr-error' }, `불러오지 못했습니다: ${e?.message ?? e}`));
        setStatus('불러오지 못했습니다.', 'error');
    }
}

function rawPromptText(entry) {
    const raw = entry?.rawPrompt;
    if (raw == null || raw === '' || (Array.isArray(raw) && !raw.length)) return '(프롬프트 없음)';
    return processValue(raw, previewOpts('rawPrompt'));
}

function setPreviewText(text) {
    DOM.preview.classList.remove('pr-preview-timeline');
    DOM.previewText.replaceChildren(el('div', { class: 'pr-text' }, text));
}

async function showRawPrompt() {
    renderViewOptions();
    const data = await selectedLatest();
    let text = '';
    for (const { item, entry } of data) {
        if (data.length > 1) text += formatSeparator(`채팅: ${displayName(item)}`);
        text += rawPromptText(entry) + '\n\n';
    }
    setPreviewText(text.trimEnd());
    renderPreviewActions();
}

async function showFields() {
    renderViewOptions();
    const data = await selectedLatest();
    const available = new Set();
    for (const { entry } of data) for (const f of DETAILED_FIELDS) if (isNotEmpty(entry?.fields?.[f])) available.add(f);
    DOM.fieldChips.replaceChildren();
    const mk = (label, field) => {
        const c = el('button', { class: `pr-field${state.field === field ? ' on' : ''}`, type: 'button', dataset: { field } }, label);
        c.addEventListener('click', () => showField(field));
        return c;
    };
    DOM.fieldChips.append(mk('모두', '__ALL__'));
    DETAILED_FIELDS.filter(f => available.has(f)).forEach(f => DOM.fieldChips.append(mk(f, f)));
    DOM.preview.classList.remove('pr-preview-timeline');
    DOM.previewText.replaceChildren(el('div', { class: 'pr-hint' }, available.size ? '보고 싶은 항목을 고르세요.' : '세부 정보가 없습니다. 설정에서 "세부 정보도 저장"이 꺼져 있었거나 기록이 없습니다.'));
    renderPreviewActions();
}

async function showField(field) {
    if (!DOM.fieldChips.childElementCount) await showFields();
    state.field = field;
    DOM.fieldChips.querySelectorAll('.pr-field').forEach(c => c.classList.toggle('on', c.dataset.field === field));
    renderViewOptions();
    const data = await selectedLatest();
    let text = '';
    for (const { item, entry } of data) {
        if (data.length > 1) text += formatSeparator(`채팅: ${displayName(item)}`);
        const f = entry?.fields || {};
        if (field === '__ALL__') {
            for (const k of DETAILED_FIELDS) if (isNotEmpty(f[k])) text += formatField(k, processValue(f[k], previewOpts(k))) + '\n';
        } else {
            text += formatField(field, processValue(f[field] ?? '(내용 없음)', previewOpts(field)));
        }
        text += '\n';
    }
    setPreviewText(text.trimEnd());
    renderPreviewActions();
}

// ---------------------------------------------------------------- full history (timeline)

function previewLines(messages) {
    const keep = !!getSettings().keepEscapes;
    return messages.map(m => `${roleLabel(m)}: ${processValue(contentToText(m?.content), { keepEscapes: keep })}`).join('\n');
}

function takePreview(raw) {
    // Collapsed: the end of the prompt (what differs between takes). Open: beginning + end.
    let head = '';
    let tail = '';
    if (Array.isArray(raw) && raw.length) {
        let list = raw.filter(m => m?.role !== 'system');
        if (!list.length) list = raw;
        tail = previewLines(list.slice(-2));
        head = list.length > 2 ? previewLines(list.slice(0, Math.min(3, list.length - 2))) : '';
    } else if (typeof raw === 'string' && raw.length) {
        const t = processValue(raw, { keepEscapes: !!getSettings().keepEscapes });
        tail = t.slice(-500);
        head = t.length > 500 ? t.slice(0, Math.min(600, t.length - 500)) : '';
    }
    if (!tail) return el('div', { class: 'pr-take-preview pr-hint' }, '(프롬프트 없음)');
    const box = el('div', { class: 'pr-take-preview', title: '눌러서 펼치기/접기' });
    if (head) box.append(el('div', { class: 'pr-take-head' }, head), el('div', { class: 'pr-take-gap' }, '⋯'));
    box.append(el('div', { class: 'pr-take-tail' }, tail));
    box.addEventListener('click', () => box.classList.toggle('open'));
    return box;
}

async function showHistory() {
    renderViewOptions();
    DOM.previewActions.replaceChildren();
    if (state.selectedKeys.length !== 1) {
        setPreviewText('전체 기록은 채팅을 하나만 골랐을 때 볼 수 있습니다.');
        return;
    }
    const key = state.selectedKeys[0];
    const pageSize = Math.max(5, Number(getSettings().historyPageSize) || 20);
    const total = await countEntries(state.source, key);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    state.page = Math.min(Math.max(0, state.page), pages - 1);
    const entries = await getEntriesPage(state.source, key, state.page * pageSize, pageSize, total);

    DOM.preview.classList.add('pr-preview-timeline');
    const wrap = el('div', { class: 'pr-timeline' });
    if (!total) {
        DOM.previewText.replaceChildren(el('div', { class: 'pr-hint' }, '저장된 기록이 없습니다.'));
        return;
    }
    const newest = total - state.page * pageSize;
    const oldest = Math.max(1, newest - pageSize + 1);
    const top = el('div', { class: 'pr-tl-top' },
        el('span', { class: 'pr-tl-range' }, `${total}개 중 #${newest}–#${oldest}`, el('span', { class: 'pr-muted' }, ' (최신순)')),
        pages > 1 ? pager(pages) : null);
    wrap.append(top);

    let group = null;
    let groupMes;
    for (const entry of entries) {
        if (!group || entry.mesId !== groupMes) {
            groupMes = entry.mesId;
            group = el('div', { class: 'pr-tl-group' },
                el('div', { class: 'pr-tl-label' }, entry.mesId != null ? `메시지 #${entry.mesId}` : '메시지 번호 없음'));
            wrap.append(group);
        }
        group.append(renderTake(entry, key));
    }
    if (pages > 1) wrap.append(el('div', { class: 'pr-tl-bottom' }, pager(pages)));
    DOM.previewText.replaceChildren(wrap);
}

function renderTake(entry, key) {
    const raw = entry.rawPrompt;
    const type = entry.type || (entry.source === 'st' ? 'st' : 'unknown');
    const actions = el('div', { class: 'pr-take-actions' },
        iconButton('fa-eye', '전체 보기 (다운로드 없이)', () => openEntryViewer(entry, 'prompt'), 'pr-ib-primary'),
        iconButton('fa-copy', '프롬프트 복사', async () => {
            const ok = await copyText(formatReadable(raw, { spacing: getSettings().spacingMode !== false }));
            setStatus(ok ? `기록 #${entry.ordinal}을(를) 복사했습니다.` : '복사하지 못했습니다. "전체 보기"의 텍스트 선택 모드를 쓰세요.', ok ? '' : 'error');
        }),
        iconButton('fa-file-lines', '프롬프트를 .txt로 받기', () => downloadHistoryEntry(entry, 'raw')),
        iconButton('fa-file-code', '기록 전체를 .json으로 받기', () => downloadHistoryEntry(entry, 'all')),
        iconButton('fa-file-export', 'SillyTavern 가져오기용 .jsonl', () => openEntryViewer(entry, 'jsonl')));
    if (entry.source === 'ext') {
        actions.append(iconButton('fa-trash-can', '이 기록 삭제', async () => {
            const ctx = SillyTavern.getContext();
            const ok = await ctx.callGenericPopup(`기록 #${entry.ordinal}을(를) 확장 저장소에서 삭제할까요?`, ctx.POPUP_TYPE.CONFIRM);
            if (!ok) return;
            await deleteRecord(entry.id);
            state.latestCache.delete(`ext:${key}`);
            await refreshCounts();
            await showHistory();
            setStatus(`기록 #${entry.ordinal}을(를) 삭제했습니다.`);
        }, 'pr-ib-danger'));
    }
    const facts = el('div', { class: 'pr-take-facts' },
        el('span', { class: `pr-type pr-type-${type}` }, TYPE_LABELS[type] || (type === 'st' ? 'ST 저장' : type)));
    if (entry.ts) facts.append(el('span', { class: 'pr-fact', title: formatDate(entry.ts) }, formatShortDate(entry.ts)));
    if (Array.isArray(raw)) facts.append(el('span', { class: 'pr-fact' }, `메시지 ${raw.length}개`));
    else if (typeof raw === 'string') facts.append(el('span', { class: 'pr-fact' }, `${raw.length.toLocaleString()}자`));
    return el('article', { class: `pr-take pr-take-${type}` },
        el('span', { class: 'pr-take-node', 'aria-hidden': 'true' }),
        el('div', { class: 'pr-take-body' },
            el('div', { class: 'pr-take-row' }, el('span', { class: 'pr-take-no' }, `#${entry.ordinal}`), facts, actions),
            takePreview(raw)));
}

function pager(pages) {
    const go = (p) => { state.page = p; showHistory().then(() => { DOM.preview.scrollTop = 0; }); };
    const p = state.page;
    const input = el('input', { type: 'number', class: 'pr-input pr-page-input', min: '1', max: String(pages), 'aria-label': '페이지' });
    input.value = String(p + 1);
    input.addEventListener('change', () => go(Math.min(pages, Math.max(1, Number(input.value) || 1)) - 1));
    const b = (iconName, title, target, disabled) => {
        const x = iconButton(iconName, title, () => go(target));
        x.disabled = disabled;
        return x;
    };
    return el('div', { class: 'pr-pager' },
        b('fa-angles-left', '10페이지 앞 (더 최근)', Math.max(0, p - 10), p === 0),
        b('fa-angle-left', '이전 페이지 (더 최근)', p - 1, p === 0),
        el('span', { class: 'pr-page-pos' }, input, el('span', {}, `/ ${pages}`)),
        b('fa-angle-right', '다음 페이지 (더 오래된)', p + 1, p >= pages - 1),
        b('fa-angles-right', '10페이지 뒤 (더 오래된)', Math.min(pages - 1, p + 10), p >= pages - 1));
}

async function openEntryViewer(entry, tab) {
    const item = findItem(entry.key);
    let nav = null;
    let index = entry.index;
    try {
        nav = await createNavigator(entry.source, entry.key);
        if (entry.source === 'ext') {
            const i = nav.indexOfId(entry.id);
            if (i >= 0) index = i;
        }
    } catch (e) {
        console.warn('[PromptRestorer] navigator failed', e);
    }
    await openViewer({
        nav, index, entry: nav ? null : entry, tab,
        title: item ? displayName(item) : entry.key,
        chatName: item ? displayName(item) : entry.key,
        getSettings, saveSettings,
    });
}

// ---------------------------------------------------------------- preview actions / downloads

function renderPreviewActions() {
    DOM.previewActions.replaceChildren();
    const mode = state.mode;
    if (mode === 'selected' && !state.field) return;
    const name = state.selectedKeys.length === 1 ? displayName(findItem(state.selectedKeys[0])) : 'combined';
    DOM.previewActions.append(
        btn('복사', async (e) => {
            const b = e.currentTarget;
            const ok = await copyText(DOM.previewText.innerText);
            b.classList.add(ok ? 'pr-flash-ok' : 'pr-flash-err');
            setTimeout(() => b.classList.remove('pr-flash-ok', 'pr-flash-err'), 1200);
            setStatus(ok ? '복사했습니다.' : '복사하지 못했습니다. "크게 보기"에서 텍스트 선택 모드를 쓰세요.', ok ? '' : 'error');
        }, { iconName: 'fa-copy', cls: 'pr-btn-primary' }),
        btn('.txt로 받기', downloadCurrentPreview, { iconName: 'fa-download' }),
        btn('크게 보기', () => openViewer({ text: DOM.previewText.innerText, title: '미리보기', chatName: name, getSettings, saveSettings }), { iconName: 'fa-up-right-and-down-left-from-center', title: '큰 창에서 보고, 텍스트 선택 모드로 직접 복사할 수 있습니다' }));
    if (mode === 'rawPrompt') {
        const j = btn('가져오기용 .jsonl', showJsonlOptions, { iconName: 'fa-file-export', title: 'SillyTavern 채팅 가져오기(Import) 형식' });
        if (state.selectedKeys.length !== 1) { j.disabled = true; j.title = '채팅을 하나만 골라야 합니다'; }
        DOM.previewActions.append(j);
    }
    if (mode === 'selected' && state.field === '__ALL__') {
        DOM.previewActions.append(btn('기록 전체 .json', () => performDownload('full_details', e => JSON.stringify(e?.full ?? {}, null, 2), '.json'), { iconName: 'fa-file-code' }));
    }
}

async function performDownload(mode, provider, ext = '.txt') {
    const combine = getSettings().combineDownloads && state.selectedKeys.length > 1;
    const data = await selectedLatest();
    if (combine) {
        const text = data.map(({ item, entry }) => formatSeparator(`채팅: ${displayName(item)}`) + provider(entry)).join('\n\n');
        triggerDownload(mode, text, ['combined'], ext === '.json' ? '.txt' : ext);
    } else {
        for (const { item, entry } of data) triggerDownload(mode, provider(entry), [displayName(item)], ext);
    }
}

function triggerDownload(mode, content, nameParts, extension = '.txt') {
    const fileName = `${safeFileName(...nameParts)}_${mode}${extension}`;
    const mime = extension === '.jsonl' ? 'application/jsonl' : extension === '.json' ? 'application/json' : 'text/plain; charset=utf-8';
    const ok = downloadText(fileName, content, mime);
    setStatus(ok ? `${fileName} 받기를 시작했습니다. 안 되면 "크게 보기"에서 복사하세요.` : '이 브라우저에서는 파일을 받을 수 없습니다. "크게 보기"에서 복사하세요.', ok ? '' : 'error');
}

function downloadCurrentPreview() {
    const field = state.field;
    performDownload(field || state.mode, (entry) => {
        const f = entry?.fields || {};
        if (state.mode === 'selected' && field === '__ALL__') return DETAILED_FIELDS.map(k => isNotEmpty(f[k]) ? formatField(k, processValue(f[k], previewOpts(k))) : '').join('\n');
        if (state.mode === 'selected' && field) return formatField(field, processValue(f[field] ?? '(내용 없음)', previewOpts(field)));
        return rawPromptText(entry);
    });
}

function downloadHistoryEntry(entry, type) {
    const name = displayName(findItem(entry.key)) || entry.key;
    if (type === 'raw') {
        const content = processValue(formatReadable(entry.rawPrompt, { spacing: false }), { keepEscapes: !!getSettings().keepEscapes });
        triggerDownload(`history${entry.ordinal}_rawPrompt`, content, [name], '.txt');
    } else {
        triggerDownload(`history${entry.ordinal}_allData`, JSON.stringify(entry.full, null, 2), [name], '.json');
    }
}

function showJsonlOptions() {
    const existing = DOM.previewActions.querySelector('.pr-jsonl');
    if (existing) { existing.remove(); return; }
    const charIn = el('input', { type: 'text', class: 'pr-input', placeholder: '캐릭터 이름' });
    const userIn = el('input', { type: 'text', class: 'pr-input', placeholder: '사용자 이름' });
    let exclude = true;
    const make = async () => {
        const charName = charIn.value.trim();
        const userName = userIn.value.trim();
        if (!charName || !userName) { setStatus('캐릭터 이름과 사용자 이름을 모두 입력하세요.', 'error'); return null; }
        const key = state.selectedKeys[0];
        const entry = await latestEntry(key);
        if (!entry?.rawPrompt) { setStatus('이 채팅에는 대화 내용이 없습니다.', 'error'); return null; }
        return { key, text: generateJsonl(entry.rawPrompt, charName, userName, exclude) };
    };
    const box = el('div', { class: 'pr-jsonl' },
        el('div', { class: 'pr-jsonl-fields' }, charIn, userIn),
        toggle('system 메시지 빼기', true, v => { exclude = v; }),
        el('div', { class: 'pr-jsonl-actions' },
            btn('받기', async () => { const r = await make(); if (!r) return; triggerDownload('import', r.text, [displayName(findItem(r.key))], '.jsonl'); box.remove(); }, { iconName: 'fa-download', cls: 'pr-btn-primary' }),
            btn('보기·복사', async () => { const r = await make(); if (!r) return; openViewer({ text: r.text, title: 'import.jsonl', chatName: displayName(findItem(r.key)), getSettings, saveSettings }); }, { iconName: 'fa-eye' }),
            btn('닫기', () => box.remove(), { cls: 'pr-btn-quiet' })));
    DOM.previewActions.append(box);
    charIn.focus();
}

// ---------------------------------------------------------------- data ops

async function refreshCounts() {
    if (state.source !== 'ext') return;
    const chats = await listChats();
    const byKey = new Map(chats.map(c => [c.chatId, c]));
    const metadata = getMetadata();
    for (const c of chats) {
        let item = findItem(c.chatId);
        if (!item) {
            item = { key: c.chatId, scanned: true, metadata: metadata[c.chatId] || {} };
            state.items.push(item);
        }
        Object.assign(item, {
            count: c.count || 0, bytes: c.bytes || 0, stored: c.stored || 0, lastTs: c.lastTs || 0,
            descSnippet: c.descSnippet || item.descSnippet || '', hasPrompt: (c.count || 0) > 0, charName: c.charName, avatar: c.avatar,
        });
    }
    state.items = state.items.filter(i => byKey.has(i.key));
    const before = state.selectedKeys.length;
    state.selectedKeys = state.selectedKeys.filter(k => byKey.has(k));
    renderList();
    if (before !== state.selectedKeys.length) afterSelectionChange();
}

async function deleteSelectedChats() {
    const ctx = SillyTavern.getContext();
    const names = state.selectedKeys.map(k => displayName(findItem(k) || { key: k }));
    const ok = await ctx.callGenericPopup(
        `확장 저장소에서 채팅 ${names.length}개의 기록을 모두 삭제할까요?\n\n${names.slice(0, 10).join('\n')}${names.length > 10 ? '\n…' : ''}`,
        ctx.POPUP_TYPE.CONFIRM);
    if (!ok) return;
    setStatus('삭제하는 중…');
    for (const key of [...state.selectedKeys]) {
        await deleteChat(key);
        state.latestCache.delete(`ext:${key}`);
    }
    state.selectedKeys = [];
    await refreshCounts();
    afterSelectionChange();
    setStatus(`채팅 ${names.length}개의 기록을 삭제했습니다.`);
}

function guessCharName(key) {
    const m = String(key).match(/^(.*?) - \d{4}-\d{1,2}-\d{1,2}/);
    return m ? m[1] : null;
}

async function importSelectedFromSt() {
    const s = getSettings();
    let copied = 0;
    let skipped = 0;
    const keys = [...state.selectedKeys];
    for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        setStatus(`복사하는 중… (${k + 1}/${keys.length})`);
        const arr = await getStChat(key);
        for (let i = 0; i < arr.length; i++) {
            const e = arr[i];
            if (!e || e.rawPrompt == null || e.rawPrompt === '') { skipped++; continue; }
            const raw = s.stripMedia ? stripDataUris(e.rawPrompt) : e.rawPrompt;
            const hash = hashPrompt(raw);
            if (await hasHash(key, hash)) { skipped++; continue; }
            const details = s.saveDetails ? pickDetails(e) : null;
            const record = {
                chatId: key, ts: i + 1, tsUnknown: true, origin: 'st-import', type: 'st-import', mesId: e.mesId ?? null,
                chatLength: null, isGroup: false, groupId: null, charName: guessCharName(key), groupName: null, avatar: null,
                userName: null, mainApi: e.main_api ?? null, source: null, model: null, presetName: e.presetName || null,
                promptFormat: Array.isArray(raw) ? 'chat' : 'text', msgCount: Array.isArray(raw) ? raw.length : null,
                rawPrompt: raw, details, hash, descSnippet: e.charDescription ? String(e.charDescription).slice(0, 1000) : '',
            };
            record.size = estimateBytes(raw) + (details ? estimateBytes(details) : 0);
            await addRecord(record);
            copied++;
        }
    }
    clearStCache();
    setStatus(`확장 저장소로 ${copied}개를 복사했습니다. ${skipped}개는 이미 있거나 비어 있어서 건너뛰었습니다.`);
    toastr?.success?.(`${copied}개 기록을 확장 저장소로 복사했습니다.`, '프롬프트 복원기');
}

// ---------------------------------------------------------------- public

export function handleCaptured(info) {
    if (info.chatId == null) state.latestCache.clear();
    else state.latestCache.delete(`ext:${info.chatId}`);
    if (!popupOpen || state.source !== 'ext' || !state.loaded) { state.dirty = true; return; }
    clearTimeout(handleCaptured.t);
    handleCaptured.t = setTimeout(async () => {
        try {
            await refreshCounts();
            if (state.mode === 'all' && state.selectedKeys.length === 1 && state.selectedKeys[0] === info.chatId) await showHistory();
        } catch (e) { console.warn(e); }
    }, 500);
}

export function handleWiChanged() {
    if (popupOpen && state.source === 'wi') showWi();
}

export async function openMainWindow() {
    if (popupOpen) return;
    const ctx = SillyTavern.getContext();
    if (!root) buildRoot();
    applyTheme();
    popupOpen = true;
    const popup = new ctx.Popup(root, ctx.POPUP_TYPE.DISPLAY, '', {
        wide: true, large: true, allowVerticalScrolling: true, leftAlign: true, animation: 'fast',
        onClose: () => {
            popupOpen = false;
            clearStCache();
            clearChunkCache();
            for (const k of [...state.latestCache.keys()]) if (k.startsWith('st:')) state.latestCache.delete(k);
        },
    });
    const shown = popup.show();
    try {
        if (state.source === 'wi') {
            await showWi();
        } else {
            if (!state.loaded || state.dirty) {
                state.dirty = false;
                await loadList({ keepSelection: true });
            } else {
                await refreshCounts();
            }
            if (getSettings().autoSelectCurrent !== false && !state.selectedKeys.length) selectCurrentChat(false);
        }
    } catch (e) {
        console.error(e);
        setStatus(String(e?.message ?? e), 'error');
    }
    await shown;
    popupOpen = false;
}
