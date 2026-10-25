// Content-defined chunking for de-duplicated storage.
//
// Long texts are cut at line boundaries chosen by the content of the line itself,
// so an inserted / removed paragraph only changes the chunks around it. Identical
// chunks (the same chat message in consecutive prompts, the same persona, the same
// world-info entry...) are stored once and referenced by key.
//
// Encoded structures reference chunk texts by index into a `texts` array; the DB
// layer resolves indices to keys inside its write transaction.

const MIN_CHUNK = 512;
const MAX_CHUNK = 16384;
const BOUNDARY_MASK = 7; // ~1 boundary per 8 lines once MIN_CHUNK is reached
const INLINE_LIMIT = 80; // strings up to this length stay inline

/** 53-bit string hash (cyrb53). */
export function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Base key of a chunk: hash + length. The DB adds a suffix in the (unlikely) event of a collision. */
export function baseKey(text) {
    return `${cyrb53(text).toString(36)}.${text.length.toString(36)}`;
}

function lineBits(line) {
    let h = 0x811c9dc5;
    for (let i = 0; i < line.length; i++) {
        h ^= line.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** Splits text into chunks; joining the result gives back the exact input. */
export function splitText(text) {
    if (!text) return [];
    if (text.length <= MIN_CHUNK) return [text];
    const out = [];
    let cur = '';
    let pos = 0;
    while (pos < text.length) {
        const nl = text.indexOf('\n', pos);
        let line = nl === -1 ? text.slice(pos) : text.slice(pos, nl + 1);
        pos = nl === -1 ? text.length : nl + 1;
        while (line.length > MAX_CHUNK) {
            if (cur) { out.push(cur); cur = ''; }
            out.push(line.slice(0, MAX_CHUNK));
            line = line.slice(MAX_CHUNK);
        }
        cur += line;
        if (cur.length >= MAX_CHUNK || (cur.length >= MIN_CHUNK && (lineBits(line) & BOUNDARY_MASK) === 0)) {
            out.push(cur);
            cur = '';
        }
    }
    if (cur) out.push(cur);
    return out;
}

/** Collects unique chunk texts and hands out indices. */
export class TextPool {
    constructor() {
        this.texts = [];
        this.index = new Map();
    }
    add(text) {
        let i = this.index.get(text);
        if (i === undefined) {
            i = this.texts.length;
            this.texts.push(text);
            this.index.set(text, i);
        }
        return i;
    }
    addText(text) {
        return splitText(text).map(t => this.add(t));
    }
}

/**
 * Encodes any value. Strings become chunk lists, objects/arrays are encoded field by
 * field (so shared sub-parts dedupe), short strings and scalars stay inline.
 * Encoded forms:
 *   { s: [idx...] }  long string
 *   { a: [enc...] }  array
 *   { o: {k: enc} }  plain object
 *   { v: value }     inline scalar / short string / null
 */
export function encodeValue(value, pool, depth = 0) {
    if (typeof value === 'string') {
        return value.length > INLINE_LIMIT ? { s: pool.addText(value) } : { v: value };
    }
    if (value === null || typeof value !== 'object') {
        return value === undefined ? { u: 1 } : { v: value };
    }
    if (depth > 30) return { s: pool.addText(JSON.stringify(value)), j: 1 };
    if (Array.isArray(value)) return { a: value.map(v => encodeValue(v, pool, depth + 1)) };
    const o = {};
    for (const k of Object.keys(value)) {
        if (typeof value[k] === 'function') continue;
        o[k] = encodeValue(value[k], pool, depth + 1);
    }
    return { o };
}

/** Replaces chunk indices with resolved keys (in place). */
export function mapRefs(enc, fn) {
    if (!enc || typeof enc !== 'object') return enc;
    if (enc.s) enc.s = enc.s.map(fn);
    else if (enc.a) enc.a.forEach(e => mapRefs(e, fn));
    else if (enc.o) Object.values(enc.o).forEach(e => mapRefs(e, fn));
    return enc;
}

/** Collects every chunk key referenced by an encoded value. */
export function collectRefs(enc, out = new Set()) {
    if (!enc || typeof enc !== 'object') return out;
    if (enc.s) enc.s.forEach(k => out.add(k));
    else if (enc.a) enc.a.forEach(e => collectRefs(e, out));
    else if (enc.o) Object.values(enc.o).forEach(e => collectRefs(e, out));
    return out;
}

/** Rebuilds a value given a key -> text lookup. */
export function decodeValue(enc, lookup) {
    if (!enc || typeof enc !== 'object') return enc;
    if ('v' in enc) return enc.v;
    if (enc.u) return undefined;
    if (enc.s) {
        const text = enc.s.map(k => {
            const t = lookup(k);
            if (t === undefined) throw new Error(`missing chunk ${k}`);
            return t;
        }).join('');
        return enc.j ? JSON.parse(text) : text;
    }
    if (enc.a) return enc.a.map(e => decodeValue(e, lookup));
    if (enc.o) {
        const out = {};
        for (const [k, e] of Object.entries(enc.o)) {
            const v = decodeValue(e, lookup);
            if (v !== undefined) out[k] = v;
        }
        return out;
    }
    return undefined;
}
