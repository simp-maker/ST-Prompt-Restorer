// Full viewer: browse any stored prompt (or any text) completely inside the page,
// with copy / download / plain-text selection, so it works even in browsers that
// cannot download files.

import {
    DETAILED_FIELDS,
    TYPE_LABELS,
    formatField,
    formatReadable,
    generateJsonl,
    processValue,
    roleLabel,
    toText,
    unescapeText,
} from './format.js';
import { contentToText, copyText, downloadText, el, formatBytes, formatDate, icon, iconButton, isNotEmpty, safeFileName } from './utils.js';

const TABS = [
    { id: 'prompt', label: '프롬프트', icon: 'fa-message' },
    { id: 'fields', label: '세부 필드', icon: 'fa-list-ul' },
    { id: 'json', label: '원본 JSON', icon: 'fa-code' },
    { id: 'jsonl', label: '가져오기용 JSONL', icon: 'fa-file-export' },
];

/**
 * @param {object} opts
 * @param {{ total: number, load: (i: number) => Promise<object|null> }} [opts.nav]
 * @param {number} [opts.index]
 * @param {object} [opts.entry]
 * @param {string} [opts.text] single plain-text view
 * @param {{id, label, text, ext?, tag?, mono?}[]} [opts.views] several plain-text views
 * @param {string} [opts.title]
 * @param {string} [opts.chatName]
 * @param {string} [opts.tab]
 * @param {() => object} opts.getSettings
 * @param {(patch: object) => void} opts.saveSettings
 */
export async function openViewer(opts) {
    const ctx = SillyTavern.getContext();
    const settings = opts.getSettings() || {};
    const views = opts.views || (typeof opts.text === 'string' ? [{ id: 'text', label: '텍스트', text: opts.text, ext: '.txt', tag: 'text' }] : null);
    const plain = !!views;

    const state = {
        index: opts.index ?? 0,
        entry: opts.entry ?? null,
        tab: plain ? views[0].id : (opts.tab || 'prompt'),
        field: '__ALL__',
        selectMode: false,
        readingMode: settings.readingMode !== false,
        spacing: settings.spacingMode !== false,
        includeSystem: true,
        keepEscapes: !!settings.keepEscapes,
        jsonlChar: null,
        jsonlUser: null,
        jsonlExcludeSystem: true,
        currentText: '',
        fileExt: '.txt',
        fileTag: 'prompt',
    };

    const themeName = settings.theme || document.querySelector('.pr-root.pr-main')?.className.match(/pr-theme-(\w+)/)?.[1] || 'st';
    const root = el('div', { class: `pr-root pr-viewer pr-theme-${themeName}` });
    const titleEl = el('h3', { class: 'pr-v-title' });
    const navEl = el('div', { class: 'pr-v-nav' });
    const metaEl = el('div', { class: 'pr-v-meta' });
    const tabsEl = el('div', { class: 'pr-seg pr-seg-small pr-v-tabs', role: 'tablist' });
    const optionsEl = el('div', { class: 'pr-v-options' });
    const actions = el('div', { class: 'pr-v-actions' });
    const statusEl = el('div', { class: 'pr-v-status', role: 'status', 'aria-live': 'polite' });
    const body = el('div', { class: 'pr-v-body', tabindex: '0' });

    root.append(el('div', { class: 'pr-v-head' }, titleEl, navEl), metaEl, tabsEl, optionsEl, actions, statusEl, body);
    const setStatus = (msg) => { statusEl.textContent = msg || ''; };

    // ---------- navigation
    const prevBtn = iconButton('fa-angle-left', '이전 기록 (←)', () => go(state.index - 1));
    const nextBtn = iconButton('fa-angle-right', '다음 기록 (→)', () => go(state.index + 1));
    const posInput = el('input', { type: 'number', class: 'pr-input pr-page-input', min: '1', 'aria-label': '기록 번호' });
    const posTotal = el('span', { class: 'pr-muted' });
    async function go(i) {
        if (!opts.nav || i < 0 || i >= opts.nav.total) return;
        setStatus('불러오는 중…');
        const entry = await opts.nav.load(i);
        if (!entry) { setStatus('이 기록을 불러오지 못했습니다.'); return; }
        state.index = i;
        state.entry = entry;
        state.jsonlChar = null;
        state.jsonlUser = null;
        render();
        body.scrollTop = 0;
        setStatus('');
    }
    posInput.addEventListener('change', () => go(Number(posInput.value) - 1));
    if (opts.nav && !plain) navEl.append(prevBtn, el('span', { class: 'pr-page-pos' }, el('span', { class: 'pr-muted' }, '#'), posInput, posTotal), nextBtn);
    root.addEventListener('keydown', (e) => {
        if (!opts.nav || plain) return;
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); go(state.index - 1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); go(state.index + 1); }
    });

    // ---------- tabs
    const tabDefs = plain ? views.map(v => ({ id: v.id, label: v.label })) : TABS;
    if (tabDefs.length > 1) {
        for (const t of tabDefs) {
            const b = el('button', { class: 'pr-seg-btn', type: 'button', role: 'tab', dataset: { id: t.id } }, t.icon ? icon(t.icon) : null, el('span', {}, t.label));
            b.addEventListener('click', () => { state.tab = t.id; render(); body.scrollTop = 0; });
            tabsEl.append(b);
        }
    } else {
        tabsEl.hidden = true;
    }

    // ---------- actions
    const mkBtn = (iconName, label, onClick, cls = '') => {
        const b = el('button', { class: `pr-btn ${cls}`.trim(), type: 'button' }, icon(iconName), el('span', {}, label));
        b.addEventListener('click', onClick);
        return b;
    };
    const copyBtn = mkBtn('fa-copy', '복사', async () => {
        const ok = await copyText(state.currentText);
        setStatus(ok ? `복사했습니다 (${state.currentText.length.toLocaleString()}자).` : '복사하지 못했습니다. 텍스트 선택 모드로 바꿨으니 길게 눌러 전체 선택하세요.');
        if (!ok && !state.selectMode) { state.selectMode = true; render(); }
    }, 'pr-btn-primary');
    const dlBtn = mkBtn('fa-download', '파일로 받기', () => {
        const name = plain
            ? `${safeFileName(opts.chatName || 'text', opts.title || '', state.fileTag)}${state.fileExt}`
            : `${safeFileName(opts.chatName || state.entry?.key, `기록${state.entry?.ordinal ?? ''}`, state.fileTag)}${state.fileExt}`;
        const mime = state.fileExt === '.jsonl' ? 'application/jsonl' : state.fileExt === '.json' ? 'application/json' : 'text/plain; charset=utf-8';
        const ok = downloadText(name, state.currentText, mime);
        setStatus(ok ? `${name} 받기를 시작했습니다. 받아지지 않으면 복사나 텍스트 선택 모드를 쓰세요.` : '이 브라우저에서는 파일을 받을 수 없습니다. 복사나 텍스트 선택 모드를 쓰세요.');
    });
    const selectBtn = mkBtn('fa-i-cursor', '텍스트 선택 모드', () => { state.selectMode = !state.selectMode; render(); });
    selectBtn.title = '텍스트 상자로 바꿔서, 길게 누르거나 Ctrl+A로 전체 선택할 수 있습니다';
    const scrollEnd = (top) => { const t = body.querySelector('textarea') || body; t.scrollTop = top ? 0 : t.scrollHeight; };
    actions.append(copyBtn, dlBtn, selectBtn, el('span', { class: 'pr-spacer' }),
        iconButton('fa-arrow-up', '맨 위로', () => scrollEnd(true)), iconButton('fa-arrow-down', '맨 아래로', () => scrollEnd(false)));

    function toggle(label, checked, onChange, title) {
        const input = el('input', { type: 'checkbox' });
        input.checked = !!checked;
        input.addEventListener('change', () => onChange(input.checked));
        return el('label', { class: 'pr-toggle', title: title || null }, input, el('span', { class: 'pr-toggle-ui' }), el('span', {}, label));
    }

    function renderMeta() {
        metaEl.replaceChildren();
        if (plain || !state.entry) { metaEl.hidden = true; return; }
        metaEl.hidden = false;
        const e = state.entry;
        const add = (text, cls = '', title) => metaEl.append(el('span', { class: `pr-chip ${cls}`.trim(), title: title || null }, text));
        const type = e.type || (e.source === 'st' ? 'st' : null);
        if (type) add(TYPE_LABELS[type] || type, `pr-type pr-type-${type}`);
        if (e.mesId != null) add(`메시지 #${e.mesId}`);
        if (e.ts) add(formatDate(e.ts));
        else add('시간 정보 없음', 'pr-chip-dim');
        if (e.meta?.model) add(e.meta.model, '', [e.meta.mainApi, e.meta.source].filter(Boolean).join(' / '));
        else if (e.meta?.mainApi) add(e.meta.mainApi);
        if (e.meta?.presetName) add(`프리셋 ${e.meta.presetName}`);
        if (Array.isArray(e.rawPrompt)) add(`메시지 ${e.rawPrompt.length}개`);
        else if (typeof e.rawPrompt === 'string') add(`${e.rawPrompt.length.toLocaleString()}자`);
        if (e.meta?.size) add(formatBytes(e.meta.size), '', '원래 크기');
        add(e.source === 'ext' ? '확장 저장소' : 'ST 기본 저장소', 'pr-chip-dim');
    }

    function availableFields(entry) {
        const f = entry?.fields || {};
        const list = DETAILED_FIELDS.filter(k => isNotEmpty(f[k]));
        for (const k of Object.keys(f)) {
            if (!list.includes(k) && isNotEmpty(f[k]) && typeof f[k] !== 'number' && typeof f[k] !== 'boolean') list.push(k);
        }
        return list;
    }

    function setBodyText(text, mono = false) {
        state.currentText = text;
        body.classList.toggle('pr-mono', mono);
        if (state.selectMode) {
            const ta = el('textarea', { class: 'pr-select-area', readonly: true, spellcheck: 'false' });
            ta.value = text;
            body.replaceChildren(ta);
            setTimeout(() => ta.focus(), 0);
        } else {
            body.replaceChildren(el('div', { class: 'pr-text' }, text || '(내용 없음)'));
        }
    }

    function renderPromptTab() {
        const raw = state.entry?.rawPrompt;
        optionsEl.append(
            toggle('읽기 모드', state.readingMode, v => { state.readingMode = v; opts.saveSettings({ readingMode: v }); render(); }, '끄면 원본 JSON으로 봅니다'),
            toggle('메시지 사이 띄우기', state.spacing, v => { state.spacing = v; opts.saveSettings({ spacingMode: v }); render(); }),
            toggle('system 포함', state.includeSystem, v => { state.includeSystem = v; render(); }),
            toggle('이스케이프 그대로', state.keepEscapes, v => { state.keepEscapes = v; opts.saveSettings({ keepEscapes: v }); render(); }, '\\n 같은 문자를 줄바꿈으로 바꾸지 않습니다'));
        state.fileTag = 'rawPrompt';
        state.fileExt = '.txt';
        if (raw == null || raw === '') { setBodyText('(프롬프트 없음)'); return; }
        if (Array.isArray(raw) && state.readingMode) {
            let text = formatReadable(raw, { spacing: state.spacing, includeSystem: state.includeSystem });
            if (!state.keepEscapes) text = unescapeText(text);
            if (state.selectMode) { setBodyText(text); return; }
            state.currentText = text;
            body.classList.remove('pr-mono');
            body.classList.toggle('pr-compact', !state.spacing);
            const frag = document.createDocumentFragment();
            raw.forEach((m, i) => {
                if (!state.includeSystem && m?.role === 'system') return;
                let content = contentToText(m?.content);
                if (!state.keepEscapes) content = unescapeText(content);
                const role = String(m?.role || 'unknown').replace(/[^a-z]/gi, '');
                frag.append(el('section', { class: `pr-msg pr-msg-${role}` },
                    el('div', { class: 'pr-msg-head' }, el('span', { class: 'pr-msg-role' }, roleLabel(m)), el('span', { class: 'pr-msg-no' }, `${i + 1}`)),
                    el('div', { class: 'pr-msg-body' }, content || '(빈 메시지)')));
            });
            body.replaceChildren(frag);
            return;
        }
        setBodyText(processValue(raw, { readingMode: false, keepEscapes: state.keepEscapes }), !state.readingMode && Array.isArray(raw));
    }

    function renderFieldsTab() {
        const e = state.entry;
        const fields = availableFields(e);
        if (state.field !== '__ALL__' && !fields.includes(state.field)) state.field = '__ALL__';
        const chips = el('div', { class: 'pr-fields' });
        const mk = (id, label) => {
            const c = el('button', { class: `pr-field${state.field === id ? ' on' : ''}`, type: 'button' }, label);
            c.addEventListener('click', () => { state.field = id; render(); body.scrollTop = 0; });
            return c;
        };
        chips.append(mk('__ALL__', '모두'));
        fields.forEach(f => chips.append(mk(f, f)));
        optionsEl.append(chips, toggle('이스케이프 그대로', state.keepEscapes, v => { state.keepEscapes = v; opts.saveSettings({ keepEscapes: v }); render(); }));
        state.fileExt = '.txt';
        state.fileTag = state.field === '__ALL__' ? 'details' : state.field;
        const pv = (v, f) => processValue(v, { readingMode: f === 'rawPrompt' && state.readingMode, spacing: state.spacing, keepEscapes: state.keepEscapes });
        let text = '';
        if (state.field === '__ALL__') for (const f of fields) text += formatField(f, pv(e.fields[f], f)) + '\n';
        else text = formatField(state.field, pv(e.fields[state.field], state.field));
        setBodyText(text || '(이 기록에는 세부 필드가 저장되지 않았습니다)');
    }

    function renderJsonTab() {
        optionsEl.append(el('span', { class: 'pr-muted' }, '저장된 기록을 손대지 않고 그대로 보여 줍니다.'));
        state.fileExt = '.json';
        state.fileTag = 'allData';
        setBodyText(toText(state.entry?.full), true);
    }

    function renderJsonlTab() {
        const e = state.entry;
        if (state.jsonlChar == null) state.jsonlChar = e?.meta?.charName || '{{char}}';
        if (state.jsonlUser == null) state.jsonlUser = e?.meta?.userName || '{{user}}';
        const charIn = el('input', { type: 'text', class: 'pr-input', placeholder: '캐릭터 이름', 'aria-label': '캐릭터 이름' });
        const userIn = el('input', { type: 'text', class: 'pr-input', placeholder: '사용자 이름', 'aria-label': '사용자 이름' });
        charIn.value = state.jsonlChar;
        userIn.value = state.jsonlUser;
        const update = () => {
            state.jsonlChar = charIn.value;
            state.jsonlUser = userIn.value;
            const t = generateJsonl(e?.rawPrompt, state.jsonlChar || '{{char}}', state.jsonlUser || '{{user}}', state.jsonlExcludeSystem);
            state.currentText = t;
            const target = body.querySelector('textarea') || body.querySelector('.pr-text');
            if (target) { if ('value' in target) target.value = t; else target.textContent = t; }
        };
        charIn.addEventListener('input', update);
        userIn.addEventListener('input', update);
        optionsEl.append(
            el('label', { class: 'pr-field-label' }, el('span', {}, '캐릭터'), charIn),
            el('label', { class: 'pr-field-label' }, el('span', {}, '사용자'), userIn),
            toggle('system 메시지 빼기', state.jsonlExcludeSystem, v => { state.jsonlExcludeSystem = v; render(); }));
        state.fileExt = '.jsonl';
        state.fileTag = 'import';
        setBodyText(generateJsonl(e?.rawPrompt, state.jsonlChar || '{{char}}', state.jsonlUser || '{{user}}', state.jsonlExcludeSystem), true);
    }

    function render() {
        optionsEl.replaceChildren();
        body.classList.remove('pr-compact');
        selectBtn.querySelector('span').textContent = state.selectMode ? '읽기 화면으로' : '텍스트 선택 모드';
        tabsEl.querySelectorAll('.pr-seg-btn').forEach(b => b.setAttribute('aria-selected', String(b.dataset.id === state.tab)));
        if (plain) {
            titleEl.textContent = opts.title || '보기';
            const v = views.find(x => x.id === state.tab) || views[0];
            state.fileExt = v.ext || '.txt';
            state.fileTag = v.tag || v.id;
            metaEl.hidden = true;
            optionsEl.hidden = true;
            setBodyText(v.text, !!v.mono);
            return;
        }
        const e = state.entry;
        titleEl.replaceChildren(el('span', {}, opts.title || ''), e ? el('span', { class: 'pr-v-no' }, `기록 #${e.ordinal}`) : null);
        if (opts.nav) {
            posInput.value = String(state.index + 1);
            posInput.max = String(opts.nav.total);
            posTotal.textContent = `/ ${opts.nav.total}`;
            prevBtn.disabled = state.index <= 0;
            nextBtn.disabled = state.index >= opts.nav.total - 1;
        }
        renderMeta();
        if (!e) { setBodyText('(기록 없음)'); return; }
        switch (state.tab) {
            case 'fields': renderFieldsTab(); break;
            case 'json': renderJsonTab(); break;
            case 'jsonl': renderJsonlTab(); break;
            default: renderPromptTab(); break;
        }
        optionsEl.hidden = !optionsEl.childElementCount;
    }

    if (!state.entry && opts.nav && !plain) state.entry = await opts.nav.load(state.index);
    render();

    const popup = new ctx.Popup(root, ctx.POPUP_TYPE.DISPLAY, '', { wide: true, large: true, allowVerticalScrolling: true, leftAlign: true, animation: 'fast' });
    await popup.show();
}
