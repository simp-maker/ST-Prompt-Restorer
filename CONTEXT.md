This document contains the latest status of the project. Always read this document first to understand the context before writing any code.

# ST-Prompt-Restorer — project context

## Overview
SillyTavern third-party extension (`data/default-user/extensions/ST-Prompt-Restorer`), a port of the user's "SillyTavern 프롬프트 복원기 V2.2" HTML tool.
- Drawer (`#extensions_settings2`) holds settings + "open window" button; wand-menu shortcut; `/prompt-restorer`.
- Main UI is a SillyTavern `Popup` (DISPLAY, wide/large). Root node is built once and re-attached on each open.
- Target: SillyTavern 1.19.0 (user's install = 1.19.0 + a few staging commits, CRLF).

## Version history
- 3.0.0: extension port, own IndexedDB capture (full copy per send), ST store reader, viewer.
- 4.0.0 (current): de-duplicated chunk storage + migration, world-info deletion backup/restore, UI redesign.

## Files
- `index.js` — settings defaults (`extension_settings.promptRestorer`), drawer HTML/bindings, storage stats, "현재 채팅 점검" diagnostic (forces ST `saveItemizedPrompts` and compares), wand button, slash command, starts capture, WI backup and background migration (3 s after load).
- `src/chunks.js` — content-defined chunking (line boundaries chosen by line hash; MIN 512 / MAX 16384 chars; no regex lookbehind for old Safari), `cyrb53` keys (`hash36.len36`, `~n` suffix on collision), `encodeValue`/`decodeValue` (`{s:[keys]}` long string, `{a}`, `{o}`, `{v}` inline ≤80 chars).
- `src/db.js` — IndexedDB `ST_PromptRestorer` **v2**. Stores: `records` (metadata + `v:2` + `enc:{p,d}`), `chats` (summary: count, bytes=logical, stored≈new chunk bytes), `chunks` {h,t,r=refcount,b=bytes}, `wi` (backup metadata), `wibody` {id, enc}, `wichunks`, `meta` (`stats`, `wistats`, `migrated`). All refcount changes happen inside the same transaction as the record write/delete. `hydrateRecords` rebuilds rawPrompt/details with a 24 MB chunk cache. `migrateLegacy` converts v1 records one per transaction. `clearAll` clears prompt stores only.
- `src/capture.js` — `GENERATION_STARTED` remembers type; `GENERATE_AFTER_DATA` (`makeLast`) clones `generate_data.prompt ?? input`, writes in background, polls ST `itemizedPrompts` to attach details via `updateRecord`.
- `src/wi.js` — WI backup. Wraps `window.fetch`: before POST `/api/worldinfo/delete` downloads the book and stores it (skips renames: same fingerprint saved under another name within 20 s); before the first `/api/worldinfo/edit` of a book in the session, downloads the old file. `WORLDINFO_UPDATED(name,data)` diff against old file / remembered entry object references → deleted entries backed up (copied synchronously, written async). `restoreEntry` (free uid, `saveWorldInfo`, `reloadWorldInfoEditor`), `restoreBook` (new name if taken).
- `src/wipanel.js` — WI backups panel (search, kind filter, view/restore/copy/download/delete, expandable entry list of book backups read from inline encoded fields without loading content).
- `src/entries.js` — normalizes ext records / ST entries; paging; viewer navigator; LRU (3) for ST arrays.
- `src/format.js`, `src/utils.js` — formatting, JSONL, copy fallback (execCommand inside the open dialog), download, `el`, `icon`, `iconButton`.
- `src/viewer.js` — viewer popup: entry mode (tabs prompt/fields/raw JSON/JSONL, nav, meta chips) or `views` mode (plain text tabs, used for WI).
- `src/ui.js` — main window: source segmented control (ext / st / wi), chat list (avatar, chips, star, multi-select), mode segmented control, preview, timeline of takes grouped by mesId with type-colored nodes, pager, import ST→ext, delete.
- `style.css` — tokens per theme (`pr-theme-st` maps to ST vars, `dark`, `light`), type colors `--t-*`; all scoped.

## Findings about ST's own prompt storage
1. One itemized prompt per message; swipe/regenerate overwrite; continue/quiet/impersonate use `mesId = chat.length`.
2. Since 1.16.0 (commit 684b7558) deleting/regenerating messages removes their itemized prompts.
3. `saveItemizedPrompts` swallows errors. Chromium in-memory IDB (incognito) refuses values > 133,169,152 bytes; on-disk Chromium 153 accepted 140 MB.
4. Character/group switch resets the id before `clearChat()`, so a prompt of a failed request is lost.

## Testing (no real ST server — npm registry is blocked in the build container; do not retry)
Real ST 1.19.0 frontend from git + user's built `lib.js` + Node mock backend (`/home/claude/st/mock/server.mjs`, includes WI endpoints) + Playwright. Suite `/home/claude/st/tests/v4.js` (cap, mig, wi, mob, st): all passing. Perf (365K-char prompt, 40 sends): ~0.2 s per background save, 29.8 MB → 1.07 MB, 20 records hydrate ~0.1 s, delete frees all chunks.
Note: the mock keeps settings in memory between runs (e.g. `defaultSource`), restart it between suites.

## Possible next steps
Search inside prompts, export/import of the extension DB, retention by size, group-chat check on a real install.
