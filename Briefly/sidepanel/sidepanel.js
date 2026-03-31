// ─────────────────────────────────────────────────────────────────
// sidepanel.js — Thin entry point
// ─────────────────────────────────────────────────────────────────

import { $, el, State, DEFAULT_SETTINGS, normalizeSettings, normalizeIntegrations, normalizeCustomRecipes, findTemplate, integrationLabel } from './modules/state.js';

import {
  initElements, setMode, showToast, openModal, closeModal, navigateTo,
  toggleSection, applyTheme, showTranscript, showLatestFollowUp, showOutputSection,
  showIntentBadge, appendStreamChunk, finalizeOutput,
  renderRecipeToolbar, renderHistoryList, renderLibraryList,
  renderIntegrationStatuses, renderContextSnapshot,
  populateTemplateSelect, populateSettingsFields, populateNewSettingsFields,
  syncPreferenceControls, updateSttBadge, drawWaveform,
  renderUsageDashboard, updateOAuthStatus
} from './modules/views.js';

import {
  initTabId,
  startRecording, stopRecording, toggleRecording,
  runCommand, prepareFreshGeneration, overrideIntent,
  submitRefine, toggleRefine,
  copyOutput, exportAs,
  loadHistory, deleteHistory, restoreHistory, saveToLibrary, clearHistory,
  exportTemplates, importTemplates, exportHistoryData, importHistoryData,
  updateRuntimeSetting, saveSettings, toggleTheme,
  setActiveTemplate, maybeAutoSelectTemplate,
  addCustomRecipeFromForm, resetCustomRecipeForm, handleCustomRecipeListClick,
  refreshContextSnapshot, scheduleAutorefreshContext, openContextReview,
  saveContextReviewPreferences, resetContextReviewPreferences,
  openIntegrationReview, selectIntegrationTarget, confirmRouteOutput,
  handleIntegrationOptionChange, loadPageActions, isIntegrationReady,
  submitFeedback, confirmRegenerate, loadUsageDashboard,
  initiateOAuth, initiateGitHubDeviceFlow, loadOAuthStatuses,
  clearAllData, toggleTranscriptEdit,
  retryLast, syncSessionToBackground,
  handleError, handleTabChangeForAutorefresh,
  clearDeviceFlowTimer
} from './modules/handlers.js';

// ── Init ──

async function init() {
  initElements();
  await Markdown.loadDependencies();
  populateTemplateSelect();
  await initTabId();
  await loadBootstrapData();
  bindEvents();
  setupMessageListener();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && State.settings.usePageContext && State.settings.autorefreshContext) {
      scheduleAutorefreshContext();
    }
  });
  applyTheme(State.settings.theme);
  updateSttBadge(State.settings.sttProvider);
  renderRecipeToolbar();
  renderHistoryList();
  renderLibraryList();
  renderIntegrationStatuses();
  syncPreferenceControls();
  populateNewSettingsFields();
  await refreshContextSnapshot();
  await hydrateSessionFromBackground();
  await loadUsageDashboard();
  await loadOAuthStatuses();

  // Offline detection
  window.addEventListener('online', () => {
    showToast('Back online', 'success');
  });
  window.addEventListener('offline', () => {
    showToast('You are offline. Some features may be unavailable.', 'error');
  });
}

// ── Bootstrap ──

async function loadBootstrapData() {
  const [{ settings = {}, history = [], library = [], integrations = {}, encryptedKeys = {} }] = await Promise.all([
    chrome.storage.local.get(['settings', 'history', 'library', 'integrations', 'encryptedKeys'])
  ]);

  State.settings = normalizeSettings(settings);
  State.customRecipes = normalizeCustomRecipes(State.settings.customRecipes || []);
  State.settings.customRecipes = State.customRecipes;
  if (!findTemplate(State.settings.activeTemplate)) {
    State.settings.activeTemplate = DEFAULT_SETTINGS.activeTemplate;
  }
  State.history = history;
  State.library = library;
  State.integrations = normalizeIntegrations(integrations);
  State.encryptedKeys = encryptedKeys;

  populateTemplateSelect();
  populateSettingsFields();
}

// ── Hydrate ──

async function hydrateSessionFromBackground() {
  await initTabId();
  if (State.tabId == null) return;

  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_SESSION', tabId: State.tabId });
    const session = response?.session;
    if (!session) return;

    if (!State.context && session.lastContext) {
      State.context = session.lastContext;
      renderContextSnapshot();
    }

    if (session.lastTranscript) {
      State.transcript = session.lastTranscript;
      showTranscript(session.lastTranscript);
    }

    showLatestFollowUp(session.lastRefinement || '');

    if (session.lastIntent) {
      State.intent = { primary_intent: session.lastIntent, confidence: 1 };
      showIntentBadge(State.intent);
    }

    if (session.lastOutput) {
      State.output = session.lastOutput;
      showOutputSection();
      el.markdownOutput.innerHTML = Markdown.render(State.output);
      setMode('done');
    }
  } catch {
    // Ignore hydration failures; panel can still operate with a fresh state.
  }
}

// ── Events ──

function bindEvents() {
  el.micBtn.addEventListener('click', toggleRecording);
  el.btnRunCommand.addEventListener('click', runCommand);
  el.commandInput.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      runCommand();
    }
  });

  el.recipeToolbar.addEventListener('click', async event => {
    const button = event.target.closest('[data-template-id]');
    if (!button) return;
    await setActiveTemplate(button.dataset.templateId);
  });

  el.btnRefreshContext.addEventListener('click', refreshContextSnapshot);
  el.btnReviewContext.addEventListener('click', openContextReview);
  el.togglePageContext.addEventListener('change', () => updateRuntimeSetting('usePageContext', el.togglePageContext.checked, true));
  el.toggleSelectionOnly.addEventListener('change', () => updateRuntimeSetting('selectionOnly', el.toggleSelectionOnly.checked, true));
  el.toggleVisionContext.addEventListener('change', () => updateRuntimeSetting('useVisionContext', el.toggleVisionContext.checked, false));
  el.toggleRedactSensitive.addEventListener('change', () => updateRuntimeSetting('redactSensitive', el.toggleRedactSensitive.checked, false));

  $('pref-use-page-context').addEventListener('change', () => updateRuntimeSetting('usePageContext', $('pref-use-page-context').checked, true));
  $('pref-autorefresh-context').addEventListener('change', () => updateRuntimeSetting('autorefreshContext', $('pref-autorefresh-context').checked, false));
  $('pref-selection-only').addEventListener('change', () => updateRuntimeSetting('selectionOnly', $('pref-selection-only').checked, true));
  $('pref-use-vision-context').addEventListener('change', () => updateRuntimeSetting('useVisionContext', $('pref-use-vision-context').checked, false));
  $('pref-thread-memory').addEventListener('change', () => updateRuntimeSetting('threadMemory', $('pref-thread-memory').checked, false));
  $('pref-redact-sensitive').addEventListener('change', () => updateRuntimeSetting('redactSensitive', $('pref-redact-sensitive').checked, false));
  $('settings-review-before-send').addEventListener('change', () => updateRuntimeSetting('reviewBeforeSend', $('settings-review-before-send').checked, false));
  $('default-template').addEventListener('change', event => setActiveTemplate(event.target.value));
  $('btn-add-custom-recipe').addEventListener('click', addCustomRecipeFromForm);
  $('btn-reset-custom-recipe').addEventListener('click', resetCustomRecipeForm);
  el.customRecipeList.addEventListener('click', handleCustomRecipeListClick);

  document.addEventListener('keydown', async event => {
    if (event.code === 'Space' && event.target === document.body) {
      event.preventDefault();
      if (!State.pushToTalkActive && ['idle', 'done', 'error'].includes(State.mode)) {
        State.pushToTalkActive = true;
        await startRecording();
      }
    }
    if (event.code === 'Escape') {
      if (State.mode === 'recording') {
        chrome.runtime.sendMessage({ type: 'CANCEL_RECORDING' });
      }
      closeModal('modal-export');
      closeModal('modal-integrate');
      el.errorOverlay.style.display = 'none';
      setMode('idle');
    }
  });

  document.addEventListener('keyup', async event => {
    if (event.code === 'Space' && State.pushToTalkActive) {
      State.pushToTalkActive = false;
      await stopRecording();
    }
  });

  el.btnCopy.addEventListener('click', copyOutput);
  el.btnExport.addEventListener('click', () => openModal('modal-export'));
  el.btnIntegrate.addEventListener('click', openIntegrationReview);
  el.btnRefine.addEventListener('click', toggleRefine);
  el.btnRefineSubmit.addEventListener('click', submitRefine);
  el.refineInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') submitRefine();
  });
  el.btnStar.addEventListener('click', saveToLibrary);

  el.btnTheme.addEventListener('click', toggleTheme);
  el.btnSettings.addEventListener('click', () => navigateTo('settings'));
  el.btnHistory.addEventListener('click', () => navigateTo('history'));
  el.btnLibrary.addEventListener('click', () => navigateTo('library'));

  document.querySelectorAll('[id^="btn-back-from"]').forEach(button => {
    button.addEventListener('click', () => navigateTo('main'));
  });

  $('btn-save-settings').addEventListener('click', saveSettings);
  $('btn-new-prompt').addEventListener('click', () => {
    navigateTo('main');
    el.commandInput.focus();
  });

  $('btn-clear-data').addEventListener('click', clearAllData);
  $('btn-open-help').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('help.html') }));
  $('btn-open-privacy').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('privacypolicy.html') }));

  $('history-toggle').addEventListener('click', () => toggleSection('history-body', 'history-toggle'));
  $('transcript-toggle').addEventListener('click', () => toggleSection('transcript-body', 'transcript-toggle'));

  $('btn-clear-all-history').addEventListener('click', clearHistory);
  $('btn-clear-history-view').addEventListener('click', clearHistory);
  el.historySearch.addEventListener('input', event => renderHistoryList(event.target.value));
  el.librarySearch.addEventListener('input', event => renderLibraryList(event.target.value));

  $('export-md').addEventListener('click', () => exportAs('md'));
  $('export-txt').addEventListener('click', () => exportAs('txt'));
  $('export-json').addEventListener('click', () => exportAs('json'));
  $('btn-close-export').addEventListener('click', () => closeModal('modal-export'));

  $('btn-close-integrate').addEventListener('click', () => closeModal('modal-integrate'));
  $('btn-close-context-review').addEventListener('click', () => closeModal('modal-context-review'));
  $('btn-apply-context-review').addEventListener('click', saveContextReviewPreferences);
  $('btn-reset-context-review').addEventListener('click', resetContextReviewPreferences);
  el.integrationOptions.addEventListener('change', handleIntegrationOptionChange);
  el.integrationTargetList.addEventListener('click', event => {
    const button = event.target.closest('[data-target]');
    if (!button) return;
    selectIntegrationTarget(button.dataset.target);
  });
  el.btnConfirmIntegrate.addEventListener('click', confirmRouteOutput);

  $('btn-error-primary').addEventListener('click', () => {
    if (State.lastErrorType === 'mic_denied') {
      chrome.tabs.create({ url: 'chrome://settings/content/microphone' });
      return;
    }
    retryLast();
  });
  $('btn-error-dismiss').addEventListener('click', () => {
    el.errorOverlay.style.display = 'none';
    setMode('idle');
  });

  document.querySelectorAll('.toggle-visibility-btn').forEach(button => {
    button.addEventListener('click', () => {
      const input = $(button.dataset.target);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
      button.textContent = input.type === 'password' ? 'Show' : 'Hide';
    });
  });

  $('btn-refine-voice').addEventListener('click', () => startRecording('refine'));
  $('btn-edit-transcript').addEventListener('click', toggleTranscriptEdit);

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', event => {
      if (event.target === overlay) overlay.style.display = 'none';
    });
  });

  // ── FEEDBACK ──
  const feedbackUpBtn = $('btn-feedback-up');
  const feedbackDownBtn = $('btn-feedback-down');
  const feedbackNote = $('feedback-note');
  const feedbackSubmitBtn = $('btn-feedback-submit');

  if (feedbackUpBtn) feedbackUpBtn.addEventListener('click', () => submitFeedback('positive'));
  if (feedbackDownBtn) feedbackDownBtn.addEventListener('click', () => {
    State.lastFeedbackRating = 'negative';
    if (feedbackNote) feedbackNote.style.display = '';
    if (feedbackSubmitBtn) feedbackSubmitBtn.style.display = '';
  });
  if (feedbackSubmitBtn) feedbackSubmitBtn.addEventListener('click', () => {
    submitFeedback('negative', feedbackNote?.value || '');
  });

  // ── REGENERATE ──
  const regenBtn = $('btn-regenerate');
  if (regenBtn) regenBtn.addEventListener('click', () => openModal('modal-regenerate'));
  const confirmRegenBtn = $('btn-confirm-regenerate');
  if (confirmRegenBtn) confirmRegenBtn.addEventListener('click', confirmRegenerate);
  const closeRegenBtn = $('btn-close-regenerate');
  if (closeRegenBtn) closeRegenBtn.addEventListener('click', () => closeModal('modal-regenerate'));

  const closeDeviceFlowBtn = $('btn-close-device-flow');
  if (closeDeviceFlowBtn) closeDeviceFlowBtn.addEventListener('click', () => {
    clearDeviceFlowTimer();
    closeModal('modal-github-device-flow');
  });

  // ── LLM PROVIDER ──
  const llmProviderSelect = $('llm-provider');
  if (llmProviderSelect) {
    llmProviderSelect.addEventListener('change', () => {
      const isOllama = llmProviderSelect.value === 'ollama';
      const ollamaSettings = $('ollama-settings');
      const ollamaModelField = $('ollama-model-field');
      if (ollamaSettings) ollamaSettings.style.display = isOllama ? '' : 'none';
      if (ollamaModelField) ollamaModelField.style.display = isOllama ? '' : 'none';
      const hint = $('llm-provider-hint');
      if (hint) {
        if (llmProviderSelect.value === 'ollama') hint.textContent = 'Ollama runs locally. No API key needed, no data leaves your machine.';
        else hint.textContent = 'Your API key is encrypted and never leaves your browser.';
      }
    });
  }

  // ── USAGE ──
  const clearUsageBtn = $('btn-clear-usage');
  if (clearUsageBtn) clearUsageBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_USAGE' });
    State.usageTotals = { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0 };
    renderUsageDashboard();
    showToast('Usage data cleared', 'success');
  });

  // ── TEAM TEMPLATE IMPORT/EXPORT ──
  const exportTemplatesBtn = $('btn-export-templates');
  if (exportTemplatesBtn) exportTemplatesBtn.addEventListener('click', exportTemplates);
  const importTemplatesBtn = $('btn-import-templates');
  const fileImportTemplates = $('file-import-templates');
  if (importTemplatesBtn && fileImportTemplates) {
    importTemplatesBtn.addEventListener('click', () => fileImportTemplates.click());
    fileImportTemplates.addEventListener('change', importTemplates);
  }
  const exportHistoryBtn = $('btn-export-history');
  if (exportHistoryBtn) exportHistoryBtn.addEventListener('click', exportHistoryData);
  const importHistoryBtn = $('btn-import-history');
  const fileImportHistory = $('file-import-history');
  if (importHistoryBtn && fileImportHistory) {
    importHistoryBtn.addEventListener('click', () => fileImportHistory.click());
    fileImportHistory.addEventListener('change', importHistoryData);
  }

  // ── OAUTH ──
  const oauthGithub = $('btn-oauth-github');
  if (oauthGithub) oauthGithub.addEventListener('click', () => initiateOAuth('github'));
  const oauthNotion = $('btn-oauth-notion');
  if (oauthNotion) oauthNotion.addEventListener('click', () => initiateOAuth('notion'));
  const oauthSlack = $('btn-oauth-slack');
  if (oauthSlack) oauthSlack.addEventListener('click', () => initiateOAuth('slack'));
}

// ── Message Listener ──

function setupMessageListener() {
  chrome.runtime.onMessage.addListener(msg => {
    switch (msg.type) {
      case 'RECORDING_STARTED':
        setMode('recording');
        break;
      case 'RECORDING_CANCELLED':
        State.captureMode = 'default';
        setMode('idle');
        break;
      case 'STATE_TRANSCRIBING':
        setMode('transcribing');
        if (msg.totalSegments > 1) {
          el.micHint.textContent = `Transcribing segment 1/${msg.totalSegments}...`;
        }
        break;
      case 'STATE_GENERATING':
        setMode('generating');
        break;
      case 'TRANSCRIPT_PROGRESS':
        if (State.captureMode === 'refine') {
          el.refineInput.value = msg.transcript;
        } else {
          showTranscript(msg.transcript);
        }
        if (msg.totalSegments > 1) {
          el.micHint.textContent = `Transcribing segment ${msg.completedSegments}/${msg.totalSegments}...`;
        }
        break;
      case 'TRANSCRIPT_READY':
        if (State.captureMode === 'refine') {
          el.refineInput.value = msg.transcript;
        } else {
          showTranscript(msg.transcript);
        }
        break;
      case 'INTENT_LOCAL':
      case 'INTENT_SERVER':
        State.intent = msg.intent;
        showIntentBadge(msg.intent);
        break;
      case 'STREAM_CHUNK':
        appendStreamChunk(msg.text);
        break;
      case 'GENERATION_COMPLETE':
        State.captureMode = 'default';
        State.output = msg.output;
        setMode('done');
        finalizeOutput();
        break;
      case 'WAVEFORM_DATA':
        if (State.mode === 'recording') drawWaveform(msg.data);
        break;
      case 'HISTORY_UPDATED':
        loadHistory();
        break;
      case 'ROUTE_SUCCESS':
        showToast(`Sent to ${integrationLabel(msg.target)}`, 'success');
        closeModal('modal-integrate');
        break;
      case 'ERROR':
        State.captureMode = 'default';
        handleError(msg.error, msg.message);
        break;
      case 'SHORTCUT_PUSH_TO_TALK':
        toggleRecording();
        break;
      case 'SHORTCUT_COPY':
        copyOutput();
        break;
      case 'SHORTCUT_HISTORY':
        navigateTo('history');
        break;
      case 'SHORTCUT_RETRY':
        retryLast();
        break;
      case 'BUDGET_WARNING': {
        const fmt = v => `$${v.toFixed(4)}`;
        if (msg.level === 'exceeded') {
          showToast(`Monthly budget exceeded (${fmt(msg.totalCost)} / ${fmt(msg.budget)})`, 'error');
        } else if (msg.level === 'danger') {
          showToast(`Budget 90%+ used — ${fmt(msg.totalCost)} of ${fmt(msg.budget)}`, 'error');
        } else {
          showToast(`Budget 80%+ used — ${fmt(msg.totalCost)} of ${fmt(msg.budget)}`, 'info');
        }
        break;
      }
      case 'TAB_CHANGED':
      case 'TAB_NAVIGATED':
        handleTabChangeForAutorefresh(msg);
        break;
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
