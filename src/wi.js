// World-info deletion backup.
//
// - Book deletion: SillyTavern has no event for it, so the extension wraps `fetch`
//   and, right before a POST to /api/worldinfo/delete goes out, downloads the book and
//   stores it. Renames (save under new name + delete old name) are recognised and skipped.
// - Entry deletion: after every save SillyTavern emits WORLDINFO_UPDATED(name, data).
//   The extension remembers the entry objects of each book (references, no copies) and
//   backs up any entry that disappeared. The first save of a book in a session has no
//   previous state yet, so that one save fetches the old file from the server first.

import { addWiBackup, deleteWiBackups, listWiBackups, pruneWiBackups } from './db.js';
import { deepClone } from './utils.js';

const known = new Map();      // book -> Map(uid -> entry object reference)
const pendingOld = new Map(); // book -> Promise<old book data>
const recentSaves = new Map(); // book -> { fp, at } fingerprint of the last save
let getSettings = () => ({});
const listeners = new Set();

export function onWiBackup(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function notify(info) {
    for (const fn of listeners) { try { fn(info); } catch (e) { console.error(e); } }
}

function enabled() {
    return getSettings().wiBackup !== false;
}

function entryTitle(entry) {
    const comment = String(entry?.comment ?? '').trim();
    if (comment) return comment.slice(0, 120);
    const keys = Array.isArray(entry?.key) ? entry.key.filter(Boolean).join(', ') : '';
    if (keys) return keys.slice(0, 120);
    const first = String(entry?.content ?? '').split('\n').find(l => l.trim()) || '';
    return first.slice(0, 80) || `엔트리 ${entry?.uid ?? ''}`;
}

function fingerprint(data) {
    const entries = data?.entries && typeof data.entries === 'object' ? data.entries : {};
    const uids = Object.keys(entries).sort();
    let len = 0;
    for (const u of uids) len += String(entries[u]?.content ?? '').length;
    return `${uids.length}|${uids.join(',')}|${len}`;
}

async function fetchBook(origFetch, name) {
    const ctx = SillyTavern.getContext();
    const res = await origFetch('/api/worldinfo/get', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ name }),
        cache: 'no-cache',
    });
    if (!res.ok) return { entries: {} };
    const data = await res.json();
    return data && typeof data === 'object' ? data : { entries: {} };
}

function nameFromEditBody(body) {
    if (typeof body !== 'string') return null;
    const m = body.slice(0, 2048).match(/^\{"name":("(?:[^"\\]|\\.)*")/);
    if (m) {
        try { return JSON.parse(m[1]); } catch { /* fall through */ }
    }
    try { return JSON.parse(body)?.name ?? null; } catch { return null; }
}

async function backupEntries(book, copies, reason) {
    for (const copy of copies) {
        await addWiBackup({
            ts: Date.now(),
            kind: 'entry',
            book,
            uid: copy?.uid ?? null,
            title: entryTitle(copy),
            keys: Array.isArray(copy?.key) ? copy.key.slice(0, 20).map(String) : [],
            reason,
        }, copy);
    }
    if (copies.length) {
        notify({ kind: 'entry', book, count: copies.length });
        toastr?.info?.(`월드인포 "${book}"에서 지운 엔트리 ${copies.length}개를 백업했습니다.`, '프롬프트 복원기', { timeOut: 2500 });
    }
}

function rememberBook(name, data) {
    const entries = data?.entries && typeof data.entries === 'object' ? data.entries : {};
    const map = new Map();
    for (const [uid, entry] of Object.entries(entries)) map.set(uid, entry);
    known.set(name, map);
}

async function onWorldInfoUpdated(name, data) {
    if (!name || !data) return;
    recentSaves.set(name, { fp: fingerprint(data), at: Date.now() });
    if (!enabled()) { known.delete(name); return; }
    const entries = data.entries && typeof data.entries === 'object' ? data.entries : {};
    try {
        let removed = [];
        if (pendingOld.has(name)) {
            const old = await pendingOld.get(name).catch(() => null);
            pendingOld.delete(name);
            const oldEntries = old?.entries && typeof old.entries === 'object' ? old.entries : {};
            removed = Object.keys(oldEntries).filter(uid => !(uid in entries)).map(uid => oldEntries[uid]);
        } else if (known.has(name)) {
            const prev = known.get(name);
            removed = [...prev.keys()].filter(uid => !(uid in entries)).map(uid => prev.get(uid));
        }
        rememberBook(name, data);
        if (removed.length) {
            // Copy now (synchronously), write in the background so the save is not held up.
            const copies = removed.filter(Boolean).map(e => deepClone(e));
            setTimeout(() => backupEntries(name, copies, 'entry-deleted').catch(e => console.error('[PromptRestorer] world-info entry backup failed', e)), 0);
        }
    } catch (e) {
        console.error('[PromptRestorer] world-info entry backup failed', e);
    }
}

async function beforeBookDelete(origFetch, name) {
    const old = await fetchBook(origFetch, name);
    known.delete(name);
    pendingOld.delete(name);
    const entryCount = Object.keys(old?.entries || {}).length;
    // Rename = the same content was just saved under another name.
    const fp = fingerprint(old);
    for (const [other, info] of recentSaves) {
        if (other !== name && info.fp === fp && Date.now() - info.at < 20000) {
            console.debug(`[PromptRestorer] "${name}" looks renamed to "${other}", no backup needed.`);
            return;
        }
    }
    if (!entryCount && !old?.originalData) return;
    await addWiBackup({
        ts: Date.now(),
        kind: 'book',
        book: name,
        uid: null,
        title: name,
        keys: [],
        entryCount,
        reason: 'book-deleted',
    }, old);
    notify({ kind: 'book', book: name });
    toastr?.info?.(`월드인포 북 "${name}"을(를) 삭제 전에 백업했습니다.`, '프롬프트 복원기', { timeOut: 3000 });
}

function installFetchHook() {
    if (window.__promptRestorerFetchHook) return;
    const origFetch = window.fetch.bind(window);
    window.__promptRestorerFetchHook = true;
    window.fetch = async function (input, init) {
        try {
            const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : null);
            const method = String(init?.method || 'GET').toUpperCase();
            if (url && method === 'POST' && enabled()) {
                const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
                if (path === '/api/worldinfo/delete') {
                    let name = null;
                    try { name = JSON.parse(init.body)?.name; } catch { /* ignore */ }
                    if (name) {
                        try { await beforeBookDelete(origFetch, name); } catch (e) { console.error('[PromptRestorer] book backup failed', e); }
                    }
                } else if (path === '/api/worldinfo/edit') {
                    const name = nameFromEditBody(init?.body);
                    if (name && !known.has(name) && !pendingOld.has(name)) {
                        const p = fetchBook(origFetch, name);
                        pendingOld.set(name, p);
                        await p.catch(() => null); // the old file must be read before it is overwritten
                    }
                }
            }
        } catch (e) {
            console.error('[PromptRestorer] fetch hook error', e);
        }
        return origFetch(input, init);
    };
}

export function initWorldInfoBackup(opts) {
    getSettings = opts.getSettings;
    installFetchHook();
    const { eventSource, eventTypes } = SillyTavern.getContext();
    if (eventTypes.WORLDINFO_UPDATED) eventSource.on(eventTypes.WORLDINFO_UPDATED, onWorldInfoUpdated);
    const days = Number(getSettings().wiRetentionDays) || 0;
    if (days > 0) pruneWiBackups(days).catch(() => { });
}

// ------------------------------------------------------------ restore

function freeUid(entries) {
    const used = Object.keys(entries || {}).map(Number).filter(Number.isFinite);
    return used.length ? Math.max(...used) + 1 : 0;
}

/**
 * Puts a backed-up entry back into a book (the book is created if it no longer exists).
 * @returns {Promise<number>} uid of the restored entry
 */
export async function restoreEntry(entry, bookName) {
    const ctx = SillyTavern.getContext();
    const names = ctx.getWorldInfoNames?.() ?? [];
    let data = names.includes(bookName) ? await ctx.loadWorldInfo(bookName) : null;
    if (!data || typeof data !== 'object') data = { entries: {} };
    if (!data.entries) data.entries = {};
    const uid = freeUid(data.entries);
    data.entries[uid] = { ...deepClone(entry), uid };
    await ctx.saveWorldInfo(bookName, data, true);
    if (!names.includes(bookName)) await ctx.updateWorldInfoList?.();
    ctx.reloadWorldInfoEditor?.(bookName);
    return uid;
}

/**
 * Restores a whole book. Uses a new name when a book with that name exists.
 * @returns {Promise<string>} the name it was restored under
 */
export async function restoreBook(data, bookName) {
    const ctx = SillyTavern.getContext();
    const names = ctx.getWorldInfoNames?.() ?? [];
    let name = bookName;
    if (names.includes(name)) {
        const d = new Date();
        const pad = (x) => String(x).padStart(2, '0');
        name = `${bookName} (복원 ${d.getMonth() + 1}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())})`;
        let n = 2;
        while (names.includes(name)) name = `${bookName} (복원 ${n++})`;
    }
    await ctx.saveWorldInfo(name, deepClone(data), true);
    await ctx.updateWorldInfoList?.();
    return name;
}

export { listWiBackups, deleteWiBackups, entryTitle };
