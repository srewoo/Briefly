// ─────────────────────────────────────────────────────────────────
// views.js — All DOM rendering, UI display, toasts, modals, theme, waveform
// ─────────────────────────────────────────────────────────────────

import {
  $, el, State,
  INTEGRATION_DEFS,
  escHtml, formatPageTypeLabel, formatTokenCount,
  getIntentIcon, getIntentLabel,
  getAllTemplates, findTemplate,
  hasKey, hasFilteredContextSignals,
  buildContextReviewItems,
  selectedPageAction
} from './state.js';

// Forward-reference import: these are only called at runtime (inside event listeners),
// never during module evaluation, so no circular-import issue.
import { deleteHistory, restoreHistory, overrideIntent, isIntegrationReady } from './handlers.js';

let wctx = null;
let streamCursor = null;
let streamBuffer = '';

export function initElements() {
  el.micBtn = $('mic-btn');
  el.micWrapper = $('mic-wrapper');
  el.micSpinner = $('mic-spinner');
  el.micHint = $('mic-hint');
  el.sttLabel = $('stt-label');
  el.waveformCanvas = $('waveform-canvas');
  el.recipeToolbar = $('recipe-toolbar');
  el.commandInput = $('command-input');
  el.btnRunCommand = $('btn-run-command');
  el.btnRefreshContext = $('btn-refresh-context');
  el.btnReviewContext = $('btn-review-context');
  el.togglePageContext = $('toggle-page-context');
  el.toggleSelectionOnly = $('toggle-selection-only');
  el.toggleVisionContext = $('toggle-vision-context');
  el.toggleRedactSensitive = $('toggle-redact-sensitive');
  el.contextPageTitle = $('context-page-title');
  el.contextMeta = $('context-meta');
  el.contextSelection = $('context-selection');
  el.contextSignalList = $('context-signal-list');
  el.contextLastUpdated = $('context-last-updated');
  el.intentRow = $('intent-row');
  el.intentBadge = $('intent-badge');
  el.intentIcon = $('intent-icon');
  el.intentName = $('intent-name');
  el.intentConfidence = $('intent-confidence');
  el.intentSuggestions = $('intent-suggestions');
  el.transcriptSection = $('transcript-section');
  el.transcriptBody = $('transcript-body');
  el.transcriptText = $('transcript-text');
  el.followUpBlock = $('follow-up-block');
  el.followUpText = $('follow-up-text');
  el.outputSection = $('output-section');
  el.outputPlaceholder = $('output-placeholder');
  el.outputPlaceholderText = $('output-placeholder-text');
  el.markdownOutput = $('markdown-output');
  el.streamingDots = $('streaming-dots');
  el.actionBar = $('action-bar');
  el.btnCopy = $('btn-copy');
  el.btnExport = $('btn-export');
  el.btnIntegrate = $('btn-integrate');
  el.btnRefine = $('btn-refine');
  el.refineSection = $('refine-section');
  el.refineInput = $('refine-input');
  el.btnRefineSubmit = $('btn-refine-submit');
  el.historyList = $('history-list');
  el.historyEmpty = $('history-empty');
  el.historyCount = $('history-count');
  el.historyListFull = $('history-list-full');
  el.historySearch = $('history-search');
  el.libraryList = $('library-list');
  el.libraryEmpty = $('library-empty');
  el.librarySearch = $('library-search');
  el.toastContainer = $('toast-container');
  el.errorOverlay = $('error-overlay');
  el.errorIcon = $('error-icon');
  el.errorTitle = $('error-title');
  el.errorMessage = $('error-message');
  el.btnTheme = $('btn-theme');
  el.btnSettings = $('btn-settings');
  el.btnHistory = $('btn-history');
  el.btnLibrary = $('btn-library');
  el.btnStar = $('btn-star');
  el.modalExport = $('modal-export');
  el.modalIntegrate = $('modal-integrate');
  el.integrationTargetList = $('integration-target-list');
  el.integrationPreviewTitle = $('integration-preview-title');
  el.integrationPreviewMeta = $('integration-preview-meta');
  el.integrationPreviewBody = $('integration-preview-body');
  el.integrationOptions = $('integration-options');
  el.btnConfirmIntegrate = $('btn-confirm-integrate');
  el.customRecipeList = $('custom-recipe-list');
  el.modalContextReview = $('modal-context-review');
  el.contextReviewList = $('context-review-list');

  wctx = el.waveformCanvas ? el.waveformCanvas.getContext('2d') : null;
}

export function setMode(mode) {
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

export function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  el.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, 2200);
}

export function openModal(id) {
  $(id).style.display = 'flex';
}

export function closeModal(id) {
  $(id).style.display = 'none';
}

export function navigateTo(view) {
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

export function toggleSection(bodyId, headerId) {
  const body = $(bodyId);
  const header = $(headerId).querySelector('.collapse-btn');
  const isHidden = body.style.display === 'none';
  body.style.display = isHidden ? '' : 'none';
  header.classList.toggle('collapsed', !isHidden);
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  el.btnTheme.querySelector('.icon-moon').style.display = theme === 'light' ? 'none' : '';
  el.btnTheme.querySelector('.icon-sun').style.display = theme === 'light' ? '' : 'none';
}

export function drawWaveform(dataArray) {
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

export function showTranscript(text) {
  State.transcript = text || '';
  el.transcriptSection.style.display = '';
  el.transcriptText.textContent = State.transcript;
}

export function showLatestFollowUp(text) {
  State.latestFollowUp = text || '';
  if (!el.followUpBlock || !el.followUpText) return;
  if (!State.latestFollowUp) {
    el.followUpBlock.style.display = 'none';
    el.followUpText.textContent = '';
    return;
  }
  el.followUpBlock.style.display = '';
  el.followUpText.textContent = State.latestFollowUp;
}

export function showOutputSection(loading = false) {
  el.outputSection.style.display = '';
  el.actionBar.style.display = '';
  if (loading) {
    if (el.outputPlaceholder) el.outputPlaceholder.style.display = 'flex';
    if (el.outputPlaceholderText) el.outputPlaceholderText.textContent = 'Generating output...';
    el.streamingDots.style.display = 'flex';
  }
}

export function showIntentBadge(intent) {
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

export function appendStreamChunk(text) {
  if (!State.isStreaming) {
    State.isStreaming = true;
    streamBuffer = '';
    if (el.outputPlaceholder) el.outputPlaceholder.style.display = 'none';
    el.streamingDots.style.display = 'none';
    el.markdownOutput.innerHTML = '';
  }

  streamBuffer += text;
  el.markdownOutput.innerHTML = Markdown.render(streamBuffer);
  streamCursor = document.createElement('span');
  streamCursor.className = 'stream-cursor';
  el.markdownOutput.appendChild(streamCursor);
}

export function finalizeOutput() {
  State.isStreaming = false;
  if (streamCursor) streamCursor.remove();
  if (el.outputPlaceholder) {
    el.outputPlaceholder.style.display = State.output ? 'none' : 'flex';
  }
  if (el.outputPlaceholderText && !State.output) {
    el.outputPlaceholderText.textContent = 'No output was generated.';
  }
  el.markdownOutput.innerHTML = Markdown.render(State.output);
  el.actionBar.style.display = '';
  showFeedbackBar();
}

export function showFeedbackBar() {
  if (!State.settings.feedbackEnabled) return;
  const bar = $('feedback-bar');
  if (bar) {
    bar.style.display = '';
    State.lastFeedbackRating = null;
    const note = $('feedback-note');
    const submit = $('btn-feedback-submit');
    if (note) { note.style.display = 'none'; note.value = ''; }
    if (submit) submit.style.display = 'none';
  }
}

export function renderRecipeToolbar() {
  el.recipeToolbar.innerHTML = getAllTemplates().map(template => `
    <button class="recipe-chip ${template.id === State.settings.activeTemplate ? 'active' : ''}" data-template-id="${template.id}" title="${escHtml(template.summary)}">
      <span>${escHtml(template.label)}</span>
    </button>
  `).join('');
}

export function renderHistoryList(filter = '') {
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

export function createHistoryItem(entry) {
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

export function renderLibraryList(filter = '', tag = 'all') {
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

export function renderCustomRecipeList() {
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

export function renderContextSnapshot() {
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

  if (State.context.contextSource === 'internet') {
    el.contextPageTitle.textContent = 'Internet context';
    el.contextMeta.textContent = 'Web search / Internet';
    el.contextSelection.textContent = 'Briefly will search the live web because this tab does not expose usable page content.';
    el.contextLastUpdated.textContent = State.context.extractedAt ? I18n.relativeTime(State.context.extractedAt) : 'Just now';

    const signals = [
      'Internet search',
      'No page snapshot'
    ];
    if (State.settings.threadMemory) signals.push('Recent tab memory available');
    if (State.settings.redactSensitive) signals.push('Sensitive strings redacted');

    el.contextSignalList.innerHTML = signals.map(signal => `<span class="signal-chip">${escHtml(signal)}</span>`).join('');
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

export function renderContextReview() {
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

export function renderIntegrationStatuses() {
  setStatus('notion', hasKey('notion') && !!State.integrations.notion.defaultPageId);
  setStatus('github', hasKey('github') && !!State.integrations.github.defaultRepo);
  setStatus('jira', hasKey('jira') && !!(State.integrations.jira.jiraDomain && State.integrations.jira.jiraEmail && State.integrations.jira.jiraProject));
  setStatus('linear', hasKey('linear') && !!State.integrations.linear.teamId);
  setStatus('confluence', (hasKey('confluence') || hasKey('jira')) && !!(State.integrations.confluence.confluenceDomain && State.integrations.confluence.confluenceEmail && State.integrations.confluence.confluencePageId));
  setStatus('webhook', hasKey('webhook') || !!State.settings.webhookUrl);
}

export function renderIntegrationTargetList() {
  el.integrationTargetList.innerHTML = INTEGRATION_DEFS.map(item => `
    <button class="integration-target-btn ${State.pendingRouteTarget === item.id ? 'active' : ''}" data-target="${item.id}">
      <span>${item.label}</span>
      <span>${isIntegrationReady(item.id) ? 'Ready' : 'Setup'}</span>
    </button>
  `).join('');
}

export function renderIntegrationOptions(target) {
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

export function renderUsageDashboard() {
  const costEl = $('usage-total-cost');
  const reqEl = $('usage-total-requests');
  const tokEl = $('usage-total-tokens');

  if (costEl) costEl.textContent = `$${(State.usageTotals.totalCost || 0).toFixed(4)}`;
  if (reqEl) reqEl.textContent = String(State.usageTotals.totalRequests || 0);
  if (tokEl) tokEl.textContent = formatTokenCount((State.usageTotals.totalInputTokens || 0) + (State.usageTotals.totalOutputTokens || 0));
}

export function populateTemplateSelect() {
  const select = $('default-template');
  select.innerHTML = getAllTemplates()
    .map(template => `<option value="${template.id}">${template.label}</option>`)
    .join('');
}

export function populateSettingsFields() {
  $('stt-provider').value = State.settings.sttProvider;
  $('stt-language').value = State.settings.language;
  $('output-tone').value = State.settings.tone;
  $('output-format').value = State.settings.outputFormat;
  $('quality-mode').value = State.settings.qualityMode;
  $('default-template').value = State.settings.activeTemplate;
  $('settings-review-before-send').checked = State.settings.reviewBeforeSend;
  $('pref-use-page-context').checked = State.settings.usePageContext;
  $('pref-autorefresh-context').checked = State.settings.autorefreshContext;
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

export function populateNewSettingsFields() {
  const llmProvider = $('llm-provider');
  if (llmProvider) {
    llmProvider.value = State.settings.llmProvider || 'openai';
    const isOllama = llmProvider.value === 'ollama';
    const ollamaSettings = $('ollama-settings');
    const ollamaModelField = $('ollama-model-field');
    if (ollamaSettings) ollamaSettings.style.display = isOllama ? '' : 'none';
    if (ollamaModelField) ollamaModelField.style.display = isOllama ? '' : 'none';
  }
  const ollamaEndpoint = $('ollama-endpoint');
  if (ollamaEndpoint) ollamaEndpoint.value = State.settings.ollamaEndpoint || 'http://localhost:11434';
  const ollamaModel = $('ollama-model');
  if (ollamaModel) ollamaModel.value = State.settings.ollamaModel || 'llama3';
  const costBudget = $('cost-budget');
  if (costBudget) costBudget.value = State.settings.costBudgetMonthly || '';
  const historyLimit = $('history-limit');
  if (historyLimit) historyLimit.value = State.settings.historyLimit || 500;
  const contextTimeout = $('context-timeout');
  if (contextTimeout) contextTimeout.value = State.settings.contextExtractionTimeout || 2000;
  const skipHeavy = $('pref-skip-heavy-pages');
  if (skipHeavy) skipHeavy.checked = State.settings.skipHeavyPages !== false;
  const feedbackEnabled = $('pref-feedback-enabled');
  if (feedbackEnabled) feedbackEnabled.checked = State.settings.feedbackEnabled !== false;
  const costTracking = $('pref-cost-tracking');
  if (costTracking) costTracking.checked = State.settings.costTrackingEnabled !== false;
}

export function syncPreferenceControls() {
  el.togglePageContext.checked = State.settings.usePageContext;
  el.toggleSelectionOnly.checked = State.settings.selectionOnly;
  el.toggleVisionContext.checked = State.settings.useVisionContext;
  el.toggleRedactSensitive.checked = State.settings.redactSensitive;
  $('pref-use-page-context').checked = State.settings.usePageContext;
  $('pref-autorefresh-context').checked = State.settings.autorefreshContext;
  $('pref-selection-only').checked = State.settings.selectionOnly;
  $('pref-use-vision-context').checked = State.settings.useVisionContext;
  $('pref-thread-memory').checked = State.settings.threadMemory;
  $('pref-redact-sensitive').checked = State.settings.redactSensitive;
  $('default-template').value = State.settings.activeTemplate;
  $('settings-review-before-send').checked = State.settings.reviewBeforeSend;
  updateCommandPlaceholder();
}

export function updateSttBadge(provider) {
  const labels = {
    whisper: 'OpenAI Whisper',
    google: 'Google STT',
    elevenlabs: 'ElevenLabs STT'
  };
  el.sttLabel.textContent = labels[provider] || 'Whisper';
}

export function updateCommandPlaceholder() {
  const template = findTemplate(State.settings.activeTemplate) || getAllTemplates()[0];
  el.commandInput.placeholder = `Typed command for ${template.label}, or leave empty to run: ${template.defaultRequest}`;
}

export function setStatus(name, connected) {
  const node = $(`status-${name}`);
  if (!node) return;
  node.textContent = connected ? 'Ready' : 'Needs setup';
  node.classList.toggle('connected', connected);
}

export function updateOAuthStatus(provider, connected) {
  const statusEl = $(`oauth-status-${provider}`);
  if (statusEl) {
    statusEl.textContent = connected ? 'Connected' : 'Not connected';
    statusEl.classList.toggle('connected', connected);
  }
  const btn = $(`btn-oauth-${provider}`);
  if (btn) btn.textContent = connected ? `Disconnect ${provider}` : `Connect ${provider.charAt(0).toUpperCase() + provider.slice(1)}`;
}

// Export streamBuffer reset for handlers.prepareFreshGeneration
export function resetStreamBuffer() {
  streamBuffer = '';
}
