// Small shared helpers.

const NON_LATIN1 = /[^\u0000-ÿ]/;

/**
 * Estimates how many bytes a value takes when the browser serializes it into
 * IndexedDB (V8 stores Latin-1 strings with 1 byte/char, everything else 2 bytes/char).
 * Walks the structure instead of JSON.stringify-ing it, so huge values do not
 * need a second giant copy in memory.
 */
export function estimateBytes(value, depth = 0) {
    if (value == null) return 1;
    switch (typeof value) {
        case 'string':
            return NON_LATIN1.test(value) ? value.length * 2 : value.length;
        case 'number':
            return 8;
        case 'boolean':
            return 1;
        case 'object': {
            if (depth > 40) return 0;
            let total = 2;
            if (Array.isArray(value)) {
                for (const v of value) total += estimateBytes(v, depth + 1);
            } else {
                for (const k in value) {
                    if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
                    total += k.length + estimateBytes(value[k], depth + 1);
                }
            }
            return total;
        }
        default:
            return 0;
    }
}

/** FNV-1a 32-bit hash of a string, returned as hex. */
export function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

export function hashPrompt(rawPrompt) {
    const str = typeof rawPrompt === 'string' ? rawPrompt : JSON.stringify(rawPrompt ?? '');
    return `${str.length.toString(36)}-${hashString(str)}`;
}

/**
 * Replaces long base64 data URIs (inline images, audio, video) with a short note.
 * Returns a new structure; the input is not modified.
 */
export function stripDataUris(value, depth = 0) {
    if (typeof value === 'string') {
        if (value.length > 2048 && value.startsWith('data:')) {
            const mime = value.slice(5, value.indexOf(';') > 0 ? value.indexOf(';') : 40);
            return `[미디어 데이터 생략: ${mime}, ${value.length.toLocaleString()}자]`;
        }
        return value;
    }
    if (!value || typeof value !== 'object' || depth > 40) return value;
    if (Array.isArray(value)) return value.map(v => stripDataUris(v, depth + 1));
    const out = {};
    for (const k of Object.keys(value)) out[k] = stripDataUris(value[k], depth + 1);
    return out;
}

export function deepClone(value) {
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value));
    }
}

export function formatBytes(n) {
    if (!n || n < 0) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "10/23 06:23" for this year, "2025-10-23" for older dates. */
export function formatShortDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (x) => String(x).padStart(2, '0');
    if (d.getFullYear() !== new Date().getFullYear()) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function isNotEmpty(value) {
    return value != null && value !== ''
        && !(Array.isArray(value) && value.length === 0)
        && !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}

/** Flattens message content (string or multimodal parts array) into text. */
export function contentToText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (part?.type === 'text') return part.text ?? '';
            if (part?.type === 'image_url') return `[이미지: ${String(part.image_url?.url ?? '').slice(0, 80)}]`;
            if (part?.type) return `[${part.type}]`;
            return JSON.stringify(part);
        }).join('\n');
    }
    if (typeof content === 'object') return JSON.stringify(content, null, 2);
    return String(content);
}

/**
 * Copies text to the clipboard. Works on plain-http LAN addresses (where
 * navigator.clipboard is unavailable) by falling back to execCommand.
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* fall through */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        ta.style.opacity = '0';
        // Must live inside the open <dialog> or the selection is blocked by inertness.
        const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
        host.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch {
        return false;
    }
}

/** @returns {boolean} whether a download was attempted */
export function downloadText(fileName, content, mimeType = 'text/plain; charset=utf-8') {
    try {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        return true;
    } catch (e) {
        console.error('[PromptRestorer] download failed', e);
        return false;
    }
}

export function safeFileName(...parts) {
    return parts
        .filter(Boolean)
        .map(p => String(p).replace(/[^\p{L}\p{N}_-]/gu, '').substring(0, 30))
        .filter(Boolean)
        .join('_') || 'prompt';
}

export function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === 'class' || k === 'className') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') {
            for (const [sk, sv] of Object.entries(v)) {
                if (sk.startsWith('--')) node.style.setProperty(sk, sv);
                else node.style[sk] = sv;
            }
        }
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
        if (c == null || c === false) continue;
        node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
}

/** Font Awesome icon (SillyTavern ships Font Awesome 6). */
export function icon(name, cls = '') {
    return el('i', { class: `fa-solid ${name} ${cls}`.trim(), 'aria-hidden': 'true' });
}

export function iconButton(iconName, title, onClick, cls = '') {
    const b = el('button', { class: `pr-ib ${cls}`.trim(), type: 'button', title, 'aria-label': title }, icon(iconName));
    if (onClick) b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    return b;
}
