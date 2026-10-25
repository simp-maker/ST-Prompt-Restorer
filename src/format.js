// Text formatting shared by the main window and the viewer.

import { contentToText } from './utils.js';

export const DETAILED_FIELDS = [
    'rawPrompt', 'main_api', 'presetName', 'charDescription', 'charPersonality', 'userPersona',
    'scenarioText', 'worldInfoString', 'afterScenarioAnchor', 'beforeScenarioAnchor', 'examplesString',
    'chatInjects', 'summarizeString', 'authorsNoteString', 'smartContextString', 'chatVectorsString',
    'dataBankVectorsString', 'storyString', 'instruction', 'allAnchors', 'promptBias',
];

export const TYPE_LABELS = {
    normal: '일반',
    regenerate: '재생성',
    swipe: '스와이프',
    continue: '이어쓰기',
    impersonate: '사칭',
    quiet: '백그라운드',
    'st-import': 'ST에서 복사',
    st: 'ST 저장',
    unknown: '종류 모름',
};

export function roleLabel(msg) {
    const role = msg?.role || 'unknown';
    return msg?.name ? `${role} (${msg.name})` : role;
}

/**
 * "role: content" lines for chat prompts; the string itself for text prompts.
 */
export function formatReadable(rawPrompt, { spacing = true, includeSystem = true } = {}) {
    if (rawPrompt == null) return '';
    if (typeof rawPrompt === 'string') return rawPrompt;
    if (!Array.isArray(rawPrompt)) return JSON.stringify(rawPrompt, null, 2);
    const sep = spacing ? '\n\n' : '\n';
    return rawPrompt
        .filter(m => includeSystem || m?.role !== 'system')
        .map(m => `${roleLabel(m)}: ${contentToText(m?.content)}`)
        .join(sep);
}

export function toText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
}

/** Turns literal escape sequences (as seen in JSON) back into real characters. */
export function unescapeText(text) {
    return String(text).replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\t/g, '\t').replace(/\\"/g, '"');
}

/**
 * Same behaviour as the V2.2 page: reading mode turns a message array into
 * "role: content" text, otherwise objects are shown as JSON; escape sequences
 * are expanded unless "keep escapes" is on.
 */
export function processValue(value, { readingMode = false, spacing = true, keepEscapes = false } = {}) {
    let text;
    if (readingMode && Array.isArray(value)) {
        text = formatReadable(value, { spacing });
    } else {
        text = toText(value);
    }
    return keepEscapes ? text : unescapeText(text);
}

export function formatSeparator(text) {
    return `==========================\n  ${text}\n==========================\n\n`;
}

export function formatField(fieldName, content) {
    return `--- ${fieldName} ---\n${content}\n`;
}

export function generateJsonl(rawPrompt, charName, userName, excludeSystem) {
    const lines = [JSON.stringify({ user_name: userName, character_name: charName })];
    if (typeof rawPrompt === 'string') {
        lines.push(JSON.stringify({ name: charName, is_user: false, is_system: true, mes: rawPrompt }));
        return lines.join('\n');
    }
    for (const msg of (Array.isArray(rawPrompt) ? rawPrompt : [])) {
        if (excludeSystem && msg?.role === 'system') continue;
        const mes = contentToText(msg?.content);
        switch (msg?.role) {
            case 'assistant':
                lines.push(JSON.stringify({ name: charName, is_user: false, is_system: false, mes }));
                break;
            case 'user':
                lines.push(JSON.stringify({ name: userName, is_user: true, is_system: false, send_date: '', mes }));
                break;
            case 'system':
                lines.push(JSON.stringify({ name: charName, is_user: false, is_system: true, mes }));
                break;
            default:
                break;
        }
    }
    return lines.join('\n');
}
