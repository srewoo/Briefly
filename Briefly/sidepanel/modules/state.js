// ─────────────────────────────────────────────────────────────────
// state.js — State object, constants, normalizers, pure helpers
// ─────────────────────────────────────────────────────────────────

export const DEFAULT_CONTEXT_SIGNAL_PREFS = {
  selectedText: true,
  visibleText: true,
  codeBlocks: true,
  headings: true,
  formFields: true,
  structuredData: true,
  domainArtifacts: true,
  screenshot: true
};

export const DEFAULT_SETTINGS = {
  sttProvider: 'whisper',
  language: 'auto',
  tone: 'auto',
  outputFormat: 'markdown',
  qualityMode: 'balanced',
  theme: 'dark',
  activeTemplate: 'general_assistant',
  usePageContext: true,
  autorefreshContext: true,
  selectionOnly: false,
  useVisionContext: false,
  threadMemory: true,
  redactSensitive: true,
  reviewBeforeSend: true,
  webhookUrl: '',
  customRecipes: [],
  contextSignalPrefs: { ...DEFAULT_CONTEXT_SIGNAL_PREFS }
};

export const TEMPLATE_DEFS = [
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

export const PAGE_TYPE_TEMPLATE_RULES = {
  internet: { templateId: 'general_assistant', reason: 'Internet search context' },
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

export const INTEGRATION_DEFS = [
  { id: 'page', label: 'Apply to Page', key: null },
  { id: 'notion', label: 'Notion', key: 'notion' },
  { id: 'github', label: 'GitHub', key: 'github' },
  { id: 'jira', label: 'Jira', key: 'jira' },
  { id: 'linear', label: 'Linear', key: 'linear' },
  { id: 'slack', label: 'Slack', key: 'slack' },
  { id: 'confluence', label: 'Confluence', key: 'confluence' },
  { id: 'webhook', label: 'Webhook', key: null }
];

export const State = {
  mode: 'idle',
  tabId: null,
  transcript: '',
  latestFollowUp: '',
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
  lastAutoTemplateId: null,
  // Feedback
  lastFeedbackRating: null,
  // Usage
  usageTotals: { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0 },
  // OAuth
  oauthTokens: {}
};

export const AUTOREFRESH_DEBOUNCE_MS = 300;

export const $ = id => document.getElementById(id);

export const el = {};

// ── Pure functions ──

export function normalizeSettings(settings = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    contextSignalPrefs: {
      ...DEFAULT_CONTEXT_SIGNAL_PREFS,
      ...(settings.contextSignalPrefs || {})
    }
  };
}

export function normalizeIntegrations(integrations = {}) {
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

export function normalizeCustomRecipes(recipes = []) {
  return recipes
    .map((recipe, index) => normalizeCustomRecipe(recipe, index))
    .filter(Boolean);
}

export function normalizeCustomRecipe(recipe, index = 0) {
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

export function normalizePageTypeList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return items
    .map(item => String(item || '').trim().toLowerCase())
    .filter(Boolean);
}

export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function escHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatTokenCount(count) {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return String(count);
}

export function formatPageTypeLabel(pageType) {
  const label = pageType || 'general';
  return label
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function getAllTemplates() {
  return [...TEMPLATE_DEFS, ...State.customRecipes];
}

export function findTemplate(templateId) {
  return getAllTemplates().find(template => template.id === templateId) || null;
}

export function defaultRequestForTemplate(templateId) {
  return findTemplate(templateId)?.defaultRequest || '';
}

export function getIntentIcon(intent) {
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

export function getIntentLabel(intent) {
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

export function getTemplateRecommendation(context) {
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

  return { templateId: 'general_assistant', reason: 'Default for this page type' };
}

export function integrationLabel(target) {
  return INTEGRATION_DEFS.find(item => item.id === target)?.label || target;
}

export function actionLabelForTarget(target) {
  if (target === 'page') return 'Apply to page';
  return `Send to ${integrationLabel(target)}`;
}

export function hasKey(name) {
  return Boolean(State.encryptedKeys[name]);
}

export function hasFilteredContextSignals() {
  const prefs = State.settings.contextSignalPrefs || DEFAULT_CONTEXT_SIGNAL_PREFS;
  return Object.values(prefs).some(value => value === false);
}

export function detectGitHubThreadTarget() {
  const url = State.context?.url || '';
  const match = url.match(/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/(\d+)/);
  if (!match) return null;
  return {
    kind: match[1] === 'pull' ? 'pull request' : 'issue',
    number: match[2]
  };
}

export function buildPayloadPreview(target) {
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

export function buildRouteOptions(target) {
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

export function buildContextReviewItems() {
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

export function selectedPageAction() {
  return State.pageActions.find(action => action.actionId === State.deliveryOptions.page.actionTargetId) || State.pageActions[0] || null;
}

export function selectedSubmitActionLabel() {
  const submitActionId = State.deliveryOptions.page.submitActionId;
  if (!submitActionId) return '';
  return selectedPageAction()?.submitActions?.find(action => action.submitActionId === submitActionId)?.label || '';
}
