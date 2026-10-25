// 프롬프트 복원기 (Prompt Restorer) — SillyTavern extension
// Entry point: settings drawer, wand-menu shortcut, prompt capture wiring.

import { initCapture, onCaptured } from './src/capture.js';
import { clearAll, getStorageStats, listChats, migrateLegacy, pruneWiBackups, rebuildSummaries } from './src/db.js';
import { CHROMIUM_IDB_VALUE_LIMIT, getStChat } from './src/stdb.js';
import { handleCaptured, handleWiChanged, initUi, openMainWindow, refreshTheme } from './src/ui.js';
import { initWorldInfoBackup, onWiBackup } from './src/wi.js';
import { estimateBytes, formatBytes } from './src/utils.js';

const MODULE = 'promptRestorer';

const DEFAULTS = Object.freeze({
    captureEnabled: true,
    captureImpersonate: true,
    captureQuiet: false,
    captureNoChat: false,
    saveDetails: true,
    stripMedia: true,
    maxPerChat: 0,
    historyPageSize: 20,
    theme: 'st',
    showWandButton: true,
    autoSelectCurrent: true,
    defaultSource: 'ext',
    readingMode: true,
    spacingMode: true,
    keepEscapes: false,
    stScanDetails: true,
    combineDownloads: false,
    wiBackup: true,
    wiRetentionDays: 0,
});

function getSettings() {
    const ctx = SillyTavern.getContext();
    const all = ctx.extensionSettings;
    if (!all[MODULE] || typeof all[MODULE] !== 'object') all[MODULE] = {};
    const s = all[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
}

function saveSettings(patch = {}) {
    Object.assign(getSettings(), patch);
    SillyTavern.getContext().saveSettingsDebounced();
}

// Optional internal modules (imported dynamically so a future refactor in
// SillyTavern cannot stop the extension from loading).
async function loadOptionalModules() {
    let itemizedModule = null;
    let getChatCompletionModel = null;
    try {
        itemizedModule = await import('../../../itemized-prompts.js');
    } catch {
        try { itemizedModule = await import('../../../../script.js'); } catch { /* ignore */ }
    }
    try {
        const openai = await import('../../../openai.js');
        getChatCompletionModel = typeof openai.getChatCompletionModel === 'function' ? () => openai.getChatCompletionModel() : null;
    } catch { /* ignore */ }
    return { itemizedModule, getChatCompletionModel };
}

let itemizedRef = null;

// ------------------------------------------------------------------ drawer

const SETTINGS_HTML = `
<div id="prompt_restorer_settings" class="prompt-restorer-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>프롬프트 복원기</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="pr-drawer-open-row">
        <div id="pr_open_window" class="menu_button menu_button_icon" title="프롬프트 복원기 창 열기">
          <i class="fa-solid fa-clock-rotate-left"></i><span>복원기 창 열기</span>
        </div>
      </div>

      <div class="pr-drawer-group">
        <div class="pr-drawer-title">저장</div>
        <label class="checkbox_label" for="pr_capture_enabled"><input type="checkbox" id="pr_capture_enabled"><span>보내는 프롬프트를 확장 저장소에 저장</span></label>
        <label class="checkbox_label" for="pr_capture_impersonate"><input type="checkbox" id="pr_capture_impersonate"><span>사칭(Impersonate) 생성도 저장</span></label>
        <label class="checkbox_label" for="pr_capture_quiet"><input type="checkbox" id="pr_capture_quiet"><span>백그라운드(quiet) 생성도 저장 <small class="pr-drawer-hint">요약·메모리 확장 등</small></span></label>
        <label class="checkbox_label" for="pr_save_details"><input type="checkbox" id="pr_save_details"><span>세부 정보(캐릭터 설명·월드인포 등)도 저장</span></label>
        <label class="checkbox_label" for="pr_strip_media"><input type="checkbox" id="pr_strip_media"><span>이미지·미디어 데이터는 빼고 저장</span></label>
        <label class="pr-drawer-inline" for="pr_max_per_chat"><span>채팅당 최대 보관 개수</span><input type="number" id="pr_max_per_chat" class="text_pole" min="0" step="1"><small class="pr-drawer-hint">0 = 무제한</small></label>
      </div>

      <div class="pr-drawer-group">
        <div class="pr-drawer-title">월드인포 백업</div>
        <label class="checkbox_label" for="pr_wi_backup"><input type="checkbox" id="pr_wi_backup"><span>북이나 엔트리를 지울 때 지우기 전 내용을 백업</span></label>
        <small class="pr-drawer-hint">북마다 이번 접속에서 처음 저장할 때 한 번, 서버에서 기존 파일을 읽어 옵니다. 아주 큰 북은 그 한 번만 저장이 조금 늦어질 수 있습니다.</small>
        <label class="pr-drawer-inline" for="pr_wi_days"><span>백업 보관 기간</span><input type="number" id="pr_wi_days" class="text_pole" min="0" step="1"><small class="pr-drawer-hint">일 (0 = 계속 보관)</small></label>
      </div>

      <div class="pr-drawer-group">
        <div class="pr-drawer-title">화면</div>
        <label class="pr-drawer-inline" for="pr_theme"><span>테마</span>
          <select id="pr_theme" class="text_pole">
            <option value="st">ST 테마 따르기</option>
            <option value="dark">다크</option>
            <option value="light">라이트</option>
          </select>
        </label>
        <label class="pr-drawer-inline" for="pr_page_size"><span>전체 기록 한 페이지에</span><input type="number" id="pr_page_size" class="text_pole" min="5" max="200" step="5"><small class="pr-drawer-hint">개</small></label>
        <label class="checkbox_label" for="pr_wand"><input type="checkbox" id="pr_wand"><span>마법봉(확장) 메뉴에 바로가기 표시</span></label>
        <label class="checkbox_label" for="pr_auto_select"><input type="checkbox" id="pr_auto_select"><span>창을 열 때 현재 채팅 자동 선택</span></label>
      </div>

      <div class="pr-drawer-group">
        <div class="pr-drawer-title">저장소 상태</div>
        <div id="pr_storage_info" class="pr-storage-info">불러오는 중…</div>
        <div class="pr-drawer-buttons">
          <div id="pr_refresh_stats" class="menu_button" title="저장소 상태 새로고침"><i class="fa-solid fa-rotate"></i> 새로고침</div>
          <div id="pr_persist" class="menu_button" title="브라우저가 저장 공간이 부족할 때 이 사이트 데이터를 자동으로 지우지 않도록 요청합니다."><i class="fa-solid fa-lock"></i> 영구 보존 요청</div>
          <div id="pr_check_st" class="menu_button" title="현재 채팅의 프롬프트가 ST 기본 저장소에 제대로 저장되고 있는지 확인합니다."><i class="fa-solid fa-stethoscope"></i> 현재 채팅 점검</div>
          <div id="pr_rebuild" class="menu_button" title="채팅방 목록(개수·용량)을 기록에서 다시 계산합니다."><i class="fa-solid fa-screwdriver-wrench"></i> 목록 재구성</div>
          <div id="pr_clear_all" class="menu_button redWarningBG" title="확장 저장소의 프롬프트 기록을 모두 지웁니다. 월드인포 백업과 ST 기본 저장소는 그대로 둡니다."><i class="fa-solid fa-trash"></i> 프롬프트 기록 비우기</div>
        </div>
      </div>
    </div>
  </div>
</div>`;

async function updateStorageInfo() {
    const box = document.getElementById('pr_storage_info');
    if (!box) return;
    try {
        const st = await getStorageStats();
        const lines = [
            `프롬프트 기록 ${st.records.toLocaleString()}개 (채팅 ${st.chats.toLocaleString()}개)`,
            `원래 크기 ${formatBytes(st.logicalBytes)} → 실제 사용 ${formatBytes(st.storedBytes)}${st.storedBytes ? ` (${Math.max(1, Math.round(st.logicalBytes / st.storedBytes))}분의 1)` : ''}`,
        ];
        if (st.migrationPending) lines.push('예전(3.0) 기록을 중복 제거 형식으로 바꾸는 중입니다.');
        lines.push(`월드인포 백업 ${st.wiCount.toLocaleString()}개, 실제 사용 ${formatBytes(st.wiStoredBytes)}`);
        if (navigator.storage?.estimate) {
            const est = await navigator.storage.estimate();
            if (est?.quota) lines.push(`이 사이트 브라우저 저장 공간: ${formatBytes(est.usage)} / ${formatBytes(est.quota)} 사용`);
        }
        if (navigator.storage?.persisted) {
            const persisted = await navigator.storage.persisted();
            lines.push(persisted ? '🔒 영구 보존: 켜짐 (브라우저가 자동으로 지우지 않음)' : '🔓 영구 보존: 꺼짐 (저장 공간이 부족하면 브라우저가 지울 수 있음)');
        }
        if (!window.isSecureContext) {
            lines.push('ℹ️ http 주소로 접속 중이라 클립보드·영구 보존 기능이 제한될 수 있습니다.');
        }
        box.textContent = lines.join('\n');
    } catch (e) {
        box.textContent = `저장소 상태를 읽지 못했습니다: ${e?.message ?? e}`;
    }
}

async function checkCurrentChat() {
    const ctx = SillyTavern.getContext();
    const chatId = ctx.getCurrentChatId?.();
    if (!chatId) {
        toastr.info('열려 있는 채팅이 없습니다.', '프롬프트 복원기');
        return;
    }
    const lines = [`채팅: ${chatId}`, `메시지 수: ${ctx.chat?.length ?? 0}`];
    const mem = Array.isArray(itemizedRef?.itemizedPrompts) ? itemizedRef.itemizedPrompts : null;
    let memBytes = 0;
    if (mem) {
        memBytes = estimateBytes(mem);
        lines.push(`ST 메모리상 프롬프트 기록: ${mem.length}개 (약 ${formatBytes(memBytes)})`);
    }
    let stored = [];
    let saveTest = null;
    // Ask ST to write its in-memory prompts now (the same write ST does on every chat save)
    // and read them back: ST swallows save errors, so this is the only way to see a failure.
    if (mem && typeof itemizedRef?.saveItemizedPrompts === 'function') {
        try {
            await itemizedRef.saveItemizedPrompts(chatId);
        } catch { /* ST catches internally */ }
    }
    try {
        stored = await getStChat(chatId);
        lines.push(`ST 기본 저장소(IndexedDB)에 실제로 저장된 기록: ${stored.length}개 (약 ${formatBytes(estimateBytes(stored))})`);
        if (mem) {
            const memIds = mem.map(x => x?.mesId).join(',');
            const storedIds = stored.map(x => x?.mesId).join(',');
            saveTest = memIds === storedIds;
            lines.push(`ST 저장 테스트: ${saveTest ? '성공 (메모리와 저장소 일치)' : '실패 (메모리의 기록이 저장되지 않음)'}`);
        }
    } catch (e) {
        lines.push(`ST 기본 저장소를 읽지 못함: ${e?.message ?? e}`);
    }
    const ext = (await listChats()).find(c => c.chatId === chatId);
    lines.push(`확장 저장소 기록: ${ext?.count ?? 0}개`);
    try {
        const est = await navigator.storage?.estimate?.();
        if (est?.quota) lines.push(`브라우저 저장 공간: ${formatBytes(est.usage)} / ${formatBytes(est.quota)}`);
    } catch { /* ignore */ }
    lines.push('');
    const warnings = [];
    if (saveTest === false) {
        warnings.push('⚠️ ST가 이 채팅의 프롬프트를 브라우저에 저장하지 못하고 있습니다. ST는 이 오류를 화면에 표시하지 않기 때문에, 새로고침하면 마지막으로 저장에 성공한 시점의 기록만 불러옵니다. (원인 예: 저장 공간 부족, 시크릿 모드 등에서 한 항목 크기 한도 약 127MB 초과) 확장 저장소에는 따로 저장되므로 계속 확인할 수 있습니다.');
    }
    if (memBytes > CHROMIUM_IDB_VALUE_LIMIT * 0.8) {
        warnings.push(`ℹ️ 이 채팅의 ST 프롬프트 기록이 약 ${formatBytes(memBytes)}로 매우 큽니다. ST는 저장할 때마다 이 전체를 한 덩어리로 다시 씁니다. 일부 브라우저(시크릿 모드, 일부 버전)는 한 항목이 약 127MB를 넘으면 저장을 거부합니다.`);
    }
    if (!warnings.length) warnings.push('✅ 특이사항 없음.');
    lines.push(...warnings);
    lines.push('', '참고: ST는 메시지당 프롬프트 하나만 저장합니다. 스와이프·재생성 시 이전 것은 덮어쓰고, 메시지를 지우면 그 기록도 지웁니다(1.16.0부터).');
    const pre = document.createElement('div');
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.textAlign = 'left';
    pre.textContent = lines.join('\n');
    await ctx.callGenericPopup(pre, ctx.POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
}

function bindSettingsUi() {
    const s = getSettings();
    const bindCheck = (id, key, after) => {
        const input = document.getElementById(id);
        input.checked = !!s[key];
        input.addEventListener('change', () => { saveSettings({ [key]: input.checked }); after?.(); });
    };
    bindCheck('pr_capture_enabled', 'captureEnabled');
    bindCheck('pr_capture_impersonate', 'captureImpersonate');
    bindCheck('pr_capture_quiet', 'captureQuiet');
    bindCheck('pr_save_details', 'saveDetails');
    bindCheck('pr_strip_media', 'stripMedia');
    bindCheck('pr_wand', 'showWandButton', updateWandButton);
    bindCheck('pr_auto_select', 'autoSelectCurrent');
    bindCheck('pr_wi_backup', 'wiBackup');

    const wiDays = document.getElementById('pr_wi_days');
    wiDays.value = String(s.wiRetentionDays ?? 0);
    wiDays.addEventListener('change', async () => {
        const v = Math.max(0, Math.floor(Number(wiDays.value) || 0));
        wiDays.value = String(v);
        saveSettings({ wiRetentionDays: v });
        if (v > 0) {
            const n = await pruneWiBackups(v);
            if (n) toastr.info(`${v}일 지난 월드인포 백업 ${n}개를 지웠습니다.`, '프롬프트 복원기');
            updateStorageInfo();
        }
    });

    const maxInput = document.getElementById('pr_max_per_chat');
    maxInput.value = String(s.maxPerChat ?? 0);
    maxInput.addEventListener('change', () => {
        const v = Math.max(0, Math.floor(Number(maxInput.value) || 0));
        maxInput.value = String(v);
        saveSettings({ maxPerChat: v });
    });
    const pageInput = document.getElementById('pr_page_size');
    pageInput.value = String(s.historyPageSize ?? 20);
    pageInput.addEventListener('change', () => {
        const v = Math.min(200, Math.max(5, Math.floor(Number(pageInput.value) || 20)));
        pageInput.value = String(v);
        saveSettings({ historyPageSize: v });
    });
    const theme = document.getElementById('pr_theme');
    theme.value = s.theme || 'st';
    theme.addEventListener('change', () => { saveSettings({ theme: theme.value }); refreshTheme(); });

    document.getElementById('pr_open_window').addEventListener('click', () => openMainWindow());
    document.getElementById('pr_refresh_stats').addEventListener('click', updateStorageInfo);
    document.getElementById('pr_persist').addEventListener('click', async () => {
        if (!navigator.storage?.persist) {
            toastr.warning('이 브라우저는 영구 보존 요청을 지원하지 않습니다.', '프롬프트 복원기');
            return;
        }
        const ok = await navigator.storage.persist();
        if (ok) toastr.success('영구 보존이 켜졌습니다.', '프롬프트 복원기');
        else toastr.warning('브라우저가 요청을 거절했습니다. (사이트를 즐겨찾기/홈 화면에 추가하거나 https로 접속하면 허용되는 경우가 많습니다)', '프롬프트 복원기');
        updateStorageInfo();
    });
    document.getElementById('pr_check_st').addEventListener('click', checkCurrentChat);
    document.getElementById('pr_rebuild').addEventListener('click', async () => {
        const n = await rebuildSummaries();
        toastr.success(`채팅방 ${n}개 목록을 다시 계산했습니다.`, '프롬프트 복원기');
        updateStorageInfo();
    });
    document.getElementById('pr_clear_all').addEventListener('click', async () => {
        const ctx = SillyTavern.getContext();
        const ok = await ctx.callGenericPopup('확장 저장소의 프롬프트 기록을 모두 지울까요? 되돌릴 수 없습니다.\n(월드인포 백업과 ST 기본 저장소는 그대로 둡니다)', ctx.POPUP_TYPE.CONFIRM);
        if (!ok) return;
        await clearAll();
        toastr.success('프롬프트 기록을 모두 지웠습니다.', '프롬프트 복원기');
        updateStorageInfo();
        handleCaptured({ chatId: null });
    });

    // Refresh the numbers whenever the drawer is opened.
    document.querySelector('#prompt_restorer_settings .inline-drawer-toggle')?.addEventListener('click', () => setTimeout(updateStorageInfo, 50));
}

// ------------------------------------------------------------------ wand menu

function updateWandButton() {
    const existing = document.getElementById('pr_wand_button');
    if (!getSettings().showWandButton) {
        existing?.remove();
        return;
    }
    if (existing) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const btn = document.createElement('div');
    btn.id = 'pr_wand_button';
    btn.className = 'list-group-item flex-container flexGap5 interactable';
    btn.tabIndex = 0;
    btn.title = '프롬프트 복원기 창 열기';
    btn.innerHTML = '<i class="fa-solid fa-clock-rotate-left extensionsMenuExtensionButton"></i><span>프롬프트 복원기</span>';
    btn.addEventListener('click', () => openMainWindow());
    menu.appendChild(btn);
}

function registerSlashCommand() {
    try {
        const { SlashCommandParser, SlashCommand } = SillyTavern.getContext();
        if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'prompt-restorer',
            callback: () => { openMainWindow(); return ''; },
            helpString: '프롬프트 복원기 창을 엽니다.',
        }));
    } catch (e) {
        console.warn('[PromptRestorer] slash command registration failed', e);
    }
}

// ------------------------------------------------------------------ init

jQuery(async () => {
    getSettings();
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    container?.insertAdjacentHTML('beforeend', SETTINGS_HTML);
    bindSettingsUi();

    initUi({ getSettings, saveSettings });

    const { itemizedModule, getChatCompletionModel } = await loadOptionalModules();
    itemizedRef = itemizedModule;
    initCapture({ getSettings, itemizedModule, getChatCompletionModel });
    onCaptured(handleCaptured);
    initWorldInfoBackup({ getSettings });
    onWiBackup(() => { handleWiChanged(); updateStorageInfo(); });

    updateWandButton();
    // The wand menu can be rebuilt late on slow loads.
    setTimeout(updateWandButton, 2000);
    registerSlashCommand();
    updateStorageInfo();
    console.log('[PromptRestorer] loaded');

    // Convert records saved by 3.0 (full copies) to the de-duplicated format, in the background.
    setTimeout(async () => {
        try {
            const n = await migrateLegacy();
            if (n) {
                toastr.success(`예전 기록 ${n}개를 중복 제거 형식으로 바꿨습니다.`, '프롬프트 복원기');
                handleCaptured({ chatId: null });
            }
            updateStorageInfo();
        } catch (e) {
            console.error('[PromptRestorer] migration failed', e);
        }
    }, 3000);
});
