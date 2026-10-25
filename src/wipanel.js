// "월드인포 백업" panel inside the main window.

import { decodeWi, deleteWiBackups, getStorageStats, getWiBody, listWiBackups } from './db.js';
import { entryTitle, restoreBook, restoreEntry } from './wi.js';
import { openViewer } from './viewer.js';
import { copyText, downloadText, el, formatBytes, formatDate, formatShortDate, icon, iconButton, safeFileName } from './utils.js';

const ui = { kind: 'all', term: '', open: new Set(), restoreFor: null };
let currentTheme = 'st';

const POSITION_LABELS = ['캐릭터 정의 앞', '캐릭터 정의 뒤', '작가 노트 위', '작가 노트 아래', '깊이 지정', '예시 앞', '예시 뒤', '아웃렛'];

export function formatEntryReadable(entry) {
    const e = entry || {};
    const lines = [];
    lines.push(`제목: ${e.comment || '(없음)'}`);
    if (Array.isArray(e.key) && e.key.length) lines.push(`키: ${e.key.join(', ')}`);
    if (Array.isArray(e.keysecondary) && e.keysecondary.length) lines.push(`보조 키: ${e.keysecondary.join(', ')}`);
    const flags = [];
    if (e.constant) flags.push('항상 켜짐');
    if (e.disable) flags.push('꺼짐');
    if (e.order != null) flags.push(`순서 ${e.order}`);
    if (e.position != null) flags.push(POSITION_LABELS[e.position] || `위치 ${e.position}`);
    if (e.position === 4 && e.depth != null) flags.push(`깊이 ${e.depth}`);
    if (flags.length) lines.push(`설정: ${flags.join(', ')}`);
    lines.push('', String(e.content ?? ''));
    return lines.join('\n');
}

function formatBookReadable(data) {
    const entries = Object.values(data?.entries || {});
    entries.sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0));
    return entries.map((e, i) => `━━━━ ${i + 1}. ${entryTitle(e)} ━━━━\n${formatEntryReadable(e)}`).join('\n\n');
}

/** Lists entry titles of a book backup without loading their content. */
function bookEntryIndex(enc) {
    const entries = enc?.o?.entries?.o || {};
    return Object.entries(entries).map(([uid, e]) => {
        const o = e?.o || {};
        const comment = o.comment?.v ?? '';
        const keys = (o.key?.a || []).map(k => k?.v).filter(v => typeof v === 'string');
        return { uid, title: String(comment || keys.join(', ') || `엔트리 ${uid}`).slice(0, 120), keys, enc: e };
    });
}

async function viewData(title, data, isBook, name) {
    const readable = isBook ? formatBookReadable(data) : formatEntryReadable(data);
    await openViewer({
        title,
        chatName: name,
        views: [
            { id: 'read', label: '읽기', text: readable, ext: '.txt', tag: isBook ? 'book' : 'entry' },
            { id: 'json', label: 'JSON', text: JSON.stringify(data, null, 2), ext: '.json', tag: isBook ? 'book' : 'entry', mono: true },
        ],
        getSettings: () => ({ theme: currentTheme }),
        saveSettings: () => { },
    });
}

export async function renderWiPanel(container, { getSettings, setStatus }) {
    currentTheme = getSettings().theme || 'st';
    const all = await listWiBackups();
    const stats = await getStorageStats().catch(() => null);
    const term = ui.term.toLowerCase();
    const items = all.filter(b => (ui.kind === 'all' || b.kind === ui.kind)
        && (!term || `${b.title}\n${b.book}\n${(b.keys || []).join(' ')}`.toLowerCase().includes(term)));

    const rerender = () => renderWiPanel(container, { getSettings, setStatus });

    const search = el('input', { type: 'search', class: 'pr-input pr-search-input', placeholder: '북 이름, 엔트리 제목, 키로 찾기', value: ui.term });
    search.value = ui.term;
    search.addEventListener('input', () => {
        ui.term = search.value;
        clearTimeout(search._t);
        search._t = setTimeout(() => rerender().then(() => {
            const s = container.querySelector('.pr-search-input');
            s?.focus();
            s?.setSelectionRange?.(s.value.length, s.value.length);
        }), 200);
    });
    const kindSeg = el('div', { class: 'pr-seg pr-seg-small', role: 'tablist' });
    for (const [id, label] of [['all', '전체'], ['book', '북'], ['entry', '엔트리']]) {
        const b = el('button', { class: 'pr-seg-btn', type: 'button', role: 'tab', 'aria-selected': String(ui.kind === id) }, el('span', {}, label));
        b.addEventListener('click', () => { ui.kind = id; rerender(); });
        kindSeg.append(b);
    }
    const clearBtn = el('button', { class: 'pr-btn pr-btn-quiet pr-btn-danger', type: 'button', title: '월드인포 백업을 모두 지웁니다' }, icon('fa-trash-can'), el('span', {}, '모두 지우기'));
    clearBtn.disabled = !all.length;
    clearBtn.addEventListener('click', async () => {
        const ctx = SillyTavern.getContext();
        const ok = await ctx.callGenericPopup(`월드인포 백업 ${all.length}개를 모두 지울까요? 되돌릴 수 없습니다.`, ctx.POPUP_TYPE.CONFIRM);
        if (!ok) return;
        await deleteWiBackups(all.map(b => b.id));
        setStatus('월드인포 백업을 모두 지웠습니다.');
        rerender();
    });

    const list = el('div', { class: 'pr-wi-list' });
    for (const b of items) list.append(renderItem(b, { rerender, setStatus }));
    if (!items.length) {
        list.append(el('div', { class: 'pr-empty' }, all.length
            ? '조건에 맞는 백업이 없습니다.'
            : getSettings().wiBackup === false
                ? '월드인포 삭제 백업이 꺼져 있습니다. 확장 설정에서 켤 수 있습니다.'
                : '아직 백업이 없습니다. 월드인포 북이나 엔트리를 지우면 지우기 직전 내용이 여기에 저장됩니다.'));
    }

    const parts = [`백업 ${all.length}개`];
    if (stats) parts.push(`실제 사용 공간 ${formatBytes(stats.wiStoredBytes)}`);
    if (getSettings().wiRetentionDays > 0) parts.push(`${getSettings().wiRetentionDays}일 지난 백업은 자동으로 지웁니다`);
    const foot = el('div', { class: 'pr-wi-foot' }, parts.join(', '));

    container.replaceChildren(
        el('div', { class: 'pr-toolbar' }, el('div', { class: 'pr-search' }, icon('fa-magnifying-glass'), search), kindSeg, clearBtn),
        list,
        foot);
}

function renderItem(b, { rerender, setStatus }) {
    const isBook = b.kind === 'book';
    const meta = el('div', { class: 'pr-row-meta' },
        el('span', { class: `pr-chip ${isBook ? 'pr-chip-book' : ''}` }, isBook ? '북 전체' : '엔트리'));
    if (!isBook) meta.append(el('span', { class: 'pr-chip', title: '원래 있던 북' }, icon('fa-book'), b.book));
    if (isBook) meta.append(el('span', { class: 'pr-chip' }, `엔트리 ${b.entryCount ?? 0}개`));
    for (const k of (b.keys || []).slice(0, 3)) meta.append(el('span', { class: 'pr-chip pr-chip-key' }, k));
    meta.append(el('span', { class: 'pr-chip', title: `원래 크기 ${formatBytes(b.size)}, 이 백업으로 새로 쓴 공간 ${formatBytes(b.stored)}` }, formatBytes(b.size)));
    meta.append(el('span', { class: 'pr-chip', title: formatDate(b.ts) }, formatShortDate(b.ts)));

    const load = async () => decodeWi(await getWiBody(b.id));
    const actions = el('div', { class: 'pr-wi-actions' },
        iconButton('fa-eye', '내용 보기', async () => viewData(b.title, await load(), isBook, b.book), 'pr-ib-primary'),
        iconButton('fa-rotate-left', isBook ? '북 되살리기' : '엔트리 다시 넣기', async () => {
            if (isBook) {
                const data = await load();
                const name = await restoreBook(data, b.book);
                setStatus(`북을 "${name}"(으)로 되살렸습니다.`);
                toastr?.success?.(`"${name}"(으)로 되살렸습니다.`, '프롬프트 복원기');
            } else {
                ui.restoreFor = ui.restoreFor === b.id ? null : b.id;
                rerender();
            }
        }),
        iconButton('fa-copy', 'JSON 복사', async () => {
            const ok = await copyText(JSON.stringify(await load(), null, 2));
            setStatus(ok ? '복사했습니다.' : '복사하지 못했습니다. 내용 보기에서 텍스트 선택 모드를 쓰세요.', ok ? '' : 'error');
        }),
        iconButton('fa-download', '.json으로 받기 (SillyTavern에서 가져오기 가능)', async () => {
            const data = await load();
            const file = `${safeFileName(b.book, isBook ? 'backup' : b.title)}${isBook ? '' : '_entry'}.json`;
            const ok = downloadText(file, JSON.stringify(isBook ? data : { entries: { 0: { ...data, uid: 0 } } }, null, 4), 'application/json');
            setStatus(ok ? `${file} 받기를 시작했습니다.` : '이 브라우저에서는 파일을 받을 수 없습니다. 복사를 쓰세요.', ok ? '' : 'error');
        }),
        iconButton('fa-trash-can', '이 백업 지우기', async () => {
            const ctx = SillyTavern.getContext();
            const ok = await ctx.callGenericPopup(`"${b.title}" 백업을 지울까요?`, ctx.POPUP_TYPE.CONFIRM);
            if (!ok) return;
            await deleteWiBackups([b.id]);
            rerender();
        }, 'pr-ib-danger'));

    const item = el('article', { class: `pr-wi-item ${isBook ? 'pr-wi-book' : 'pr-wi-entry'}` },
        el('span', { class: 'pr-wi-icon' }, icon(isBook ? 'fa-book' : 'fa-file-lines')),
        el('div', { class: 'pr-wi-main' }, el('div', { class: 'pr-row-name', title: b.title }, b.title), meta),
        actions);

    if (!isBook && ui.restoreFor === b.id) item.append(restorePanel(b, load, { rerender, setStatus }));

    if (isBook) {
        const open = ui.open.has(b.id);
        const toggle = el('button', { class: 'pr-link pr-wi-expand', type: 'button', 'aria-expanded': String(open) },
            icon(open ? 'fa-chevron-up' : 'fa-chevron-down'), el('span', {}, open ? '엔트리 접기' : '엔트리 펼쳐서 하나씩 보기'));
        toggle.addEventListener('click', () => { if (open) ui.open.delete(b.id); else ui.open.add(b.id); rerender(); });
        item.append(toggle);
        if (open) item.append(bookEntries(b, { setStatus }));
    }
    return item;
}

function restorePanel(b, load, { rerender, setStatus }) {
    const ctx = SillyTavern.getContext();
    const names = ctx.getWorldInfoNames?.() ?? [];
    const select = el('select', { class: 'pr-input pr-select' });
    if (!names.includes(b.book)) select.append(el('option', { value: b.book }, `${b.book} (새로 만들기)`));
    for (const n of names) select.append(el('option', { value: n }, n));
    select.value = b.book;
    const go = el('button', { class: 'pr-btn pr-btn-primary', type: 'button' }, icon('fa-rotate-left'), el('span', {}, '이 북에 넣기'));
    go.addEventListener('click', async () => {
        go.disabled = true;
        try {
            const entry = await load();
            const uid = await restoreEntry(entry, select.value);
            setStatus(`"${b.title}"을(를) "${select.value}"에 다시 넣었습니다 (uid ${uid}).`);
            toastr?.success?.(`"${select.value}"에 다시 넣었습니다.`, '프롬프트 복원기');
            ui.restoreFor = null;
            rerender();
        } catch (e) {
            console.error(e);
            setStatus(`다시 넣지 못했습니다: ${e?.message ?? e}`, 'error');
            go.disabled = false;
        }
    });
    return el('div', { class: 'pr-restore' }, el('span', {}, '넣을 북'), select, go,
        el('button', { class: 'pr-btn pr-btn-quiet', type: 'button', onclick: () => { ui.restoreFor = null; rerender(); } }, '취소'));
}

function bookEntries(b, { setStatus }) {
    const box = el('div', { class: 'pr-wi-entries' }, el('div', { class: 'pr-hint' }, '불러오는 중…'));
    (async () => {
        const enc = await getWiBody(b.id);
        const rows = bookEntryIndex(enc);
        const filter = el('input', { type: 'search', class: 'pr-input', placeholder: `엔트리 ${rows.length}개에서 찾기` });
        const list = el('div', { class: 'pr-wi-entry-list' });
        const draw = () => {
            const t = filter.value.trim().toLowerCase();
            list.replaceChildren(...rows.filter(r => !t || `${r.title} ${r.keys.join(' ')}`.toLowerCase().includes(t)).slice(0, 300).map(r => {
                const entryLoad = () => decodeWi(r.enc);
                return el('div', { class: 'pr-wi-entry-row' },
                    el('span', { class: 'pr-row-name', title: r.title }, r.title),
                    el('span', { class: 'pr-wi-entry-keys' }, r.keys.slice(0, 4).join(', ')),
                    el('span', { class: 'pr-wi-entry-actions' },
                        iconButton('fa-eye', '보기', async () => viewData(r.title, await entryLoad(), false, b.book)),
                        iconButton('fa-rotate-left', '이 엔트리만 다시 넣기', async () => {
                            const ctx = SillyTavern.getContext();
                            const names = ctx.getWorldInfoNames?.() ?? [];
                            const target = names.includes(b.book) ? b.book : names[0];
                            if (!target) { setStatus('넣을 월드인포 북이 없습니다. 먼저 북을 되살리세요.', 'error'); return; }
                            const ok = await ctx.callGenericPopup(`"${r.title}"을(를) "${target}" 북에 넣을까요?`, ctx.POPUP_TYPE.CONFIRM);
                            if (!ok) return;
                            await restoreEntry(await entryLoad(), target);
                            setStatus(`"${r.title}"을(를) "${target}"에 넣었습니다.`);
                        })));
            }));
            if (rows.length > 300 && !t) list.append(el('div', { class: 'pr-hint' }, `처음 300개만 보여 줍니다. 검색으로 좁혀 보세요.`));
        };
        filter.addEventListener('input', draw);
        draw();
        box.replaceChildren(filter, list);
    })().catch(e => box.replaceChildren(el('div', { class: 'pr-hint pr-error' }, `불러오지 못했습니다: ${e.message}`)));
    return box;
}
