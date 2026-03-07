'use strict';

const DEFAULT_CONTEXT_SIGNAL_PREFS = {
  selectedText: true,
  visibleText: true,
  codeBlocks: true,
  headings: true,
  formFields: true,
  structuredData: true,
  domainArtifacts: true,
  screenshot: true
};

const DEFAULT_SETTINGS = {
  sttProvider: 'whisper',
  language: 'auto',
  tone: 'auto',
  outputFormat: 'markdown',
  qualityMode: 'balanced',
  theme: 'dark',
  activeTemplate: 'general_assistant',
  usePageContext: true,
  selectionOnly: false,
  useVisionContext: false,
  threadMemory: true,
  redactSensitive: true,
  reviewBeforeSend: true,
  webhookUrl: '',
  customRecipes: [],
  contextSignalPrefs: { ...DEFAULT_CONTEXT_SIGNAL_PREFS }
};

const TEMPLATE_DEFS = [
  {
    id: 'general_assistant',
    label: 'General',
    summary: 'High-signal summary with decisions, risks, and actions',
    defaultRequest: 'Summarize this page into the key points, important decisions, risks, and next actions. Keep it concise and high signal.'
  },
  {
    id: 'bug_report',
    label: 'Bug Report',
    summary: 'Evidence-based defect report',
    defaultRequest: 'Create a precise bug report from this page. Include summary, impact, steps to reproduce, expected result, actual result, evidence, likely cause, environment, and open questions.'
  },
  {
    id: 'pr_review',
    label: 'PR Review',
    summary: 'Senior review with findings first',
    defaultRequest: 'Review this like a pull request. Lead with concrete findings ordered by severity, then mention residual risks and missing tests.'
  },
  {
    id: 'test_plan',
    label: 'Test Plan',
    summary: 'QA coverage across happy, edge, and failure paths',
    defaultRequest: 'Create a QA test plan from this context with objective, scope, happy paths, edge cases, negative cases, regression risks, automation candidates, and setup needs.'
  },
  {
    id: 'product_spec',
    label: 'Spec',
    summary: 'Structured product spec with open decisions',
    defaultRequest: 'Turn this into a product spec with problem, users, goals, non-goals, user flows, requirements, edge cases, dependencies, launch risks, and success metrics.'
  },
  {
    id: 'release_notes',
    label: 'Release Notes',
    summary: 'Customer-facing release summary',
    defaultRequest: 'Draft release notes from this page with a short headline, customer-facing highlights, operational notes, risks or caveats, and follow-up items.'
  },
  {
    id: 'customer_reply',
    label: 'Customer Reply',
    summary: 'Concise, empathetic message ready to send',
    defaultRequest: 'Draft a concise customer reply based on this page. Be empathetic, specific, and include the next step or clear ask.'
  }
];

const PAGE_TYPE_TEMPLATE_RULES = {
  'github-pr': { templateId: 'pr_review', reason: 'Pull request page' },
  'github-code': { templateId: 'pr_review', reason: 'Code page' },
  'github-issue': { templateId: 'bug_report', reason: 'Issue page' },
  'jira-ticket': { templateId: 'bug_report', reason: 'Jira issue' },
  'linear-issue': { templateId: 'bug_report', reason: 'Linear issue' },
  'confluence-doc': { templateId: 'product_spec', reason: 'Documentation page' },
  'notion-page': { templateId: 'product_spec', reason: 'Workspace doc' },
  documentation: { templateId: 'general_assistant', reason: 'Documentation page' },
  'research-paper': { templateId: 'general_assistant', reason: 'Research page' },
  article: { templateId: 'general_assistant', reason: 'Article page' },
  slack: { templateId: 'customer_reply', reason: 'Conversation page' },
  technical: { templateId: 'pr_review', reason: 'Technical page' }
};

const INTEGRATION_DEFS = [
  { id: 'page', label: 'Apply to Page', key: null },
  { id: 'notion', label: 'Notion', key: 'notion' },
  { id: 'github', label: 'GitHub', key: 'github' },
  { id: 'jira', label: 'Jira', key: 'jira' },
  { id: 'linear', label: 'Linear', key: 'linear' },
  { id: 'slack', label: 'Slack', key: 'slack' },
  { id: 'confluence', label: 'Confluence', key: 'confluence' },
  { id: 'webhook', label: 'Webhook', key: null }
];

const State = {
  mode: 'idle',
  tabId: null,
  transcript: '',
  output: '',
  intent: null,
  context: null,
  history: [],
  library: [],
  pageActions: [],
  settings: { ...DEFAULT_SETTINGS },
  customRecipes: [],
  integrations: {},
  encryptedKeys: {},
  currentView: 'main',
  isStreaming: false,
  pushToTalkActive: false,
  lastErrorType: null,
  pendingRouteTarget: null,
  deliveryOptions: {
    page: { actionTargetId: '', mode: 'auto', submitActionId: '' },
    github: { mode: 'auto' },
    jira: { mode: 'auto' }
  },
  captureMode: 'default',
  manualTemplateOverride: false,
  autoTemplateKey: '',
  lastAutoTemplateId: null
};

const $ = id => document.getElementById(id);
const el = {
  micBtn: $('mic-btn'),
  micWrapper: $('mic-wrapper'),
  micSpinner: $('mic-spinner'),
  micHint: $('mic-hint'),
  sttLabel: $('stt-label'),
  waveformCanvas: $('waveform-canvas'),
  recipeToolbar: $('recipe-toolbar'),
  commandInput: $('command-input'),
  btnRunCommand: $('btn-run-command'),
  btnRefreshContext: $('btn-refresh-context'),
  btnReviewContext: $('btn-review-context'),
  togglePageContext: $('toggle-page-context'),
  toggleSelectionOnly: $('toggle-selection-only'),
  toggleVisionContext: $('toggle-vision-context'),
  toggleRedactSensitive: $('toggle-redact-sensitive'),
  contextPageTitle: $('context-page-title'),
  contextMeta: $('context-meta'),
  contextSelection: $('context-selection'),
  contextSignalList: $('context-signal-list'),
  contextLastUpdated: $('context-last-updated'),
  intentRow: $('intent-row'),
  intentBadge: $('intent-badge'),
  intentIcon: $('intent-icon'),
  intentName: $('intent-name'),
  intentConfidence: $('intent-confidence'),
  intentSuggestions: $('intent-suggestions'),
  transcriptSection: $('transcript-section'),
  transcriptBody: $('transcript-body'),
  transcriptText: $('transcript-text'),
  outputSection: $('output-section'),
  markdownOutput: $('markdown-output'),
  streamingDots: $('streaming-dots'),
  actionBar: $('action-bar'),
  btnCopy: $('btn-copy'),
  btnExport: $('btn-export'),
  btnIntegrate: $('btn-integrate'),
  btnRefine: $('btn-refine'),
  refineSection: $('refine-section'),
  refineInput: $('refine-input'),
  btnRefineSubmit: $('btn-refine-submit'),
  historyList: $('history-list'),
  historyEmpty: $('history-empty'),
  historyCount: $('history-count'),
  historyListFull: $('history-list-full'),
  historySearch: $('history-search'),
  libraryList: $('library-list'),
  libraryEmpty: $('library-empty'),
  librarySearch: $('library-search'),
  toastContainer: $('toast-container'),
  errorOverlay: $('error-overlay'),
  errorIcon: $('error-icon'),
  errorTitle: $('error-title'),
  errorMessage: $('error-message'),
  btnTheme: $('btn-theme'),
  btnSettings: $('btn-settings'),
  btnHistory: $('btn-history'),
  btnLibrary: $('btn-library'),
  btnStar: $('btn-star'),
  modalExport: $('modal-export'),
  modalIntegrate: $('modal-integrate'),
  integrationTargetList: $('integration-target-list'),
  integrationPreviewTitle: $('integration-preview-title'),
  integrationPreviewMeta: $('integration-preview-meta'),
  integrationPreviewBody: $('integration-preview-body'),
  integrationOptions: $('integration-options'),
  btnConfirmIntegrate: $('btn-confirm-integrate'),
  customRecipeList: $('custom-recipe-list'),
  modalContextReview: $('modal-context-review'),
  contextReviewList: $('context-review-list')
};

const wctx = el.waveformCanvas.getContext('2d');

let streamCursor = null;
let streamBuffer = '';

async function init() {
  await Markdown.loadDependencies();
  populateTemplateSelect();
  await initTabId();
  await loadBootstrapData();
  bindEvents();
  setupMessageListener();
  applyTheme(State.settings.theme);
  updateSttBadge(State.settings.sttProvider);
  renderRecipeToolbar();
  renderHistoryList();
  renderLibraryList();
  renderIntegrationStatuses();
  syncPreferenceControls();
  await refreshContextSnapshot();
  await hydrateSessionFromBackground();
}

async function initTabId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    State.tabId = tab?.id || null;
  } catch {
    State.tabId = null;
  }
}

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

function normalizeIntegrations(integrations = {}) {
  return {
    notion: { defaultPageId: integrations.notion?.defaultPageId || '' },
    github: { defaultRepo: integrations.github?.defaultRepo || '' },
    jira: {
      jiraDomain: integrations.jira?.jiraDomain || '',
      jiraEmail: integrations.jira?.jiraEmail || '',
      jiraProject: integrations.jira?.jiraProject || ''
    },
    linear: { teamId: integrations.linear?.teamId || '' },
    confluence: {
      confluenceDomain: integrations.confluence?.confluenceDomain || '',
      confluenceEmail: integrations.confluence?.confluenceEmail || '',
      confluencePageId: integrations.confluence?.confluencePageId || ''
    }
  };
}

function populateTemplateSelect() {
  const select = $('default-template');
  select.innerHTML = getAllTemplates()
    .map(template => `<option value="${template.id}">${template.label}</option>`)
    .join('');
}

function populateSettingsFields() {
  $('stt-provider').value = State.settings.sttProvider;
  $('stt-language').value = State.settings.language;
  $('output-tone').value = State.settings.tone;
  $('output-format').value = State.settings.outputFormat;
  $('quality-mode').value = State.settings.qualityMode;
  $('default-template').value = State.settings.activeTemplate;
  $('settings-review-before-send').checked = State.settings.reviewBeforeSend;
  $('pref-use-page-context').checked = State.settings.usePageContext;
  $('pref-selection-only').checked = State.settings.selectionOnly;
  $('pref-use-vision-context').checked = State.settings.useVisionContext;
  $('pref-thread-memory').checked = State.settings.threadMemory;
  $('pref-redact-sensitive').checked = State.settings.redactSensitive;
  $('notion-page-id').value = State.integrations.notion.defaultPageId;
  $('github-default-repo').value = State.integrations.github.defaultRepo;
  $('jira-domain').value = State.integrations.jira.jiraDomain;
  $('jira-email').value = State.integrations.jira.jiraEmail;
  $('jira-project').value = State.integrations.jira.jiraProject;
  $('linear-team-id').value = State.integrations.linear.teamId;
  $('confluence-domain').value = State.integrations.confluence.confluenceDomain;
  $('confluence-email').value = State.integrations.confluence.confluenceEmail;
  $('confluence-page-id').value = State.integrations.confluence.confluencePageId;
  renderCustomRecipeList();
}

function syncPreferenceControls() {
  el.togglePageContext.checked = State.settings.usePageContext;
  el.toggleSelectionOnly.checked = State.settings.selectionOnly;
  el.toggleVisionContext.checked = State.settings.useVisionContext;
  el.toggleRedactSensitive.checked = State.settings.redactSensitive;
  $('pref-use-page-context').checked = State.settings.usePageContext;
  $('pref-selection-only').checked = State.settings.selectionOnly;
  $('pref-use-vision-context').checked = State.settings.useVisionContext;
  $('pref-thread-memory').checked = State.settings.threadMemory;
  $('pref-redact-sensitive').checked = State.settings.redactSensitive;
  $('default-template').value = State.settings.activeTemplate;
  $('settings-review-before-send').checked = State.settings.reviewBeforeSend;
  updateCommandPlaceholder();
}

function updateCommandPlaceholder() {
  const template = findTemplate(State.settings.activeTemplate) || getAllTemplates()[0];
  el.commandInput.placeholder = `Typed command for ${template.label}, or leave empty to run: ${template.defaultRequest}`;
}

function renderRecipeToolbar() {
  el.recipeToolbar.innerHTML = getAllTemplates().map(template => `
    <button class="recipe-chip ${template.id === State.settings.activeTemplate ? 'active' : ''}" data-template-id="${template.id}" title="${escHtml(template.summary)}">
      <span>${escHtml(template.label)}</span>
    </button>
  `).join('');
}

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
    }
  });
}

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
}

function setMode(mode) {
  State.mode = mode;
  const micIcon = el.micBtn.querySelector('.mic-icon-idle');
  const stopIcon = el.micBtn.querySelector('.mic-icon-recording');

  el.micWrapper.classList.remove('recording');
  el.micBtn.classList.remove('recording', 'processing');
  el.micSpinner.style.display = 'none';
  micIcon.style.display = '';
  stopIcon.style.display = 'none';

  switch (mode) {
    case 'idle':
      el.micHint.textContent = 'Hold Space or click to speak';
      el.waveformCanvas.classList.remove('visible');
      break;
    case 'recording':
      el.micWrapper.classList.add('recording');
      el.micBtn.classList.add('recording');
      micIcon.style.display = 'none';
      stopIcon.style.display = '';
      el.micHint.textContent = 'Recording... release Space or click to stop';
      el.waveformCanvas.classList.add('visible');
      break;
    case 'transcribing':
      el.micBtn.classList.add('processing');
      el.micSpinner.style.display = 'grid';
      el.micHint.textContent = 'Transcribing...';
      break;
    case 'generating':
      el.micBtn.classList.add('processing');
      el.micSpinner.style.display = 'grid';
      el.micHint.textContent = 'Generating...';
      showOutputSection(true);
      break;
    case 'done':
      el.micHint.textContent = 'Draft ready. Refine it, save it, or route it.';
      el.streamingDots.style.display = 'none';
      break;
    case 'error':
      el.micHint.textContent = 'Something failed. Fix it or try again.';
      break;
  }
}

async function startRecording(mode = 'default') {
  if (State.mode === 'recording') return;
  State.captureMode = mode;
  await initTabId();
  await chrome.runtime.sendMessage({
    type: 'START_RECORDING',
    config: {
      provider: State.settings.sttProvider,
      mode
    }
  });
}

async function stopRecording() {
  if (State.mode !== 'recording') return;
  await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
}

async function toggleRecording() {
  if (['idle', 'done', 'error'].includes(State.mode)) {
    await startRecording();
  } else if (State.mode === 'recording') {
    await stopRecording();
  }
}

async function runCommand() {
  await initTabId();
  const request = el.commandInput.value.trim() || defaultRequestForTemplate(State.settings.activeTemplate);
  if (!request) {
    showToast('Type a command or choose a recipe first.', 'error');
    return;
  }

  State.transcript = request;
  State.intent = null;
  showTranscript(request);
  prepareFreshGeneration();
  setMode('generating');
  await chrome.runtime.sendMessage({ type: 'PROCESS_TEXT', text: request, tabId: State.tabId });
}

function prepareFreshGeneration() {
  State.output = '';
  State.isStreaming = false;
  State.intent = null;
  streamBuffer = '';
  el.markdownOutput.innerHTML = '';
  el.btnStar.classList.remove('starred');
  el.intentRow.style.display = 'none';
  el.intentSuggestions.style.display = 'none';
  showOutputSection(true);
}

function defaultRequestForTemplate(templateId) {
  return findTemplate(templateId)?.defaultRequest || '';
}

async function refreshContextSnapshot() {
  await initTabId();
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTEXT', includeScreenshot: false });
    State.context = response?.context || null;
  } catch {
    State.context = null;
  }
  await maybeAutoSelectTemplate(State.context);
  renderContextSnapshot();
}

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

function renderContextSnapshot() {
  if (!State.settings.usePageContext) {
    el.contextPageTitle.textContent = 'Page context is disabled';
    el.contextMeta.textContent = 'Only your direct command will be sent until you re-enable context.';
    el.contextSelection.textContent = 'Turn page context back on to inspect the current tab.';
    el.contextSignalList.innerHTML = '';
    el.contextLastUpdated.textContent = 'Context off';
    return;
  }

  if (!State.context) {
    el.contextPageTitle.textContent = 'No active tab context';
    el.contextMeta.textContent = 'Open a regular webpage and refresh context.';
    el.contextSelection.textContent = 'Nothing captured yet.';
    el.contextSignalList.innerHTML = '';
    el.contextLastUpdated.textContent = 'Unavailable';
    return;
  }

  const {
    pageTitle,
    domain,
    pageType,
    selectedText,
    codeBlocks = [],
    headings = [],
    formFields = [],
    visibleText = '',
    visibleTextLimit = 0,
    extractedAt
  } = State.context;
  el.contextPageTitle.textContent = pageTitle || 'Untitled page';
  el.contextMeta.textContent = `${domain || 'Unknown domain'} / ${formatPageTypeLabel(pageType)}${State.settings.selectionOnly ? ' / selection-first mode' : ''}`;
  el.contextSelection.textContent = selectedText
    ? `Selection: ${selectedText.slice(0, 180)}${selectedText.length > 180 ? '...' : ''}`
    : 'No selected text detected. Briefly will use the broader page snapshot.';

  const visibleSignal = visibleText
    ? visibleTextLimit && visibleText.length >= visibleTextLimit
      ? `Focused snapshot ${visibleText.length} chars`
      : `${visibleText.length} chars visible`
    : 'No visible text snapshot';
  el.contextLastUpdated.textContent = extractedAt ? I18n.relativeTime(extractedAt) : 'Just now';

  const signals = [
    `${selectedText ? 'Selection present' : 'No selection'}`,
    `${codeBlocks.length} code block${codeBlocks.length === 1 ? '' : 's'}`,
    `${headings.length} heading${headings.length === 1 ? '' : 's'}`,
    `${formFields.length} field${formFields.length === 1 ? '' : 's'}`,
    visibleSignal
  ];

  if (State.settings.useVisionContext) signals.push('Screenshot attached on send');
  if (hasFilteredContextSignals()) signals.push('Context filtering active');
  if (State.settings.redactSensitive) signals.push('Sensitive strings redacted');

  el.contextSignalList.innerHTML = signals.map(signal => `<span class="signal-chip">${escHtml(signal)}</span>`).join('');
}

function showTranscript(text) {
  State.transcript = text || '';
  el.transcriptSection.style.display = '';
  el.transcriptText.textContent = State.transcript;
}

function showOutputSection(loading = false) {
  el.outputSection.style.display = '';
  el.actionBar.style.display = '';
  if (loading) el.streamingDots.style.display = 'flex';
}

function appendStreamChunk(text) {
  if (!State.isStreaming) {
    State.isStreaming = true;
    streamBuffer = '';
    el.streamingDots.style.display = 'none';
    el.markdownOutput.innerHTML = '';
  }

  streamBuffer += text;
  el.markdownOutput.innerHTML = Markdown.render(streamBuffer);
  streamCursor = document.createElement('span');
  streamCursor.className = 'stream-cursor';
  el.markdownOutput.appendChild(streamCursor);
}

function finalizeOutput() {
  State.isStreaming = false;
  if (streamCursor) streamCursor.remove();
  el.markdownOutput.innerHTML = Markdown.render(State.output);
  el.actionBar.style.display = '';
}

function showIntentBadge(intent) {
  if (!intent?.primary_intent) return;

  el.intentRow.style.display = '';
  el.intentBadge.dataset.intent = intent.primary_intent;
  el.intentIcon.textContent = getIntentIcon(intent.primary_intent);
  el.intentName.textContent = getIntentLabel(intent.primary_intent);
  el.intentConfidence.textContent = `${Math.round((intent.confidence || 0) * 100)}%`;
  el.intentSuggestions.innerHTML = '<span class="suggestions-label">Try</span>';

  if (intent.fallback || (intent.confidence || 0) < 0.7) {
    el.intentBadge.classList.add('low-confidence');
    (intent.top3 || []).slice(1, 4).forEach(option => {
      const button = document.createElement('button');
      button.className = 'suggestion-pill';
      button.textContent = getIntentLabel(option);
      button.addEventListener('click', () => overrideIntent(option));
      el.intentSuggestions.appendChild(button);
    });
    el.intentSuggestions.style.display = intent.top3?.length > 1 ? 'flex' : 'none';
  } else {
    el.intentBadge.classList.remove('low-confidence');
    el.intentSuggestions.style.display = 'none';
  }
}

async function overrideIntent(intent) {
  prepareFreshGeneration();
  setMode('generating');
  await chrome.runtime.sendMessage({ type: 'PROCESS_TEXT', text: State.transcript, intent, tabId: State.tabId });
}

function getIntentIcon(intent) {
  const icons = {
    summarize: 'S',
    prompt_generation: 'P',
    task_extraction: 'T',
    documentation: 'D',
    testing: 'Q',
    code_review: 'R',
    user_story: 'U',
    explain: 'E',
    translate_intent: 'L',
    email_draft: 'M',
    compare: 'C',
    custom: 'A'
  };
  return icons[intent] || 'A';
}

function getIntentLabel(intent) {
  const labels = {
    summarize: 'Summarize',
    prompt_generation: 'Prompt',
    task_extraction: 'Tasks',
    documentation: 'Docs',
    testing: 'Testing',
    code_review: 'Review',
    user_story: 'User Story',
    explain: 'Explain',
    translate_intent: 'Translate',
    email_draft: 'Email',
    compare: 'Compare',
    custom: 'Assistant'
  };
  return labels[intent] || 'Assistant';
}

function drawWaveform(dataArray) {
  const width = el.waveformCanvas.width;
  const height = el.waveformCanvas.height;
  wctx.clearRect(0, 0, width, height);

  const gradient = wctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, '#ff7c43');
  gradient.addColorStop(1, '#4dbead');
  wctx.strokeStyle = gradient;
  wctx.lineWidth = 2;
  wctx.beginPath();

  const sliceWidth = width / dataArray.length;
  let x = 0;
  for (let i = 0; i < dataArray.length; i += 1) {
    const value = dataArray[i] / 128.0;
    const y = (value * height) / 2;
    if (i === 0) wctx.moveTo(x, y);
    else wctx.lineTo(x, y);
    x += sliceWidth;
  }
  wctx.lineTo(width, height / 2);
  wctx.stroke();
}

async function loadHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  State.history = history;
  renderHistoryList();
}

function renderHistoryList(filter = '') {
  const items = filter
    ? State.history.filter(entry =>
        entry.transcript?.toLowerCase().includes(filter.toLowerCase()) ||
        entry.output?.toLowerCase().includes(filter.toLowerCase())
      )
    : State.history;

  el.historyEmpty.style.display = items.length ? 'none' : '';
  el.historyCount.textContent = State.history.length;
  el.historyList.innerHTML = '';
  el.historyListFull.innerHTML = '';

  items.slice(0, 5).forEach(item => el.historyList.appendChild(createHistoryItem(item)));
  items.forEach(item => el.historyListFull.appendChild(createHistoryItem(item)));
  $('btn-clear-all-history').style.display = State.history.length ? '' : 'none';
}

function createHistoryItem(entry) {
  const item = document.createElement('li');
  item.className = 'history-item';
  item.innerHTML = `
    <div class="history-item-icon">${getIntentIcon(entry.intent || 'custom')}</div>
    <div class="history-item-info">
      <div class="history-item-title">${escHtml(entry.transcript?.slice(0, 72) || 'No transcript')}</div>
      <div class="history-item-meta">
        <span>${getIntentLabel(entry.intent || 'custom')}</span>
        <span>${I18n.relativeTime(entry.timestamp)}</span>
      </div>
    </div>
    <button class="history-item-delete" aria-label="Delete">Delete</button>
  `;

  item.addEventListener('click', event => {
    if (event.target.closest('.history-item-delete')) {
      deleteHistory(entry.id);
      return;
    }
    restoreHistory(entry);
  });

  return item;
}

async function deleteHistory(id) {
  State.history = State.history.filter(entry => entry.id !== id);
  await chrome.storage.local.set({ history: State.history });
  renderHistoryList(el.historySearch.value);
  showToast('Removed from history', 'success');
}

function restoreHistory(entry) {
  State.transcript = entry.transcript || '';
  State.output = entry.output || '';
  State.intent = entry.intent ? { primary_intent: entry.intent, confidence: 1 } : null;
  State.context = entry.context || State.context;
  renderContextSnapshot();
  showTranscript(State.transcript);
  if (State.intent) showIntentBadge(State.intent);
  el.outputSection.style.display = '';
  el.actionBar.style.display = '';
  el.markdownOutput.innerHTML = Markdown.render(State.output);
  setMode('done');
  syncSessionToBackground();
  navigateTo('main');
}

function renderLibraryList(filter = '', tag = 'all') {
  const items = State.library.filter(entry => {
    const matchesFilter = !filter ||
      entry.title?.toLowerCase().includes(filter.toLowerCase()) ||
      entry.output?.toLowerCase().includes(filter.toLowerCase());
    const matchesTag = tag === 'all' || entry.tags?.includes(tag);
    return matchesFilter && matchesTag;
  });

  el.libraryEmpty.style.display = items.length ? 'none' : '';
  el.libraryList.innerHTML = '';

  const tagRow = $('tag-filter-row');
  const tags = [...new Set(State.library.flatMap(entry => entry.tags || []))];
  tagRow.innerHTML = `<button class="tag-pill ${tag === 'all' ? 'active' : ''}" data-tag="all">All</button>`;
  tagRow.querySelector('[data-tag="all"]')?.addEventListener('click', () => renderLibraryList(filter, 'all'));
  tags.forEach(currentTag => {
    const button = document.createElement('button');
    button.className = `tag-pill ${tag === currentTag ? 'active' : ''}`;
    button.dataset.tag = currentTag;
    button.textContent = currentTag;
    button.addEventListener('click', () => renderLibraryList(filter, currentTag));
    tagRow.appendChild(button);
  });

  items.forEach(entry => {
    const item = document.createElement('li');
    item.className = 'library-item';
    item.innerHTML = `
      <div>
        <div class="library-item-title">${escHtml(entry.title || entry.transcript?.slice(0, 72) || 'Untitled')}</div>
        <div class="library-item-tags">${(entry.tags || []).map(currentTag => `<span class="signal-chip">${escHtml(currentTag)}</span>`).join('')}</div>
      </div>
    `;
    item.addEventListener('click', () => restoreHistory(entry));
    el.libraryList.appendChild(item);
  });
}

async function saveToLibrary() {
  if (!State.output) return;
  const newItem = {
    id: Date.now().toString(36),
    timestamp: Date.now(),
    title: State.transcript?.slice(0, 72) || 'Saved output',
    transcript: State.transcript,
    output: State.output,
    intent: State.intent?.primary_intent || 'custom',
    templateId: State.settings.activeTemplate,
    context: State.context,
    tags: [State.settings.activeTemplate, State.intent?.primary_intent || 'custom'],
    starred: true
  };

  State.library = [newItem, ...State.library];
  await chrome.storage.local.set({ library: State.library });
  renderLibraryList();
  el.btnStar.classList.add('starred');
  showToast('Saved to library', 'success');
}

async function copyOutput() {
  if (!State.output) return;
  try {
    await navigator.clipboard.writeText(State.output);
    showToast('Copied to clipboard', 'success');
  } catch {
    showToast('Copy failed', 'error');
  }
}

function exportAs(format) {
  if (!State.output) return;

  let content = State.output;
  let mimeType = 'text/plain';
  let ext = 'txt';

  if (format === 'md') {
    mimeType = 'text/markdown';
    ext = 'md';
  } else if (format === 'json') {
    mimeType = 'application/json';
    ext = 'json';
    content = JSON.stringify({
      transcript: State.transcript,
      output: State.output,
      intent: State.intent,
      templateId: State.settings.activeTemplate,
      context: State.context,
      timestamp: Date.now()
    }, null, 2);
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `briefly-output.${ext}`;
  anchor.click();
  URL.revokeObjectURL(url);
  closeModal('modal-export');
  showToast(`Exported .${ext}`, 'success');
}

function toggleRefine() {
  el.refineSection.style.display = el.refineSection.style.display === 'none' ? '' : 'none';
  if (el.refineSection.style.display !== 'none') el.refineInput.focus();
}

function submitRefine() {
  const refinement = el.refineInput.value.trim();
  if (!refinement && !State.transcript) return;
  el.refineInput.value = '';
  el.refineSection.style.display = 'none';
  prepareFreshGeneration();
  setMode('generating');
  chrome.runtime.sendMessage({ type: 'REFINE_OUTPUT', refinement, tabId: State.tabId });
}

function handleError(errorType, message) {
  setMode('error');
  State.lastErrorType = errorType;
  const normalized = typeof message === 'object' ? (message.message || JSON.stringify(message)) : message;

  const config = {
    mic_denied: {
      icon: 'Mic',
      title: 'Microphone access denied',
      message: 'Briefly needs microphone access before it can record.'
    },
    empty_transcript: {
      icon: 'Silence',
      title: 'No transcript captured',
      message: 'Try speaking longer or type the request directly.'
    },
    api_error: {
      icon: 'API',
      title: 'Generation failed',
      message: normalized || 'The model request failed.'
    },
    integration_error: {
      icon: 'Send',
      title: 'Integration failed',
      message: normalized || 'The destination rejected the payload.'
    }
  }[errorType] || {
    icon: 'Error',
    title: 'Something went wrong',
    message: normalized || 'Unexpected failure.'
  };

  el.errorIcon.textContent = config.icon;
  el.errorTitle.textContent = config.title;
  el.errorMessage.textContent = config.message;
  $('btn-error-primary').textContent = errorType === 'mic_denied' ? 'Open settings' : 'Retry';
  el.errorOverlay.style.display = 'flex';
}

async function updateRuntimeSetting(key, value, refreshContext) {
  State.settings = normalizeSettings({ ...State.settings, [key]: value });
  await chrome.storage.local.set({ settings: State.settings });
  syncPreferenceControls();
  if (refreshContext) await refreshContextSnapshot();
}

async function setActiveTemplate(templateId, options = {}) {
  if (!templateId || !findTemplate(templateId)) return;
  const { manual = true } = options;
  State.settings.activeTemplate = templateId;
  State.manualTemplateOverride = manual;
  if (!manual) {
    State.lastAutoTemplateId = templateId;
  }
  await chrome.storage.local.set({ settings: State.settings });
  renderRecipeToolbar();
  syncPreferenceControls();
}

async function maybeAutoSelectTemplate(context) {
  const recommendation = getTemplateRecommendation(context);
  if (!recommendation) return;

  const pageKey = `${context.pageType || 'general'}|${context.domain || ''}|${context.url || ''}`;
  const pageChanged = State.autoTemplateKey !== pageKey;
  const shouldApply =
    pageChanged ||
    !State.manualTemplateOverride ||
    State.settings.activeTemplate === State.lastAutoTemplateId ||
    State.settings.activeTemplate === DEFAULT_SETTINGS.activeTemplate;

  State.autoTemplateKey = pageKey;
  if (!shouldApply || State.settings.activeTemplate === recommendation.templateId) {
    State.lastAutoTemplateId = recommendation.templateId;
    return;
  }

  await setActiveTemplate(recommendation.templateId, { manual: false });
}

function getTemplateRecommendation(context) {
  if (!context) return null;

  const customMatch = State.customRecipes.find(template =>
    Array.isArray(template.autoPageTypes) &&
    template.autoPageTypes.includes(context.pageType)
  );
  if (customMatch) {
    return { templateId: customMatch.id, reason: 'Custom recipe matched this page type' };
  }

  if (PAGE_TYPE_TEMPLATE_RULES[context.pageType]) {
    return PAGE_TYPE_TEMPLATE_RULES[context.pageType];
  }

  if (context.codeBlocks?.length) {
    return { templateId: 'pr_review', reason: 'Code detected on page' };
  }

  if (context.formFields?.length >= 4) {
    return { templateId: 'customer_reply', reason: 'Form-heavy page' };
  }

  return null;
}

function formatPageTypeLabel(pageType) {
  const label = pageType || 'general';
  return label
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function navigateTo(view) {
  const views = {
    main: 'view-main',
    history: 'view-history',
    library: 'view-library',
    settings: 'view-settings'
  };

  Object.entries(views).forEach(([name, id]) => {
    const node = $(id);
    if (!node) return;
    if (name === view) {
      node.classList.remove('slide-out-left');
      node.classList.add('active');
    } else {
      node.classList.remove('active');
      if (name === 'main') node.classList.add('slide-out-left');
    }
  });

  State.currentView = view;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  el.btnTheme.querySelector('.icon-moon').style.display = theme === 'light' ? 'none' : '';
  el.btnTheme.querySelector('.icon-sun').style.display = theme === 'light' ? '' : 'none';
}

async function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  State.settings.theme = next;
  applyTheme(next);
  await chrome.storage.local.set({ settings: State.settings });
}

async function saveSettings() {
  const settings = {
    ...State.settings,
    sttProvider: $('stt-provider').value,
    language: $('stt-language').value,
    tone: $('output-tone').value,
    outputFormat: $('output-format').value,
    qualityMode: $('quality-mode').value,
    activeTemplate: $('default-template').value,
    usePageContext: $('pref-use-page-context').checked,
    selectionOnly: $('pref-selection-only').checked,
    useVisionContext: $('pref-use-vision-context').checked,
    threadMemory: $('pref-thread-memory').checked,
    redactSensitive: $('pref-redact-sensitive').checked,
    reviewBeforeSend: $('settings-review-before-send').checked,
    webhookUrl: '',
    customRecipes: State.customRecipes,
    contextSignalPrefs: {
      ...DEFAULT_CONTEXT_SIGNAL_PREFS,
      ...(State.settings.contextSignalPrefs || {})
    }
  };

  const integrations = {
    notion: { defaultPageId: $('notion-page-id').value.trim() },
    github: { defaultRepo: $('github-default-repo').value.trim() },
    jira: {
      jiraDomain: $('jira-domain').value.trim(),
      jiraEmail: $('jira-email').value.trim(),
      jiraProject: $('jira-project').value.trim()
    },
    linear: { teamId: $('linear-team-id').value.trim() },
    confluence: {
      confluenceDomain: $('confluence-domain').value.trim(),
      confluenceEmail: $('confluence-email').value.trim(),
      confluencePageId: $('confluence-page-id').value.trim()
    }
  };

  const keyFields = {
    openai: $('key-openai').value.trim(),
    googleStt: $('key-google-stt').value.trim(),
    elevenStt: $('key-eleven-stt').value.trim(),
    notion: $('key-notion').value.trim(),
    github: $('key-github').value.trim(),
    jira: $('key-jira').value.trim(),
    linear: $('key-linear').value.trim(),
    slack: $('key-slack').value.trim(),
    confluence: $('key-confluence').value.trim(),
    webhook: $('webhook-url').value.trim()
  };

  const nonEmptyKeys = Object.fromEntries(Object.entries(keyFields).filter(([, value]) => value));

  await chrome.storage.local.set({ settings, integrations });
  if (Object.keys(nonEmptyKeys).length) {
    await chrome.runtime.sendMessage({ type: 'STORE_KEYS', keys: nonEmptyKeys });
  }

  State.settings = normalizeSettings(settings);
  State.customRecipes = normalizeCustomRecipes(settings.customRecipes || []);
  State.settings.customRecipes = State.customRecipes;
  State.integrations = normalizeIntegrations(integrations);
  State.encryptedKeys = { ...State.encryptedKeys, ...Object.fromEntries(Object.keys(nonEmptyKeys).map(key => [key, true])) };

  populateTemplateSelect();
  populateSettingsFields();
  syncPreferenceControls();
  renderRecipeToolbar();
  renderIntegrationStatuses();
  updateSttBadge(State.settings.sttProvider);
  showToast('Settings saved', 'success');
  navigateTo('main');
  await refreshContextSnapshot();
}

function renderIntegrationStatuses() {
  setStatus('notion', hasKey('notion') && !!State.integrations.notion.defaultPageId);
  setStatus('github', hasKey('github') && !!State.integrations.github.defaultRepo);
  setStatus('jira', hasKey('jira') && !!(State.integrations.jira.jiraDomain && State.integrations.jira.jiraEmail && State.integrations.jira.jiraProject));
  setStatus('linear', hasKey('linear') && !!State.integrations.linear.teamId);
  setStatus('confluence', (hasKey('confluence') || hasKey('jira')) && !!(State.integrations.confluence.confluenceDomain && State.integrations.confluence.confluenceEmail && State.integrations.confluence.confluencePageId));
  setStatus('webhook', hasKey('webhook') || !!State.settings.webhookUrl);
}

function setStatus(name, connected) {
  const node = $(`status-${name}`);
  if (!node) return;
  node.textContent = connected ? 'Ready' : 'Needs setup';
  node.classList.toggle('connected', connected);
}

function hasKey(name) {
  return Boolean(State.encryptedKeys[name]);
}

async function openIntegrationReview() {
  if (!State.output) {
    showToast('Generate an output before routing it.', 'error');
    return;
  }

  if (
    State.settings.reviewBeforeSend === false &&
    State.pendingRouteTarget &&
    isIntegrationReady(State.pendingRouteTarget)
  ) {
    confirmRouteOutput();
    return;
  }

  await loadPageActions();
  renderIntegrationTargetList();

  openModal('modal-integrate');
  selectIntegrationTarget(State.pendingRouteTarget || INTEGRATION_DEFS[0].id);
}

async function selectIntegrationTarget(target) {
  State.pendingRouteTarget = target;

  if (target === 'page') {
    await loadPageActions();
  }

  renderIntegrationTargetList();
  renderIntegrationOptions(target);

  const ready = isIntegrationReady(target);
  el.integrationPreviewTitle.textContent = `${integrationLabel(target)} payload`;
  el.integrationPreviewMeta.textContent = `${ready ? 'Configured' : 'Needs setup'} / ${State.output.length} characters / ${State.settings.reviewBeforeSend ? 'review mode on' : 'quick send mode'}`;
  el.integrationPreviewBody.textContent = buildPayloadPreview(target);
  el.btnConfirmIntegrate.disabled = !State.output;
  el.btnConfirmIntegrate.textContent = ready ? actionLabelForTarget(target) : 'Open settings';
}

function buildPayloadPreview(target) {
  const title = State.context?.pageTitle || State.transcript.slice(0, 80) || 'Briefly Output';
  const excerpt = State.output.slice(0, 700);
  const githubThread = detectGitHubThreadTarget();
  const jiraIssueKey = State.context?.pageType === 'jira-ticket' ? State.context?.domainArtifacts?.issueKey : '';
  const githubMode = State.deliveryOptions.github.mode;
  const jiraMode = State.deliveryOptions.jira.mode;

  const headerByTarget = {
    page: State.pageActions.length
      ? `Insert into page field: ${State.pageActions[0].label}`
      : 'Insert into page field: [no editable target detected]',
    notion: `Append blocks to page: ${State.integrations.notion.defaultPageId || '[not configured]'}`,
    github: githubMode === 'create'
      ? `Create issue in repo: ${State.integrations.github.defaultRepo || '[not configured]'}`
      : githubThread
        ? `Add comment to current GitHub ${githubThread.kind} #${githubThread.number}`
        : 'Add comment to current GitHub issue or pull request: [not available on this page]',
    jira: jiraMode === 'create'
      ? `Create Jira task in project: ${State.integrations.jira.jiraProject || '[not configured]'}`
      : jiraIssueKey
        ? `Add comment to current Jira issue: ${jiraIssueKey}`
        : 'Add comment to current Jira issue: [not available on this page]',
    linear: `Create Linear issue for team: ${State.integrations.linear.teamId || '[not configured]'}`,
    slack: 'Post message to configured Slack webhook',
    confluence: `Append content to page: ${State.integrations.confluence.confluencePageId || '[not configured]'}`,
    webhook: hasKey('webhook') || State.settings.webhookUrl
      ? 'POST to a configured webhook endpoint'
      : 'POST to webhook: [not configured]'
  };

  return [
    headerByTarget[target] || 'Unknown target',
    target === 'page' && State.pageActions.length
      ? `Detected editable fields: ${State.pageActions.map(action => action.label).join(' | ')}`
      : '',
    target === 'page' && selectedPageAction()
      ? `Selected target: ${selectedPageAction().label} / mode: ${State.deliveryOptions.page.mode}${selectedSubmitActionLabel() ? ` / submit: ${selectedSubmitActionLabel()}` : ''}`
      : '',
    target === 'github' ? `Route mode: ${State.deliveryOptions.github.mode}` : '',
    target === 'jira' ? `Route mode: ${State.deliveryOptions.jira.mode}` : '',
    '',
    `Title: ${title}`,
    `Source URL: ${State.context?.url || 'Unavailable'}`,
    '',
    excerpt,
    State.output.length > excerpt.length ? '\n...' : ''
  ].join('\n');
}

function isIntegrationReady(target) {
  const githubThread = detectGitHubThreadTarget();
  const jiraIssueKey = State.context?.pageType === 'jira-ticket' ? State.context?.domainArtifacts?.issueKey : '';

  switch (target) {
    case 'page':
      return Boolean(selectedPageAction());
    case 'notion':
      return hasKey('notion') && !!State.integrations.notion.defaultPageId;
    case 'github':
      if (!hasKey('github')) return false;
      if (State.deliveryOptions.github.mode === 'comment') return Boolean(githubThread);
      if (State.deliveryOptions.github.mode === 'create') return Boolean(State.integrations.github.defaultRepo);
      return !!State.integrations.github.defaultRepo || !!githubThread;
    case 'jira':
      if (!hasKey('jira')) return false;
      if (!(State.integrations.jira.jiraDomain && State.integrations.jira.jiraEmail)) return false;
      if (State.deliveryOptions.jira.mode === 'comment') return Boolean(jiraIssueKey);
      if (State.deliveryOptions.jira.mode === 'create') return Boolean(State.integrations.jira.jiraProject);
      return Boolean(jiraIssueKey || State.integrations.jira.jiraProject);
    case 'linear':
      return hasKey('linear') && !!State.integrations.linear.teamId;
    case 'slack':
      return hasKey('slack');
    case 'confluence':
      return (hasKey('confluence') || hasKey('jira')) && !!(State.integrations.confluence.confluenceDomain && State.integrations.confluence.confluenceEmail && State.integrations.confluence.confluencePageId);
    case 'webhook':
      return hasKey('webhook') || !!State.settings.webhookUrl;
    default:
      return false;
  }
}

async function confirmRouteOutput() {
  if (!State.pendingRouteTarget) return;
  await initTabId();
  if (!isIntegrationReady(State.pendingRouteTarget)) {
    closeModal('modal-integrate');
    navigateTo('settings');
    showToast('Complete the integration setup first.', 'error');
    return;
  }

  closeModal('modal-integrate');
  showToast(`${actionLabelForTarget(State.pendingRouteTarget)}...`);
  await chrome.runtime.sendMessage({
    type: 'ROUTE_OUTPUT',
    target: State.pendingRouteTarget,
    tabId: State.tabId,
    options: buildRouteOptions(State.pendingRouteTarget)
  });
}

function integrationLabel(target) {
  return INTEGRATION_DEFS.find(item => item.id === target)?.label || target;
}

function actionLabelForTarget(target) {
  if (target === 'page') return 'Apply to page';
  return `Send to ${integrationLabel(target)}`;
}

function renderIntegrationOptions(target) {
  if (!el.integrationOptions) return;

  if (target === 'page') {
    const selectedActionId = selectedPageAction()?.actionId || '';
    const selectedSubmitActionId = State.deliveryOptions.page.submitActionId || '';
    const submitActions = selectedPageAction()?.submitActions || [];
    el.integrationOptions.innerHTML = `
      <div class="settings-grid two-col">
        <div class="settings-field">
          <label class="field-label" for="integration-page-target">Page field</label>
          <select id="integration-page-target" class="field-select">
            ${State.pageActions.map(action => `<option value="${escHtml(action.actionId)}" ${action.actionId === selectedActionId ? 'selected' : ''}>${escHtml(action.label)}</option>`).join('')}
          </select>
        </div>
        <div class="settings-field">
          <label class="field-label" for="integration-page-mode">Insert mode</label>
          <select id="integration-page-mode" class="field-select">
            <option value="auto" ${State.deliveryOptions.page.mode === 'auto' ? 'selected' : ''}>Auto</option>
            <option value="append" ${State.deliveryOptions.page.mode === 'append' ? 'selected' : ''}>Append</option>
            <option value="replace" ${State.deliveryOptions.page.mode === 'replace' ? 'selected' : ''}>Replace</option>
          </select>
        </div>
        <div class="settings-field two-col-span">
          <label class="field-label" for="integration-page-submit">Follow-up action</label>
          <select id="integration-page-submit" class="field-select">
            <option value="">Do not click anything after insert</option>
            ${submitActions.map(action => `<option value="${escHtml(action.submitActionId)}" ${action.submitActionId === selectedSubmitActionId ? 'selected' : ''}>${escHtml(action.label)}</option>`).join('')}
          </select>
        </div>
      </div>
    `;
    return;
  }

  if (target === 'github' || target === 'jira') {
    const mode = State.deliveryOptions[target].mode;
    const commentLabel = target === 'github' ? 'Comment on current page when available' : 'Comment on current ticket when available';
    const createLabel = target === 'github' ? 'Always create a new issue' : 'Always create a new Jira issue';
    el.integrationOptions.innerHTML = `
      <div class="settings-field">
        <label class="field-label" for="integration-route-mode">Route mode</label>
        <select id="integration-route-mode" class="field-select" data-target="${target}">
          <option value="auto" ${mode === 'auto' ? 'selected' : ''}>Auto</option>
          <option value="comment" ${mode === 'comment' ? 'selected' : ''}>${escHtml(commentLabel)}</option>
          <option value="create" ${mode === 'create' ? 'selected' : ''}>${escHtml(createLabel)}</option>
        </select>
      </div>
    `;
    return;
  }

  el.integrationOptions.innerHTML = '';
}

function toggleSection(bodyId, headerId) {
  const body = $(bodyId);
  const header = $(headerId).querySelector('.collapse-btn');
  const isHidden = body.style.display === 'none';
  body.style.display = isHidden ? '' : 'none';
  header.classList.toggle('collapsed', !isHidden);
}

async function clearHistory() {
  if (!confirm('Clear all history?')) return;
  State.history = [];
  await chrome.storage.local.set({ history: [] });
  renderHistoryList();
  showToast('History cleared', 'success');
}

async function clearAllData() {
  if (!confirm('Clear all Briefly data? This cannot be undone.')) return;
  await chrome.storage.local.clear();
  State.history = [];
  State.library = [];
  State.encryptedKeys = {};
  State.settings = normalizeSettings();
  State.customRecipes = [];
  State.integrations = normalizeIntegrations({});
  document.querySelectorAll('#view-settings input').forEach(input => {
    input.value = '';
  });
  populateSettingsFields();
  syncPreferenceControls();
  renderHistoryList();
  renderLibraryList();
  renderIntegrationStatuses();
  renderRecipeToolbar();
  renderCustomRecipeList();
  resetCustomRecipeForm();
  applyTheme(State.settings.theme);
  await refreshContextSnapshot();
  showToast('Local data cleared', 'success');
}

function toggleTranscriptEdit() {
  const button = $('btn-edit-transcript');
  const editing = el.transcriptText.isContentEditable;
  if (!editing) {
    el.transcriptText.contentEditable = 'true';
    el.transcriptText.focus();
    button.textContent = 'Save';
    return;
  }

  State.transcript = el.transcriptText.textContent.trim();
  el.transcriptText.contentEditable = 'false';
  button.textContent = 'Edit';
}

async function retryLast() {
  if (!State.transcript) return;
  await initTabId();
  prepareFreshGeneration();
  setMode('generating');
  await chrome.runtime.sendMessage({ type: 'PROCESS_TEXT', text: State.transcript, tabId: State.tabId });
}

function updateSttBadge(provider) {
  const labels = {
    whisper: 'OpenAI Whisper',
    google: 'Google STT',
    elevenlabs: 'ElevenLabs STT'
  };
  el.sttLabel.textContent = labels[provider] || 'Whisper';
}

function syncSessionToBackground() {
  chrome.runtime.sendMessage({
    type: 'SYNC_SESSION',
    tabId: State.tabId,
    transcript: State.transcript,
    output: State.output,
    context: State.context
  }).catch(() => {});
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  el.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, 2200);
}

async function loadPageActions() {
  await initTabId();
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_PAGE_ACTIONS', tabId: State.tabId });
    State.pageActions = response?.actions || [];
    const currentTarget = selectedPageAction();
    if (!currentTarget && State.pageActions[0]) {
      State.deliveryOptions.page.actionTargetId = State.pageActions[0].actionId;
      State.deliveryOptions.page.submitActionId = '';
    }
  } catch {
    State.pageActions = [];
  }
}

function renderIntegrationTargetList() {
  el.integrationTargetList.innerHTML = INTEGRATION_DEFS.map(item => `
    <button class="integration-target-btn ${State.pendingRouteTarget === item.id ? 'active' : ''}" data-target="${item.id}">
      <span>${item.label}</span>
      <span>${isIntegrationReady(item.id) ? 'Ready' : 'Setup'}</span>
    </button>
  `).join('');
}

function buildRouteOptions(target) {
  if (target === 'page') {
    return {
      actionTargetId: selectedPageAction()?.actionId || '',
      mode: State.deliveryOptions.page.mode === 'auto'
        ? (selectedPageAction()?.hasValue ? 'append' : 'replace')
        : State.deliveryOptions.page.mode,
      submitActionId: State.deliveryOptions.page.submitActionId || ''
    };
  }
  if (target === 'github' || target === 'jira') {
    return { ...State.deliveryOptions[target] };
  }
  return {};
}

function detectGitHubThreadTarget() {
  const url = State.context?.url || '';
  const match = url.match(/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/(\d+)/);
  if (!match) return null;
  return {
    kind: match[1] === 'pull' ? 'pull request' : 'issue',
    number: match[2]
  };
}

function handleIntegrationOptionChange(event) {
  const target = State.pendingRouteTarget;
  if (!target) return;

  if (target === 'page') {
    if (event.target.id === 'integration-page-target') {
      State.deliveryOptions.page.actionTargetId = event.target.value;
      State.deliveryOptions.page.submitActionId = '';
      renderIntegrationOptions(target);
    } else if (event.target.id === 'integration-page-mode') {
      State.deliveryOptions.page.mode = event.target.value;
    } else if (event.target.id === 'integration-page-submit') {
      State.deliveryOptions.page.submitActionId = event.target.value;
    }
  }

  if ((target === 'github' || target === 'jira') && event.target.id === 'integration-route-mode') {
    State.deliveryOptions[target].mode = event.target.value;
  }

  renderIntegrationOptions(target);
  const ready = isIntegrationReady(target);
  el.integrationPreviewMeta.textContent = `${ready ? 'Configured' : 'Needs setup'} / ${State.output.length} characters / ${State.settings.reviewBeforeSend ? 'review mode on' : 'quick send mode'}`;
  el.integrationPreviewBody.textContent = buildPayloadPreview(target);
  el.btnConfirmIntegrate.textContent = ready ? actionLabelForTarget(target) : 'Open settings';
}

function selectedPageAction() {
  return State.pageActions.find(action => action.actionId === State.deliveryOptions.page.actionTargetId) || State.pageActions[0] || null;
}

function selectedSubmitActionLabel() {
  const submitActionId = State.deliveryOptions.page.submitActionId;
  if (!submitActionId) return '';
  return selectedPageAction()?.submitActions?.find(action => action.submitActionId === submitActionId)?.label || '';
}

function openModal(id) {
  $(id).style.display = 'flex';
}

function closeModal(id) {
  $(id).style.display = 'none';
}

function escHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeSettings(settings = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    contextSignalPrefs: {
      ...DEFAULT_CONTEXT_SIGNAL_PREFS,
      ...(settings.contextSignalPrefs || {})
    }
  };
}

function getAllTemplates() {
  return [...TEMPLATE_DEFS, ...State.customRecipes];
}

function findTemplate(templateId) {
  return getAllTemplates().find(template => template.id === templateId) || null;
}

function normalizeCustomRecipes(recipes = []) {
  return recipes
    .map((recipe, index) => normalizeCustomRecipe(recipe, index))
    .filter(Boolean);
}

function normalizeCustomRecipe(recipe, index = 0) {
  const label = String(recipe?.label || '').trim();
  const defaultRequest = String(recipe?.defaultRequest || '').trim();
  const instruction = String(recipe?.instruction || '').trim();
  if (!label || !defaultRequest || !instruction) return null;

  const summary = String(recipe?.summary || '').trim() || 'Custom Briefly recipe';
  const rawId = String(recipe?.id || '').trim() || `custom_${slugify(label) || index + 1}`;
  const id = rawId.startsWith('custom_') ? rawId : `custom_${slugify(rawId) || index + 1}`;

  return {
    id,
    label,
    summary,
    defaultRequest,
    instruction,
    autoPageTypes: normalizePageTypeList(recipe?.autoPageTypes)
  };
}

function normalizePageTypeList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return items
    .map(item => String(item || '').trim().toLowerCase())
    .filter(Boolean);
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function renderCustomRecipeList() {
  if (!el.customRecipeList) return;

  if (!State.customRecipes.length) {
    el.customRecipeList.innerHTML = '<p class="field-hint">No custom recipes yet.</p>';
    return;
  }

  el.customRecipeList.innerHTML = State.customRecipes.map(recipe => `
    <article class="custom-recipe-item" data-recipe-id="${recipe.id}">
      <div class="custom-recipe-meta">
        <div>
          <div class="library-item-title">${escHtml(recipe.label)}</div>
          <div class="history-item-meta">
            <span>${escHtml(recipe.summary)}</span>
            ${recipe.autoPageTypes.length ? `<span>${escHtml(recipe.autoPageTypes.join(', '))}</span>` : '<span>Manual only</span>'}
          </div>
        </div>
        <button class="custom-recipe-delete" data-action="delete" data-recipe-id="${recipe.id}" aria-label="Delete custom recipe">Delete</button>
      </div>
      <p class="field-hint">${escHtml(recipe.defaultRequest)}</p>
    </article>
  `).join('');
}

function openContextReview() {
  renderContextReview();
  openModal('modal-context-review');
}

function renderContextReview() {
  if (!el.contextReviewList) return;

  const items = buildContextReviewItems();
  el.contextReviewList.innerHTML = items.map(item => `
    <article class="context-review-item">
      <div class="context-review-item-head">
        <label class="context-review-toggle">
          <input type="checkbox" data-context-signal="${item.key}" ${item.enabled ? 'checked' : ''} />
          <span>${escHtml(item.label)}</span>
        </label>
        <span class="signal-chip">${escHtml(item.meta)}</span>
      </div>
      <pre class="context-review-preview">${escHtml(item.preview)}</pre>
    </article>
  `).join('');
}

function buildContextReviewItems() {
  const context = State.context || {};
  const prefs = State.settings.contextSignalPrefs || DEFAULT_CONTEXT_SIGNAL_PREFS;
  return [
    {
      key: 'selectedText',
      label: 'Selected text',
      enabled: prefs.selectedText !== false,
      meta: context.selectedText ? `${context.selectedText.length} chars` : 'none',
      preview: context.selectedText || 'No selected text on this page.'
    },
    {
      key: 'visibleText',
      label: 'Visible snapshot',
      enabled: prefs.visibleText !== false,
      meta: context.visibleText ? `${context.visibleText.length} chars` : 'none',
      preview: context.visibleText || 'No visible text snapshot captured.'
    },
    {
      key: 'codeBlocks',
      label: 'Code blocks',
      enabled: prefs.codeBlocks !== false,
      meta: `${context.codeBlocks?.length || 0} blocks`,
      preview: (context.codeBlocks || [])
        .slice(0, 2)
        .map((block, index) => `Snippet ${index + 1} [${block.lang || 'unknown'}]\n${block.code}`)
        .join('\n\n') || 'No code blocks captured.'
    },
    {
      key: 'headings',
      label: 'Headings',
      enabled: prefs.headings !== false,
      meta: `${context.headings?.length || 0} headings`,
      preview: (context.headings || []).map(item => `H${item.level}: ${item.text}`).join('\n') || 'No headings captured.'
    },
    {
      key: 'formFields',
      label: 'Form fields',
      enabled: prefs.formFields !== false,
      meta: `${context.formFields?.length || 0} fields`,
      preview: (context.formFields || []).map(item => `${item.label || item.type}: ${item.value}`).join('\n') || 'No form fields captured.'
    },
    {
      key: 'structuredData',
      label: 'Structured data',
      enabled: prefs.structuredData !== false,
      meta: context.structuredData ? 'available' : 'none',
      preview: context.structuredData ? JSON.stringify(context.structuredData, null, 2).slice(0, 1200) : 'No structured data captured.'
    },
    {
      key: 'domainArtifacts',
      label: 'Domain-specific artifacts',
      enabled: prefs.domainArtifacts !== false,
      meta: context.domainArtifacts && Object.keys(context.domainArtifacts).length ? 'available' : 'none',
      preview: context.domainArtifacts ? JSON.stringify(context.domainArtifacts, null, 2).slice(0, 1200) : 'No domain-specific artifacts captured.'
    },
    {
      key: 'screenshot',
      label: 'Screenshot attachment',
      enabled: prefs.screenshot !== false,
      meta: State.settings.useVisionContext ? 'enabled in settings' : 'disabled in settings',
      preview: State.settings.useVisionContext
        ? 'A fresh screenshot of the visible page will be attached at send time when this signal is enabled.'
        : 'Screenshot capture is currently turned off in settings.'
    }
  ];
}

async function saveContextReviewPreferences() {
  const nextPrefs = { ...DEFAULT_CONTEXT_SIGNAL_PREFS };
  el.contextReviewList.querySelectorAll('[data-context-signal]').forEach(input => {
    nextPrefs[input.dataset.contextSignal] = input.checked;
  });
  State.settings = normalizeSettings({
    ...State.settings,
    contextSignalPrefs: nextPrefs
  });
  await chrome.storage.local.set({ settings: State.settings });
  renderContextSnapshot();
  closeModal('modal-context-review');
  showToast('Context filters updated', 'success');
}

async function resetContextReviewPreferences() {
  State.settings = normalizeSettings({
    ...State.settings,
    contextSignalPrefs: { ...DEFAULT_CONTEXT_SIGNAL_PREFS }
  });
  await chrome.storage.local.set({ settings: State.settings });
  renderContextReview();
  renderContextSnapshot();
}

function hasFilteredContextSignals() {
  const prefs = State.settings.contextSignalPrefs || DEFAULT_CONTEXT_SIGNAL_PREFS;
  return Object.values(prefs).some(value => value === false);
}

async function addCustomRecipeFromForm() {
  const recipe = normalizeCustomRecipe({
    label: $('custom-recipe-label').value,
    summary: $('custom-recipe-summary').value,
    defaultRequest: $('custom-recipe-request').value,
    instruction: $('custom-recipe-instruction').value,
    autoPageTypes: $('custom-recipe-page-types').value
  }, State.customRecipes.length);

  if (!recipe) {
    showToast('Recipe label, default request, and instruction are required.', 'error');
    return;
  }

  if (findTemplate(recipe.id)) {
    showToast('A recipe with that label already exists.', 'error');
    return;
  }

  State.customRecipes = [...State.customRecipes, recipe];
  State.settings = { ...State.settings, customRecipes: State.customRecipes };
  await chrome.storage.local.set({ settings: State.settings });
  populateTemplateSelect();
  renderRecipeToolbar();
  renderCustomRecipeList();
  syncPreferenceControls();
  resetCustomRecipeForm();
  showToast('Custom recipe added', 'success');
}

function resetCustomRecipeForm() {
  $('custom-recipe-label').value = '';
  $('custom-recipe-summary').value = '';
  $('custom-recipe-request').value = '';
  $('custom-recipe-instruction').value = '';
  $('custom-recipe-page-types').value = '';
}

async function handleCustomRecipeListClick(event) {
  const deleteButton = event.target.closest('[data-action="delete"]');
  if (!deleteButton) return;

  const recipeId = deleteButton.dataset.recipeId;
  State.customRecipes = State.customRecipes.filter(recipe => recipe.id !== recipeId);
  State.settings = { ...State.settings, customRecipes: State.customRecipes };

  if (!findTemplate(State.settings.activeTemplate)) {
    State.settings.activeTemplate = DEFAULT_SETTINGS.activeTemplate;
    State.manualTemplateOverride = false;
  }

  await chrome.storage.local.set({ settings: State.settings });
  populateTemplateSelect();
  renderRecipeToolbar();
  renderCustomRecipeList();
  syncPreferenceControls();
  showToast('Custom recipe deleted', 'success');
}

document.addEventListener('DOMContentLoaded', init);
