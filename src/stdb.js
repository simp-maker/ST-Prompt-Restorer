// Read-only access to SillyTavern's own itemized prompt storage
// (IndexedDB "SillyTavern_Prompts", one array per chat id).

import { estimateBytes } from './utils.js';

// Chromium's in-memory IndexedDB backend (seen in incognito-style profiles)
// refuses a single value above this many bytes. SillyTavern keeps a whole chat's
// prompts in ONE value and swallows the save error, so such a chat silently stops
// saving new prompts.
export const CHROMIUM_IDB_VALUE_LIMIT = 133169152;

let store = null;

function getStore() {
    if (store) return store;
    const lf = SillyTavern?.libs?.localforage ?? window.localforage;
    if (!lf) throw new Error('localforage not available');
    store = lf.createInstance({ name: 'SillyTavern_Prompts' });
    return store;
}

export async function listStKeys() {
    return await getStore().keys();
}

export async function getStChat(key) {
    const value = await getStore().getItem(key);
    return Array.isArray(value) ? value : [];
}

export function summarizeStValue(value) {
    const arr = Array.isArray(value) ? value : [];
    const last = arr.length ? arr[arr.length - 1] : null;
    return {
        count: arr.length,
        bytes: estimateBytes(arr),
        hasPrompt: arr.some(e => e && e.rawPrompt != null && e.rawPrompt !== ''),
        descSnippet: last?.charDescription ? String(last.charDescription).slice(0, 1000) : '',
        lastMesId: last?.mesId ?? null,
    };
}

/**
 * Walks every stored chat one at a time (only one value in memory at once).
 * @param {(key: string, summary: object) => void} onItem
 * @param {() => boolean} shouldStop
 */
export async function scanStChats(onItem, shouldStop = () => false) {
    const keys = await listStKeys();
    for (const key of keys) {
        if (shouldStop()) return false;
        try {
            const value = await getStore().getItem(key);
            onItem(key, summarizeStValue(value));
        } catch (e) {
            onItem(key, { error: String(e?.message ?? e) });
        }
        // Yield to keep the UI responsive.
        await new Promise(r => setTimeout(r, 0));
    }
    return true;
}
