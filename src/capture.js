// Captures every outgoing prompt into the extension's own IndexedDB,
// independently of SillyTavern's itemized-prompt storage.

import { addRecord, pruneChat, updateRecord } from './db.js';
import { deepClone, estimateBytes, hashPrompt, stripDataUris } from './utils.js';

// Fields of SillyTavern's itemized prompt that duplicate the raw prompt or the
// chat history; skipped to keep records small.
const DETAIL_EXCLUDE = new Set(['rawPrompt', 'finalPrompt', 'mesSendString', 'generatedPromptCache', 'mesId']);

let pendingGeneration = null;
let itemizedSource = null;
let getModel = null;
const listeners = new Set();

export function onCaptured(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function notify(info) {
    for (const fn of listeners) {
        try { fn(info); } catch (e) { console.error(e); }
    }
}

function getItemizedArray() {
    try {
        const arr = itemizedSource?.itemizedPrompts;
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

export function pickDetails(entry) {
    const out = {};
    if (!entry || typeof entry !== 'object') return out;
    for (const [k, v] of Object.entries(entry)) {
        if (DETAIL_EXCLUDE.has(k)) continue;
        if (v === undefined || typeof v === 'function') continue;
        out[k] = v;
    }
    return deepClone(out);
}

function describeChat(ctx) {
    const isGroup = !!ctx.groupId;
    let charName = ctx.name2;
    let groupName = null;
    let avatar = null;
    if (isGroup) {
        const group = ctx.groups?.find(g => String(g.id) === String(ctx.groupId));
        groupName = group?.name ?? null;
        charName = groupName || charName;
    } else if (ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]) {
        const ch = ctx.characters[ctx.characterId];
        charName = ch.name ?? charName;
        avatar = ch.avatar ?? null;
    }
    return { isGroup, groupId: ctx.groupId ?? null, charName, groupName, avatar };
}

function currentModel(ctx) {
    try {
        if (ctx.mainApi === 'openai' && typeof getModel === 'function') {
            return getModel() || null;
        }
        const status = ctx.onlineStatus;
        return typeof status === 'string' && status !== 'no_connection' ? status : null;
    } catch {
        return null;
    }
}

async function waitForItemized(rawRef, mesId, previous) {
    for (let i = 0; i < 100; i++) {
        const arr = getItemizedArray();
        let found = arr.find(x => x && x.rawPrompt === rawRef);
        if (!found) {
            found = arr.find(x => x && Number(x.mesId) === Number(mesId) && x !== previous && x.rawPrompt != null);
        }
        if (found) return found;
        await new Promise(r => setTimeout(r, i < 20 ? 50 : 200));
    }
    return null;
}

async function persist(record, rawRef, previous, settings) {
    let id;
    try {
        id = await addRecord(record);
    } catch (e) {
        console.error('[PromptRestorer] Failed to save prompt', e);
        toastr?.error?.(`프롬프트 저장 실패: ${e?.message ?? e}`, '프롬프트 복원기');
        return;
    }
    notify({ chatId: record.chatId, id, stage: 'saved' });

    try {
        const entry = await waitForItemized(rawRef, record.mesId, previous);
        if (entry) {
            const patch = {
                presetName: entry.presetName || null,
                tokenizer: entry.tokenizer || null,
            };
            if (settings.saveDetails) {
                const details = pickDetails(entry);
                if (settings.stripMedia) Object.assign(details, stripDataUris(details));
                patch.details = details;
                patch.size = record.size + estimateBytes(details);
                if (details.charDescription) patch.descSnippet = String(details.charDescription).slice(0, 1000);
            }
            await updateRecord(id, patch);
            notify({ chatId: record.chatId, id, stage: 'details' });
        }
    } catch (e) {
        console.warn('[PromptRestorer] Could not attach prompt details', e);
    }

    try {
        if (settings.maxPerChat > 0) {
            const removed = await pruneChat(record.chatId, settings.maxPerChat);
            if (removed) notify({ chatId: record.chatId, stage: 'pruned' });
        }
    } catch (e) {
        console.warn('[PromptRestorer] Prune failed', e);
    }
}

/**
 * @param {object} opts
 * @param {() => object} opts.getSettings
 * @param {object|null} opts.itemizedModule module namespace exposing `itemizedPrompts`
 * @param {Function|null} opts.getChatCompletionModel
 */
export function initCapture({ getSettings, itemizedModule, getChatCompletionModel }) {
    itemizedSource = itemizedModule;
    getModel = getChatCompletionModel;
    const ctx = SillyTavern.getContext();
    const { eventSource, eventTypes } = ctx;

    eventSource.on(eventTypes.GENERATION_STARTED, (type, _params, dryRun) => {
        if (dryRun) return;
        pendingGeneration = { type: type || 'normal', at: Date.now() };
    });

    const onAfterData = (generateData, dryRun) => {
        if (dryRun) return;
        const settings = getSettings();
        const gen = pendingGeneration;
        pendingGeneration = null;
        if (!settings.captureEnabled) return;

        const type = gen?.type ?? 'unknown';
        if (type === 'quiet' && !settings.captureQuiet) return;
        if (type === 'impersonate' && !settings.captureImpersonate) return;

        const rawRef = generateData?.prompt ?? generateData?.input;
        if (rawRef == null || (typeof rawRef === 'string' && !rawRef.length)) return;

        const c = SillyTavern.getContext();
        const chatId = c.getCurrentChatId?.() ?? c.chatId ?? null;
        if (!chatId && !settings.captureNoChat) return;

        let rawPrompt = deepClone(rawRef);
        if (settings.stripMedia) rawPrompt = stripDataUris(rawPrompt);

        const chatLength = Array.isArray(c.chat) ? c.chat.length : 0;
        const mesId = type === 'swipe' ? chatLength - 1 : chatLength;
        const previous = getItemizedArray().find(x => x && Number(x.mesId) === mesId) ?? null;
        const who = describeChat(c);

        const record = {
            chatId: chatId || '(채팅 없음)',
            ts: Date.now(),
            origin: 'capture',
            type,
            mesId,
            chatLength,
            ...who,
            userName: c.name1 ?? null,
            mainApi: c.mainApi ?? null,
            source: c.mainApi === 'openai' ? (c.chatCompletionSettings?.chat_completion_source ?? null) : null,
            model: currentModel(c),
            promptFormat: Array.isArray(rawPrompt) ? 'chat' : 'text',
            msgCount: Array.isArray(rawPrompt) ? rawPrompt.length : null,
            rawPrompt,
            details: null,
            hash: hashPrompt(rawPrompt),
        };
        record.size = estimateBytes(rawPrompt);

        // Don't hold up the generation request: write in the background.
        setTimeout(() => persist(record, rawRef, previous, settings), 0);
    };

    // Run after other extensions had their chance to modify the prompt.
    if (typeof eventSource.makeLast === 'function') {
        eventSource.makeLast(eventTypes.GENERATE_AFTER_DATA, onAfterData);
    } else {
        eventSource.on(eventTypes.GENERATE_AFTER_DATA, onAfterData);
    }
}
