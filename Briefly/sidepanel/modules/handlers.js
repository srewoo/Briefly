// ─────────────────────────────────────────────────────────────────
// handlers.js — All event handlers, Chrome API calls, business logic
// ─────────────────────────────────────────────────────────────────

import {
  $, el, State,
  DEFAULT_CONTEXT_SIGNAL_PREFS, DEFAULT_SETTINGS,
  AUTOREFRESH_DEBOUNCE_MS, INTEGRATION_DEFS,
  normalizeSettings, normalizeIntegrations,
  normalizeCustomRecipes, normalizeCustomRecipe,
  findTemplate, getAllTemplates, getTemplateRecommendation,
  escHtml, hasKey, integrationLabel, actionLabelForTarget,
  buildPayloadPreview, buildRouteOptions, detectGitHubThreadTarget,
  selectedPageAction, defaultRequestForTemplate
} from './state.js';

import {
  setMode, showToast, openModal, closeModal, navigateTo,
  showTranscript, showLatestFollowUp, showOutputSection, showIntentBadge,
  renderRecipeToolbar, renderHistoryList, renderLibraryList,
  renderCustomRecipeList, renderContextSnapshot, renderContextReview,
  renderIntegrationStatuses, renderIntegrationTargetList, renderIntegrationOptions,
  renderUsageDashboard,
  populateTemplateSelect, populateSettingsFields, populateNewSettingsFields,
  syncPreferenceControls,
  updateSttBadge, updateOAuthStatus,
  applyTheme,
  resetStreamBuffer
} from './views.js';

let autorefreshContextTimer = null;
let _deviceFlowTimer = null;

export async function initTabId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    State.tabId = tab?.id || null;
  } catch {
    State.tabId = null;
  }
}

export async function startRecording(mode = 'default') {
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

export async function stopRecording() {
  if (State.mode !== 'recording') return;
  await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
}

export async function toggleRecording() {
  if (['idle', 'done', 'error'].includes(State.mode)) {
    await startRecording();
  } else if (State.mode === 'recording') {
    await stopRecording();
  }
}

export async function runCommand() {
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

export function prepareFreshGeneration() {
  State.output = '';
  State.isStreaming = false;
  State.intent = null;
  resetStreamBuffer();
  el.markdownOutput.innerHTML = '';
  if (el.outputPlaceholder) el.outputPlaceholder.style.display = 'flex';
  if (el.outputPlaceholderText) el.outputPlaceholderText.textContent = 'Generating output...';
  el.btnStar.classList.remove('starred');
  el.intentRow.style.display = 'none';
  el.intentSuggestions.style.display = 'none';
  showOutputSection(true);
}

export async function overrideIntent(intent) {
  prepareFreshGeneration();
  setMode('generating');
  await chrome.runtime.sendMessage({ type: 'PROCESS_TEXT', text: State.transcript, intent, tabId: State.tabId });
}

export async function submitRefine() {
  const refinement = el.refineInput.value.trim();
  if (!refinement && !State.transcript) return;
  el.refineInput.value = '';
  el.refineSection.style.display = 'none';
  showLatestFollowUp(refinement);
  prepareFreshGeneration();
  setMode('generating');
  chrome.runtime.sendMessage({ type: 'REFINE_OUTPUT', refinement, tabId: State.tabId });
}

export function toggleRefine() {
  el.refineSection.style.display = el.refineSection.style.display === 'none' ? '' : 'none';
  if (el.refineSection.style.display !== 'none') el.refineInput.focus();
}

export async function copyOutput() {
  if (!State.output) return;
  try {
    await navigator.clipboard.writeText(State.output);
    showToast('Copied to clipboard', 'success');
  } catch {
    showToast('Copy failed', 'error');
  }
}

export function exportAs(format) {
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

export function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function loadHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  State.history = history;
  renderHistoryList();
}

export async function deleteHistory(id) {
  State.history = State.history.filter(entry => entry.id !== id);
  await chrome.storage.local.set({ history: State.history });
  renderHistoryList(el.historySearch.value);
  showToast('Removed from history', 'success');
}

export function restoreHistory(entry) {
  State.transcript = entry.transcript || '';
  State.latestFollowUp = '';
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

export async function saveToLibrary() {
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

export async function clearHistory() {
  if (!confirm('Clear all history?')) return;
  State.history = [];
  await chrome.storage.local.set({ history: [] });
  renderHistoryList();
  showToast('History cleared', 'success');
}

export async function exportTemplates() {
  const json = JSON.stringify(State.customRecipes, null, 2);
  downloadFile(json, 'briefly-templates.json', 'application/json');
  showToast('Templates exported', 'success');
}

export async function importTemplates(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  event.target.value = '';
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (!Array.isArray(imported)) throw new Error('Invalid format');
    const existingIds = new Set(State.customRecipes.map(r => r.id));
    let added = 0;
    for (const raw of imported) {
      const recipe = normalizeCustomRecipe(raw, State.customRecipes.length + added);
      if (recipe && !existingIds.has(recipe.id)) {
        State.customRecipes.push(recipe);
        existingIds.add(recipe.id);
        added++;
      }
    }
    State.settings.customRecipes = State.customRecipes;
    await chrome.storage.local.set({ settings: State.settings });
    populateTemplateSelect();
    renderRecipeToolbar();
    renderCustomRecipeList();
    showToast(`Imported ${added} template(s)`, 'success');
  } catch (err) {
    showToast(`Import failed: ${err.message}`, 'error');
  }
}

export async function exportHistoryData() {
  const history = State.history;
  const json = JSON.stringify(history, null, 2);
  downloadFile(json, 'briefly-history.json', 'application/json');
  showToast('History exported', 'success');
}

export async function importHistoryData(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  event.target.value = '';
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (!Array.isArray(imported)) throw new Error('Invalid format');
    const existingIds = new Set(State.history.map(e => e.id));
    let added = 0;
    for (const entry of imported) {
      if (entry.id && !existingIds.has(entry.id)) {
        State.history.push(entry);
        existingIds.add(entry.id);
        added++;
      }
    }
    State.history.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const limit = State.settings.historyLimit || 500;
    State.history = State.history.slice(0, limit);
    await chrome.storage.local.set({ history: State.history });
    renderHistoryList();
    showToast(`Imported ${added} history item(s)`, 'success');
  } catch (err) {
    showToast(`Import failed: ${err.message}`, 'error');
  }
}

export async function updateRuntimeSetting(key, value, refreshContext) {
  State.settings = normalizeSettings({ ...State.settings, [key]: value });
  await chrome.storage.local.set({ settings: State.settings });
  syncPreferenceControls();
  if (refreshContext) await refreshContextSnapshot();
}

export async function saveSettings() {
  const settings = {
    ...State.settings,
    sttProvider: $('stt-provider').value,
    language: $('stt-language').value,
    tone: $('output-tone').value,
    outputFormat: $('output-format').value,
    qualityMode: $('quality-mode').value,
    activeTemplate: $('default-template').value,
    usePageContext: $('pref-use-page-context').checked,
    autorefreshContext: $('pref-autorefresh-context').checked,
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
    },
    // New fields
    llmProvider: $('llm-provider')?.value || 'openai',
    ollamaEndpoint: $('ollama-endpoint')?.value || 'http://localhost:11434',
    ollamaModel: $('ollama-model')?.value || 'llama3',
    costBudgetMonthly: parseFloat($('cost-budget')?.value) || 0,
    historyLimit: parseInt($('history-limit')?.value) || 500,
    contextExtractionTimeout: parseInt($('context-timeout')?.value) || 2000,
    skipHeavyPages: $('pref-skip-heavy-pages')?.checked !== false,
    feedbackEnabled: $('pref-feedback-enabled')?.checked !== false,
    costTrackingEnabled: $('pref-cost-tracking')?.checked !== false
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
    anthropic: $('key-anthropic')?.value?.trim() || '',
    gemini: $('key-gemini')?.value?.trim() || '',
    googleStt: $('key-google-stt').value.trim(),
    elevenStt: $('key-eleven-stt').value.trim(),
    notion: $('key-notion').value.trim(),
    github: $('key-github').value.trim(),
    jira: $('key-jira').value.trim(),
    linear: $('key-linear').value.trim(),
    slack: $('key-slack').value.trim(),
    confluence: $('key-confluence').value.trim(),
    webhook: $('webhook-url')?.value?.trim() || ''
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
  populateNewSettingsFields();
  syncPreferenceControls();
  renderRecipeToolbar();
  renderIntegrationStatuses();
  updateSttBadge(State.settings.sttProvider);
  showToast('Settings saved', 'success');
  navigateTo('main');
  await refreshContextSnapshot();
}

export async function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  State.settings.theme = next;
  applyTheme(next);
  await chrome.storage.local.set({ settings: State.settings });
}

export async function setActiveTemplate(templateId, options = {}) {
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

export async function maybeAutoSelectTemplate(context) {
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

export async function addCustomRecipeFromForm() {
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

export function resetCustomRecipeForm() {
  $('custom-recipe-label').value = '';
  $('custom-recipe-summary').value = '';
  $('custom-recipe-request').value = '';
  $('custom-recipe-instruction').value = '';
  $('custom-recipe-page-types').value = '';
}

export async function handleCustomRecipeListClick(event) {
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

export async function refreshContextSnapshot() {
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

export function scheduleAutorefreshContext() {
  if (!State.settings.autorefreshContext || !State.settings.usePageContext) return;
  if (autorefreshContextTimer) clearTimeout(autorefreshContextTimer);
  autorefreshContextTimer = setTimeout(() => {
    autorefreshContextTimer = null;
    refreshContextSnapshot();
  }, AUTOREFRESH_DEBOUNCE_MS);
}

export function openContextReview() {
  renderContextReview();
  openModal('modal-context-review');
}

export async function saveContextReviewPreferences() {
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

export async function resetContextReviewPreferences() {
  State.settings = normalizeSettings({
    ...State.settings,
    contextSignalPrefs: { ...DEFAULT_CONTEXT_SIGNAL_PREFS }
  });
  await chrome.storage.local.set({ settings: State.settings });
  renderContextReview();
  renderContextSnapshot();
}

export async function openIntegrationReview() {
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

export async function selectIntegrationTarget(target) {
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

export async function confirmRouteOutput() {
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

export function handleIntegrationOptionChange(event) {
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

export async function loadPageActions() {
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

export function isIntegrationReady(target) {
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

export async function submitFeedback(rating, note = '') {
  if (!State.output) return;
  State.lastFeedbackRating = rating;

  const feedbackEntry = {
    rating,
    note,
    transcript: State.transcript?.slice(0, 200),
    intent: State.intent?.primary_intent || 'custom',
    templateId: State.settings.activeTemplate,
    provider: State.settings.llmProvider || 'openai',
    outputLength: State.output.length,
    pageType: State.context?.pageType || 'general'
  };

  await chrome.runtime.sendMessage({ type: 'SAVE_FEEDBACK', feedback: feedbackEntry });

  // Record intent correction if user corrected the intent
  if (rating === 'negative' && State.intent?.primary_intent) {
    // The negative feedback may indicate intent misclassification
    // Store for the learning system
  }

  const feedbackBar = $('feedback-bar');
  if (feedbackBar) feedbackBar.innerHTML = `<span class="feedback-label">${rating === 'positive' ? 'Thanks for the feedback!' : 'Feedback recorded. We\'ll improve.'}</span>`;
  showToast(rating === 'positive' ? 'Thanks!' : 'Feedback noted', 'success');
}

export async function confirmRegenerate() {
  const provider = $('regen-provider')?.value || State.settings.llmProvider;
  const quality = $('regen-quality')?.value || State.settings.qualityMode;

  closeModal('modal-regenerate');
  prepareFreshGeneration();
  setMode('generating');

  await chrome.runtime.sendMessage({
    type: 'REGENERATE',
    tabId: State.tabId,
    overrides: { llmProvider: provider, qualityMode: quality }
  });
}

export async function loadUsageDashboard() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_USAGE' });
    if (response?.totals) {
      State.usageTotals = response.totals;
      renderUsageDashboard();
    }
  } catch { /* non-critical */ }
}

export async function initiateOAuth(provider) {
  // GitHub uses Device Flow (no backend required).
  // Other providers use chrome.identity.launchWebAuthFlow + backend proxy.
  if (provider === 'github') {
    await initiateGitHubDeviceFlow();
    return;
  }

  const oauthConfigs = {
    notion: {
      authUrl: 'https://api.notion.com/v1/oauth/authorize',
      scopes: '',
      hint: 'Requires a Notion integration. Create one at notion.so/my-integrations.'
    },
    slack: {
      authUrl: 'https://slack.com/oauth/v2/authorize',
      scopes: 'chat:write,channels:read',
      hint: 'Requires a Slack App. Create one at api.slack.com/apps.'
    }
  };

  const config = oauthConfigs[provider];
  if (!config) return;

  const { oauthClients = {} } = await chrome.storage.local.get('oauthClients');
  const clientId = oauthClients[provider]?.clientId;

  if (!clientId) {
    showToast(`OAuth not configured. ${config.hint} For now, use manual API tokens in the Keys section.`, 'error');
    return;
  }

  const redirectUri = chrome.identity.getRedirectURL(`oauth/${provider}`);
  const authUrl = `${config.authUrl}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(config.scopes)}&response_type=code`;

  try {
    const responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
    const url = new URL(responseUrl);
    const code = url.searchParams.get('code');
    if (!code) throw new Error('No authorization code received');

    const proxyUrl = oauthClients[provider]?.proxyUrl;
    if (!proxyUrl) {
      showToast('OAuth proxy URL not configured. Add it in advanced settings.', 'error');
      return;
    }

    const tokenRes = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, provider, redirect_uri: redirectUri })
    });

    if (!tokenRes.ok) throw new Error('Token exchange failed');
    const tokenData = await tokenRes.json();

    await chrome.runtime.sendMessage({ type: 'STORE_KEYS', keys: { [provider]: tokenData.access_token } });
    State.encryptedKeys[provider] = true;
    updateOAuthStatus(provider, true);
    renderIntegrationStatuses();
    showToast(`${provider.charAt(0).toUpperCase() + provider.slice(1)} connected via OAuth`, 'success');
  } catch (err) {
    if (err.message?.includes('canceled') || err.message?.includes('closed')) {
      showToast('OAuth flow cancelled', 'info');
    } else {
      showToast(`OAuth failed: ${err.message}`, 'error');
    }
  }
}

export async function initiateGitHubDeviceFlow() {
  const res = await chrome.runtime.sendMessage({ type: 'GITHUB_DEVICE_FLOW_START' });
  if (!res.success) {
    showToast(res.error || 'GitHub Device Flow failed.', 'error');
    return;
  }

  // Show the code in the modal
  const codeEl = $('device-flow-code');
  const statusEl = $('device-flow-status');
  if (codeEl) codeEl.textContent = res.userCode;
  if (statusEl) statusEl.textContent = 'Waiting for authorization on GitHub\u2026';
  const openBtn = $('btn-device-flow-open');
  if (openBtn) openBtn.href = res.verificationUri;
  openModal('modal-github-device-flow');

  // Poll for authorization
  const { deviceCode, interval } = res;
  const pollMs = (interval || 5) * 1000;
  let elapsed = 0;
  const maxMs = (res.expiresIn || 900) * 1000;

  _deviceFlowTimer = setInterval(async () => {
    elapsed += pollMs;
    if (elapsed >= maxMs) {
      clearInterval(_deviceFlowTimer);
      _deviceFlowTimer = null;
      if (statusEl) statusEl.textContent = 'Code expired. Please try again.';
      return;
    }

    const poll = await chrome.runtime.sendMessage({ type: 'GITHUB_DEVICE_FLOW_POLL', deviceCode });
    if (!poll.success) return;

    if (poll.status === 'authorized') {
      clearInterval(_deviceFlowTimer);
      _deviceFlowTimer = null;
      State.encryptedKeys.github = true;
      closeModal('modal-github-device-flow');
      updateOAuthStatus('github', true);
      renderIntegrationStatuses();
      showToast('GitHub connected via Device Flow', 'success');
    } else if (poll.status === 'slow_down') {
      // GitHub asked us to slow down — handled by interval
    } else if (poll.status === 'access_denied' || poll.status === 'expired_token') {
      clearInterval(_deviceFlowTimer);
      _deviceFlowTimer = null;
      closeModal('modal-github-device-flow');
      showToast('GitHub authorization denied or expired.', 'error');
    }
  }, pollMs);
}

export async function loadOAuthStatuses() {
  for (const provider of ['github', 'notion', 'slack']) {
    updateOAuthStatus(provider, hasKey(provider));
  }
}

export async function clearAllData() {
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

export function toggleTranscriptEdit() {
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

export async function retryLast() {
  if (!State.transcript) return;
  await initTabId();
  prepareFreshGeneration();
  setMode('generating');
  await chrome.runtime.sendMessage({ type: 'PROCESS_TEXT', text: State.transcript, tabId: State.tabId });
}

export function syncSessionToBackground() {
  chrome.runtime.sendMessage({
    type: 'SYNC_SESSION',
    tabId: State.tabId,
    transcript: State.transcript,
    refinement: State.latestFollowUp,
    output: State.output,
    context: State.context
  }).catch(() => {});
}

export function handleError(errorType, message) {
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

export async function handleTabChangeForAutorefresh(msg) {
  await initTabId();
  if (State.tabId === msg.tabId && State.settings.usePageContext && State.settings.autorefreshContext) {
    scheduleAutorefreshContext();
  }
}

// Expose _deviceFlowTimer for bindEvents close button
export function getDeviceFlowTimer() {
  return _deviceFlowTimer;
}

export function clearDeviceFlowTimer() {
  if (_deviceFlowTimer) {
    clearInterval(_deviceFlowTimer);
    _deviceFlowTimer = null;
  }
}
