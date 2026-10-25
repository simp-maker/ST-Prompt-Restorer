// Normalizes prompt history from both storages into one shape the UI can use.
//
// Entry shape:
// {
//   source: 'ext' | 'st', key, id?, index (0-based chronological), ordinal (1-based),
//   mesId, ts, type, origin, rawPrompt, fields, full, meta: {...}
// }

import {
    countChatRecords,
    getChatRecordKeys,
    getChatRecordsPage,
    getLatestRecord,
    getRecord,
} from './db.js';
import { getStChat } from './stdb.js';

const stCache = new Map(); // key -> array (keeps the last few chats only)
const ST_CACHE_LIMIT = 3;

export function clearStCache() {
    stCache.clear();
}

export async function loadStArray(key) {
    if (stCache.has(key)) {
        const v = stCache.get(key);
        stCache.delete(key);
        stCache.set(key, v);
        return v;
    }
    const arr = await getStChat(key);
    stCache.set(key, arr);
    while (stCache.size > ST_CACHE_LIMIT) {
        stCache.delete(stCache.keys().next().value);
    }
    return arr;
}

export function normalizeExt(rec, index) {
    const details = rec.details || {};
    return {
        source: 'ext',
        key: rec.chatId,
        id: rec.id,
        index,
        ordinal: index + 1,
        mesId: rec.mesId,
        ts: rec.tsUnknown ? null : rec.ts,
        type: rec.type,
        origin: rec.origin,
        rawPrompt: rec.rawPrompt,
        fields: {
            rawPrompt: rec.rawPrompt,
            main_api: details.main_api ?? rec.mainApi,
            presetName: details.presetName ?? rec.presetName,
            ...details,
        },
        full: rec,
        meta: {
            charName: rec.charName,
            userName: rec.userName,
            model: rec.model,
            source: rec.source,
            mainApi: rec.mainApi,
            presetName: rec.presetName ?? details.presetName,
            size: rec.size,
            msgCount: rec.msgCount,
        },
    };
}

export function normalizeSt(entry, index, key) {
    const e = entry || {};
    return {
        source: 'st',
        key,
        id: null,
        index,
        ordinal: index + 1,
        mesId: e.mesId,
        ts: null,
        type: null,
        origin: 'st',
        rawPrompt: e.rawPrompt,
        fields: e,
        full: e,
        meta: {
            mainApi: e.main_api,
            presetName: e.presetName,
            msgCount: Array.isArray(e.rawPrompt) ? e.rawPrompt.length : null,
        },
    };
}

export async function countEntries(source, key) {
    if (source === 'ext') return await countChatRecords(key);
    return (await loadStArray(key)).length;
}

export async function getLatestEntry(source, key) {
    if (source === 'ext') {
        const rec = await getLatestRecord(key);
        if (!rec) return null;
        const total = await countChatRecords(key);
        return normalizeExt(rec, total - 1);
    }
    const arr = await loadStArray(key);
    if (!arr.length) return null;
    return normalizeSt(arr[arr.length - 1], arr.length - 1, key);
}

/** Newest first. `offset` counts from the newest entry. */
export async function getEntriesPage(source, key, offset, limit, total) {
    if (source === 'ext') {
        const recs = await getChatRecordsPage(key, offset, limit, 'prev');
        return recs.map((r, i) => normalizeExt(r, total - 1 - offset - i));
    }
    const arr = await loadStArray(key);
    const out = [];
    for (let i = arr.length - 1 - offset; i >= 0 && out.length < limit; i--) {
        out.push(normalizeSt(arr[i], i, key));
    }
    return out;
}

/**
 * Builds a navigator so the viewer can step through every entry of a chat.
 * @returns {Promise<{ total: number, load: (index: number) => Promise<object|null> }>}
 */
export async function createNavigator(source, key) {
    if (source === 'ext') {
        const keys = await getChatRecordKeys(key);
        return {
            total: keys.length,
            indexOfId: (id) => keys.findIndex(k => k.id === id),
            load: async (index) => {
                const k = keys[index];
                if (!k) return null;
                const rec = await getRecord(k.id);
                return rec ? normalizeExt(rec, index) : null;
            },
        };
    }
    const arr = await loadStArray(key);
    return {
        total: arr.length,
        indexOfId: () => -1,
        load: async (index) => (arr[index] ? normalizeSt(arr[index], index, key) : null),
    };
}
