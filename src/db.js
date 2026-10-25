// Extension-owned IndexedDB storage with de-duplication.
//
// v1 (extension 3.0) stored every prompt in full. v2 splits prompts into chunks
// (see chunks.js), stores each distinct chunk once with a reference count, and keeps
// only a small chunk list per record. Old v1 records are still readable and are
// converted in the background by migrateLegacy().
//
// Stores
//   records   prompt records (metadata + `enc`)            keyPath id (auto)
//   chats     per-chat summary                             keyPath chatId
//   chunks    prompt chunks {h, t, r (refs), b (bytes)}    keyPath h
//   wi        world-info backup metadata                   keyPath id (auto)
//   wibody    world-info backup content {id, enc}          keyPath id
//   wichunks  world-info chunks                            keyPath h
//   meta      counters / flags                             keyPath k

import { TextPool, baseKey, collectRefs, decodeValue, encodeValue, mapRefs } from './chunks.js';
import { estimateBytes } from './utils.js';

const DB_NAME = 'ST_PromptRestorer';
const DB_VERSION = 2;
export const STORE_RECORDS = 'records';
export const STORE_CHATS = 'chats';
const STORE_CHUNKS = 'chunks';
const STORE_WI = 'wi';
const STORE_WIBODY = 'wibody';
const STORE_WICHUNKS = 'wichunks';
const STORE_META = 'meta';

let dbPromise = null;

export function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        let req;
        try {
            req = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (e) {
            dbPromise = null;
            reject(e);
            return;
        }
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_RECORDS)) {
                const s = db.createObjectStore(STORE_RECORDS, { keyPath: 'id', autoIncrement: true });
                s.createIndex('chatId', 'chatId', { unique: false });
                s.createIndex('chatId_ts', ['chatId', 'ts'], { unique: false });
                s.createIndex('chatId_hash', ['chatId', 'hash'], { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_CHATS)) db.createObjectStore(STORE_CHATS, { keyPath: 'chatId' });
            if (!db.objectStoreNames.contains(STORE_CHUNKS)) db.createObjectStore(STORE_CHUNKS, { keyPath: 'h' });
            if (!db.objectStoreNames.contains(STORE_WI)) {
                const s = db.createObjectStore(STORE_WI, { keyPath: 'id', autoIncrement: true });
                s.createIndex('ts', 'ts', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_WIBODY)) db.createObjectStore(STORE_WIBODY, { keyPath: 'id' });
            if (!db.objectStoreNames.contains(STORE_WICHUNKS)) db.createObjectStore(STORE_WICHUNKS, { keyPath: 'h' });
            if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'k' });
        };
        req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => { db.close(); dbPromise = null; };
            db.onclose = () => { dbPromise = null; };
            resolve(db);
        };
        req.onerror = () => { dbPromise = null; reject(req.error); };
        req.onblocked = () => console.warn('[PromptRestorer] DB upgrade blocked by another open tab. Close other SillyTavern tabs.');
    });
    return dbPromise;
}

function reqP(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function txDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
}

function chatRange(chatId) {
    return IDBKeyRange.bound([chatId, -Infinity], [chatId, Infinity]);
}

// ------------------------------------------------------------ chunk refcounts

/**
 * Inside an open transaction: resolve every pool text to a chunk key (re-using
 * existing identical chunks), then call `done(keys, created)` where `created` lists
 * the keys of chunks that did not exist yet (they are NOT written yet).
 */
function resolvePool(chunkStore, pool, done) {
    const n = pool.texts.length;
    const keys = new Array(n);
    const existing = new Array(n);
    if (!n) { done(keys, existing); return; }
    let pending = n;
    const claimed = new Map(); // key -> text index claimed in this transaction
    const tryResolve = (i, attempt) => {
        const text = pool.texts[i];
        const k = attempt ? `${baseKey(text)}~${attempt}` : baseKey(text);
        const other = claimed.get(k);
        if (other !== undefined && pool.texts[other] !== text) { tryResolve(i, attempt + 1); return; }
        chunkStore.get(k).onsuccess = (e) => {
            const ex = e.target.result;
            if (ex && ex.t !== text) { tryResolve(i, attempt + 1); return; }
            if (!ex) {
                const again = claimed.get(k);
                if (again !== undefined && again !== i && pool.texts[again] !== text) { tryResolve(i, attempt + 1); return; }
            }
            claimed.set(k, i);
            keys[i] = k;
            existing[i] = ex || null;
            if (--pending === 0) done(keys, existing);
        };
    };
    for (let i = 0; i < n; i++) tryResolve(i, 0);
}

/**
 * Adjusts refcounts: +1 for keys in `add`, -1 for keys in `remove`.
 * `newTexts` maps key -> text for chunks that may need creating.
 * Calls `done({ createdBytes, createdCount, freedBytes, freedCount })`.
 */
function applyRefs(chunkStore, add, remove, newTexts, done) {
    const stats = { createdBytes: 0, createdCount: 0, freedBytes: 0, freedCount: 0 };
    const ops = [];
    for (const k of add) if (!remove.has(k)) ops.push([k, 1]);
    for (const k of remove) if (!add.has(k)) ops.push([k, -1]);
    if (!ops.length) { done(stats); return; }
    let pending = ops.length;
    for (const [k, delta] of ops) {
        chunkStore.get(k).onsuccess = (e) => {
            const ex = e.target.result;
            if (delta > 0) {
                if (ex) {
                    ex.r = (ex.r || 0) + 1;
                    chunkStore.put(ex);
                } else {
                    const t = newTexts.get(k);
                    if (t !== undefined) {
                        const b = estimateBytes(t);
                        chunkStore.put({ h: k, t, r: 1, b });
                        stats.createdBytes += b;
                        stats.createdCount++;
                    } else {
                        console.warn('[PromptRestorer] reference to unknown chunk', k);
                    }
                }
            } else if (ex) {
                ex.r = (ex.r || 0) - 1;
                if (ex.r <= 0) {
                    chunkStore.delete(k);
                    stats.freedBytes += ex.b || 0;
                    stats.freedCount++;
                } else {
                    chunkStore.put(ex);
                }
            }
            if (--pending === 0) done(stats);
        };
    }
}

function bumpStats(metaStore, key, s) {
    metaStore.get(key).onsuccess = (e) => {
        const m = e.target.result || { k: key, bytes: 0, count: 0 };
        m.bytes = Math.max(0, (m.bytes || 0) + s.createdBytes - s.freedBytes);
        m.count = Math.max(0, (m.count || 0) + s.createdCount - s.freedCount);
        metaStore.put(m);
    };
}

/**
 * Encodes `parts` (name -> plain value) with one shared pool, resolves the chunks and
 * calls back with the encoded parts (keys resolved) and helpers to finish the write.
 */
function encodeAndResolve(chunkStore, parts, cb) {
    const pool = new TextPool();
    const enc = {};
    for (const [name, value] of Object.entries(parts)) {
        enc[name] = value === undefined ? undefined : encodeValue(value, pool);
    }
    resolvePool(chunkStore, pool, (keys) => {
        const newTexts = new Map();
        keys.forEach((k, i) => newTexts.set(k, pool.texts[i]));
        for (const e of Object.values(enc)) if (e) mapRefs(e, i => keys[i]);
        cb(enc, newTexts);
    });
}

function refsOfEnc(encObj) {
    const set = new Set();
    if (!encObj) return set;
    for (const e of Object.values(encObj)) if (e) collectRefs(e, set);
    return set;
}

// ------------------------------------------------------------ chunk cache / hydrate

const chunkCache = new Map(); // `${store}:${key}` -> text
let chunkCacheBytes = 0;
const CHUNK_CACHE_LIMIT = 24 * 1024 * 1024;

function cachePut(id, text) {
    if (chunkCache.has(id)) return;
    chunkCache.set(id, text);
    chunkCacheBytes += text.length * 2;
    while (chunkCacheBytes > CHUNK_CACHE_LIMIT && chunkCache.size) {
        const [k, v] = chunkCache.entries().next().value;
        chunkCache.delete(k);
        chunkCacheBytes -= v.length * 2;
    }
}

export function clearChunkCache() {
    chunkCache.clear();
    chunkCacheBytes = 0;
}

async function fetchChunks(storeName, keys) {
    const missing = [...keys].filter(k => !chunkCache.has(`${storeName}:${k}`));
    if (missing.length) {
        const db = await openDb();
        const store = db.transaction(storeName).objectStore(storeName);
        await Promise.all(missing.map(k => reqP(store.get(k)).then(c => { if (c) cachePut(`${storeName}:${k}`, c.t); })));
    }
    return (k) => chunkCache.get(`${storeName}:${k}`);
}

/** Turns stored records (v1 or v2) into plain records with rawPrompt/details. */
export async function hydrateRecords(recs) {
    const keys = new Set();
    for (const r of recs) if (r?.v === 2) for (const k of refsOfEnc(r.enc)) keys.add(k);
    const lookup = await fetchChunks(STORE_CHUNKS, keys);
    return recs.map(r => {
        if (!r || r.v !== 2) return r;
        const { enc, ...meta } = r;
        try {
            return { ...meta, rawPrompt: decodeValue(enc.p, lookup), details: enc.d ? decodeValue(enc.d, lookup) : null };
        } catch (e) {
            console.error('[PromptRestorer] could not rebuild record', r.id, e);
            return { ...meta, rawPrompt: `(이 기록을 복원하지 못했습니다: ${e.message})`, details: null, broken: true };
        }
    });
}

// ------------------------------------------------------------ chat summaries

function applySummary(summary, rec, { countDelta = 0, bytesDelta = 0, storedDelta = 0 } = {}) {
    const s = summary || { chatId: rec.chatId, count: 0, bytes: 0, stored: 0, firstTs: rec.ts, lastTs: rec.ts };
    s.count = Math.max(0, (s.count || 0) + countDelta);
    s.bytes = Math.max(0, (s.bytes || 0) + bytesDelta);
    s.stored = Math.max(0, (s.stored || 0) + storedDelta);
    if (countDelta > 0) {
        s.firstTs = Math.min(s.firstTs ?? rec.ts, rec.ts);
        if (rec.ts >= (s.lastTs || 0)) {
            s.lastTs = rec.ts;
            s.charName = rec.charName ?? s.charName;
            s.groupName = rec.groupName ?? s.groupName;
            s.isGroup = !!rec.isGroup;
            s.avatar = rec.avatar ?? s.avatar;
        }
    }
    if (rec.descSnippet) s.descSnippet = rec.descSnippet;
    return s;
}

function updateSummary(chats, chatId, rec, deltas) {
    chats.get(chatId).onsuccess = (e) => {
        const s = applySummary(e.target.result, rec, deltas);
        if (s.count <= 0) chats.delete(chatId);
        else chats.put(s);
    };
}

// ------------------------------------------------------------ prompt records

const PROMPT_STORES = [STORE_RECORDS, STORE_CHATS, STORE_CHUNKS, STORE_META];

/**
 * Adds a record. `plain` carries `rawPrompt` and `details` like v1; they are encoded.
 * @returns {Promise<number>} new id
 */
export async function addRecord(plain) {
    const db = await openDb();
    const tx = db.transaction(PROMPT_STORES, 'readwrite');
    const done = txDone(tx);
    const records = tx.objectStore(STORE_RECORDS);
    const chunks = tx.objectStore(STORE_CHUNKS);
    let id;
    const { rawPrompt, details, ...meta } = plain;
    encodeAndResolve(chunks, { p: rawPrompt, d: details ?? undefined }, (enc, newTexts) => {
        const stored = { ...meta, v: 2, enc };
        applyRefs(chunks, refsOfEnc(enc), new Set(), newTexts, (stats) => {
            records.add(stored).onsuccess = (e) => { id = e.target.result; };
            updateSummary(tx.objectStore(STORE_CHATS), stored.chatId, stored, { countDelta: 1, bytesDelta: stored.size || 0, storedDelta: stats.createdBytes });
            bumpStats(tx.objectStore(STORE_META), 'stats', stats);
        });
    });
    await done;
    return id;
}

/**
 * Patches a record. If `patch.details` is present it replaces the details.
 */
export async function updateRecord(id, patch) {
    const db = await openDb();
    const tx = db.transaction(PROMPT_STORES, 'readwrite');
    const done = txDone(tx);
    const records = tx.objectStore(STORE_RECORDS);
    const chunks = tx.objectStore(STORE_CHUNKS);
    records.get(id).onsuccess = (e) => {
        const rec = e.target.result;
        if (!rec) return;
        const { details, ...metaPatch } = patch;
        const oldSize = rec.size || 0;
        const finish = (stats) => {
            Object.assign(rec, metaPatch);
            records.put(rec);
            updateSummary(tx.objectStore(STORE_CHATS), rec.chatId, rec, {
                bytesDelta: (rec.size || 0) - oldSize,
                storedDelta: stats.createdBytes - stats.freedBytes,
            });
            bumpStats(tx.objectStore(STORE_META), 'stats', stats);
        };
        if (!('details' in patch)) { finish({ createdBytes: 0, freedBytes: 0, createdCount: 0, freedCount: 0 }); return; }
        if (rec.v !== 2) {
            // legacy record: keep it plain until migrated
            rec.details = details;
            finish({ createdBytes: 0, freedBytes: 0, createdCount: 0, freedCount: 0 });
            return;
        }
        const oldRefs = refsOfEnc(rec.enc);
        encodeAndResolve(chunks, { d: details ?? undefined }, (enc, newTexts) => {
            rec.enc = { ...rec.enc, d: enc.d };
            applyRefs(chunks, refsOfEnc(rec.enc), oldRefs, newTexts, finish);
        });
    };
    await done;
}

export async function getRecord(id) {
    const db = await openDb();
    const rec = await reqP(db.transaction(STORE_RECORDS).objectStore(STORE_RECORDS).get(id));
    if (!rec) return null;
    return (await hydrateRecords([rec]))[0];
}

/** Deletes records by id inside one transaction, releasing their chunks. */
async function deleteRecordsById(ids) {
    if (!ids.length) return 0;
    const db = await openDb();
    const tx = db.transaction(PROMPT_STORES, 'readwrite');
    const done = txDone(tx);
    const records = tx.objectStore(STORE_RECORDS);
    const chunks = tx.objectStore(STORE_CHUNKS);
    const chats = tx.objectStore(STORE_CHATS);
    const refCounts = new Map();
    const perChat = new Map();
    let pending = ids.length;
    let removed = 0;
    for (const id of ids) {
        records.get(id).onsuccess = (e) => {
            const rec = e.target.result;
            if (rec) {
                records.delete(id);
                removed++;
                if (rec.v === 2) for (const k of refsOfEnc(rec.enc)) refCounts.set(k, (refCounts.get(k) || 0) + 1);
                const c = perChat.get(rec.chatId) || { rec, count: 0, bytes: 0 };
                c.count++;
                c.bytes += rec.size || 0;
                perChat.set(rec.chatId, c);
            }
            if (--pending === 0) release();
        };
    }
    function release() {
        const stats = { createdBytes: 0, createdCount: 0, freedBytes: 0, freedCount: 0 };
        const entries = [...refCounts];
        let left = entries.length;
        const finish = () => {
            bumpStats(tx.objectStore(STORE_META), 'stats', stats);
            // stored bytes are attributed per chat approximately (proportional to records removed)
            const totalRemoved = [...perChat.values()].reduce((a, c) => a + c.count, 0) || 1;
            for (const [chatId, c] of perChat) {
                updateSummary(chats, chatId, c.rec, {
                    countDelta: -c.count,
                    bytesDelta: -c.bytes,
                    storedDelta: -Math.round(stats.freedBytes * (c.count / totalRemoved)),
                });
            }
        };
        if (!left) { finish(); return; }
        for (const [k, n] of entries) {
            chunks.get(k).onsuccess = (e) => {
                const ex = e.target.result;
                if (ex) {
                    ex.r = (ex.r || 0) - n;
                    if (ex.r <= 0) {
                        chunks.delete(k);
                        stats.freedBytes += ex.b || 0;
                        stats.freedCount++;
                    } else {
                        chunks.put(ex);
                    }
                }
                if (--left === 0) finish();
            };
        }
    }
    await done;
    return removed;
}

export async function deleteRecord(id) {
    await deleteRecordsById([id]);
}

async function idsForChat(chatId) {
    const db = await openDb();
    const idx = db.transaction(STORE_RECORDS).objectStore(STORE_RECORDS).index('chatId_ts');
    return new Promise((resolve, reject) => {
        const out = [];
        const req = idx.openKeyCursor(chatRange(chatId), 'next');
        req.onsuccess = () => {
            const c = req.result;
            if (!c) return resolve(out);
            out.push(c.primaryKey);
            c.continue();
        };
        req.onerror = () => reject(req.error);
    });
}

export async function deleteChat(chatId) {
    const ids = await idsForChat(chatId);
    // In batches so a huge chat does not create one enormous transaction.
    for (let i = 0; i < ids.length; i += 200) await deleteRecordsById(ids.slice(i, i + 200));
    const db = await openDb();
    const tx = db.transaction(STORE_CHATS, 'readwrite');
    tx.objectStore(STORE_CHATS).delete(chatId);
    await txDone(tx);
}

export async function listChats() {
    const db = await openDb();
    return reqP(db.transaction(STORE_CHATS).objectStore(STORE_CHATS).getAll());
}

export async function getChatSummary(chatId) {
    const db = await openDb();
    return reqP(db.transaction(STORE_CHATS).objectStore(STORE_CHATS).get(chatId));
}

export async function countChatRecords(chatId) {
    const db = await openDb();
    return reqP(db.transaction(STORE_RECORDS).objectStore(STORE_RECORDS).index('chatId').count(IDBKeyRange.only(chatId)));
}

/** A page of hydrated records ('prev' = newest first). */
export async function getChatRecordsPage(chatId, offset, limit, direction = 'prev') {
    const db = await openDb();
    const idx = db.transaction(STORE_RECORDS).objectStore(STORE_RECORDS).index('chatId_ts');
    const recs = await new Promise((resolve, reject) => {
        const out = [];
        let skipped = offset <= 0;
        const req = idx.openCursor(chatRange(chatId), direction);
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return resolve(out);
            if (!skipped) { skipped = true; cursor.advance(offset); return; }
            out.push(cursor.value);
            if (out.length >= limit) return resolve(out);
            cursor.continue();
        };
        req.onerror = () => reject(req.error);
    });
    return hydrateRecords(recs);
}

export async function getLatestRecord(chatId) {
    const page = await getChatRecordsPage(chatId, 0, 1, 'prev');
    return page[0] || null;
}

export async function getChatRecordKeys(chatId) {
    const db = await openDb();
    const idx = db.transaction(STORE_RECORDS).objectStore(STORE_RECORDS).index('chatId_ts');
    return new Promise((resolve, reject) => {
        const out = [];
        const req = idx.openKeyCursor(chatRange(chatId), 'next');
        req.onsuccess = () => {
            const c = req.result;
            if (!c) return resolve(out);
            out.push({ id: c.primaryKey, ts: c.key[1] });
            c.continue();
        };
        req.onerror = () => reject(req.error);
    });
}

export async function hasHash(chatId, hash) {
    const db = await openDb();
    const n = await reqP(db.transaction(STORE_RECORDS).objectStore(STORE_RECORDS).index('chatId_hash').count(IDBKeyRange.only([chatId, hash])));
    return n > 0;
}

export async function pruneChat(chatId, max) {
    if (!max || max <= 0) return 0;
    const ids = await idsForChat(chatId);
    const excess = ids.length - max;
    if (excess <= 0) return 0;
    return deleteRecordsById(ids.slice(0, excess));
}

export async function countAllRecords() {
    const db = await openDb();
    return reqP(db.transaction(STORE_RECORDS).objectStore(STORE_RECORDS).count());
}

/** Clears prompt records only (world-info backups are kept). */
export async function clearAll() {
    const db = await openDb();
    const tx = db.transaction(PROMPT_STORES, 'readwrite');
    const done = txDone(tx);
    tx.objectStore(STORE_RECORDS).clear();
    tx.objectStore(STORE_CHATS).clear();
    tx.objectStore(STORE_CHUNKS).clear();
    tx.objectStore(STORE_META).delete('stats');
    await done;
    clearChunkCache();
}

/** Storage numbers for the drawer. */
export async function getStorageStats() {
    const db = await openDb();
    const tx = db.transaction([STORE_RECORDS, STORE_CHATS, STORE_META, STORE_WI]);
    const [records, chats, stats, wiStats, wiCount] = await Promise.all([
        reqP(tx.objectStore(STORE_RECORDS).count()),
        reqP(tx.objectStore(STORE_CHATS).getAll()),
        reqP(tx.objectStore(STORE_META).get('stats')),
        reqP(tx.objectStore(STORE_META).get('wistats')),
        reqP(tx.objectStore(STORE_WI).count()),
    ]);
    const logical = chats.reduce((a, c) => a + (c.bytes || 0), 0);
    const migrated = await reqP(db.transaction(STORE_META).objectStore(STORE_META).get('migrated'));
    return {
        records,
        chats: chats.length,
        logicalBytes: logical,
        storedBytes: stats?.bytes || 0,
        chunkCount: stats?.count || 0,
        migrationPending: !migrated?.done && records > 0,
        wiCount,
        wiStoredBytes: wiStats?.bytes || 0,
    };
}

/** Rebuilds per-chat summaries from the records (maintenance). */
export async function rebuildSummaries() {
    const db = await openDb();
    const summaries = new Map();
    await new Promise((resolve, reject) => {
        const req = db.transaction(STORE_RECORDS).objectStore(STORE_RECORDS).openCursor();
        req.onsuccess = () => {
            const c = req.result;
            if (!c) return resolve();
            const r = c.value;
            summaries.set(r.chatId, applySummary(summaries.get(r.chatId), r, { countDelta: 1, bytesDelta: r.size || 0 }));
            c.continue();
        };
        req.onerror = () => reject(req.error);
    });
    const tx = db.transaction(STORE_CHATS, 'readwrite');
    const done = txDone(tx);
    const store = tx.objectStore(STORE_CHATS);
    store.getAll().onsuccess = (e) => {
        const old = new Map(e.target.result.map(s => [s.chatId, s]));
        store.clear();
        for (const s of summaries.values()) {
            s.stored = old.get(s.chatId)?.stored || 0;
            if (!s.descSnippet) s.descSnippet = old.get(s.chatId)?.descSnippet;
            store.put(s);
        }
    };
    await done;
    return summaries.size;
}

// ------------------------------------------------------------ migration v1 -> v2

/**
 * Converts records saved by extension 3.0 (full prompt in every record) to the
 * de-duplicated form, one record per transaction. Safe to call repeatedly.
 * @returns {Promise<number>} number of converted records
 */
export async function migrateLegacy(onProgress) {
    const db = await openDb();
    const flag = await reqP(db.transaction(STORE_META).objectStore(STORE_META).get('migrated'));
    if (flag?.done) return 0;
    const ids = await reqP(db.transaction(STORE_RECORDS).objectStore(STORE_RECORDS).getAllKeys());
    let converted = 0;
    for (let i = 0; i < ids.length; i++) {
        const tx = db.transaction(PROMPT_STORES, 'readwrite');
        const done = txDone(tx);
        const records = tx.objectStore(STORE_RECORDS);
        const chunks = tx.objectStore(STORE_CHUNKS);
        records.get(ids[i]).onsuccess = (e) => {
            const rec = e.target.result;
            if (!rec || rec.v === 2) return;
            const { rawPrompt, details, ...meta } = rec;
            encodeAndResolve(chunks, { p: rawPrompt, d: details ?? undefined }, (enc, newTexts) => {
                applyRefs(chunks, refsOfEnc(enc), new Set(), newTexts, (stats) => {
                    records.put({ ...meta, v: 2, enc });
                    updateSummary(tx.objectStore(STORE_CHATS), meta.chatId, meta, { storedDelta: stats.createdBytes });
                    bumpStats(tx.objectStore(STORE_META), 'stats', stats);
                    converted++;
                });
            });
        };
        await done;
        if (onProgress && i % 10 === 0) onProgress(i + 1, ids.length);
        await new Promise(r => setTimeout(r, 0));
    }
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put({ k: 'migrated', done: true, at: Date.now(), converted });
    await txDone(tx);
    return converted;
}

// ------------------------------------------------------------ world-info backups

const WI_STORES = [STORE_WI, STORE_WIBODY, STORE_WICHUNKS, STORE_META];

/**
 * @param {object} meta {ts, kind: 'book'|'entry', book, uid?, title, keys?, entryCount?, reason}
 * @param {object} data book data or entry object
 */
export async function addWiBackup(meta, data) {
    const db = await openDb();
    const tx = db.transaction(WI_STORES, 'readwrite');
    const done = txDone(tx);
    const chunks = tx.objectStore(STORE_WICHUNKS);
    let id;
    encodeAndResolve(chunks, { x: data }, (enc, newTexts) => {
        applyRefs(chunks, refsOfEnc(enc), new Set(), newTexts, (stats) => {
            const m = { ...meta, size: estimateBytes(data), stored: stats.createdBytes };
            tx.objectStore(STORE_WI).add(m).onsuccess = (e) => {
                id = e.target.result;
                tx.objectStore(STORE_WIBODY).put({ id, enc });
            };
            bumpStats(tx.objectStore(STORE_META), 'wistats', stats);
        });
    });
    await done;
    return id;
}

export async function listWiBackups() {
    const db = await openDb();
    const all = await reqP(db.transaction(STORE_WI).objectStore(STORE_WI).getAll());
    return all.sort((a, b) => b.ts - a.ts);
}

/** Raw encoded body (cheap: chunk texts are not loaded). */
export async function getWiBody(id) {
    const db = await openDb();
    const body = await reqP(db.transaction(STORE_WIBODY).objectStore(STORE_WIBODY).get(id));
    return body?.enc?.x ?? null;
}

/** Decodes an encoded world-info value (whole book, or one entry of it). */
export async function decodeWi(enc) {
    const keys = collectRefs(enc);
    const lookup = await fetchChunks(STORE_WICHUNKS, keys);
    return decodeValue(enc, lookup);
}

export async function deleteWiBackups(ids) {
    if (!ids.length) return;
    const db = await openDb();
    const tx = db.transaction(WI_STORES, 'readwrite');
    const done = txDone(tx);
    const bodies = tx.objectStore(STORE_WIBODY);
    const chunks = tx.objectStore(STORE_WICHUNKS);
    const refCounts = new Map();
    let pending = ids.length;
    for (const id of ids) {
        tx.objectStore(STORE_WI).delete(id);
        bodies.get(id).onsuccess = (e) => {
            const b = e.target.result;
            if (b) {
                bodies.delete(id);
                for (const k of refsOfEnc(b.enc)) refCounts.set(k, (refCounts.get(k) || 0) + 1);
            }
            if (--pending === 0) release();
        };
    }
    function release() {
        const stats = { createdBytes: 0, createdCount: 0, freedBytes: 0, freedCount: 0 };
        const entries = [...refCounts];
        let left = entries.length;
        if (!left) return;
        for (const [k, n] of entries) {
            chunks.get(k).onsuccess = (e) => {
                const ex = e.target.result;
                if (ex) {
                    ex.r = (ex.r || 0) - n;
                    if (ex.r <= 0) { chunks.delete(k); stats.freedBytes += ex.b || 0; stats.freedCount++; } else chunks.put(ex);
                }
                if (--left === 0) bumpStats(tx.objectStore(STORE_META), 'wistats', stats);
            };
        }
    }
    await done;
}

/** Removes world-info backups older than `days` days. */
export async function pruneWiBackups(days) {
    if (!days || days <= 0) return 0;
    const cutoff = Date.now() - days * 86400000;
    const old = (await listWiBackups()).filter(b => b.ts < cutoff).map(b => b.id);
    await deleteWiBackups(old);
    return old.length;
}
