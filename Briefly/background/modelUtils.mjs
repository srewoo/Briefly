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
  selectionOnly: false,
  useVisionContext: false,
  threadMemory: true,
  redactSensitive: true,
  reviewBeforeSend: true,
  webhookUrl: '',
  customRecipes: [],
  contextSignalPrefs: { ...DEFAULT_CONTEXT_SIGNAL_PREFS }
};

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

export function summarizeRecentTurns(recentTurns = [], settings = {}) {
  if (settings.threadMemory === false || !Array.isArray(recentTurns) || !recentTurns.length) return '';

  return recentTurns
    .slice(-3)
    .map((turn, index) => [
      `Turn ${index + 1}:`,
      `Request: ${(turn.transcript || '').slice(0, 180) || 'unknown'}`,
      `Intent: ${turn.intent || 'custom'}`,
      `Template: ${turn.templateId || 'general_assistant'}`,
      `Output gist: ${(turn.output || '').slice(0, 220) || 'none'}`
    ].join('\n'))
    .join('\n\n');
}

export function appendRecentTurn(recentTurns = [], turn) {
  return [...(Array.isArray(recentTurns) ? recentTurns : []), turn].slice(-4);
}

export function resolveModelPlan({ settings = {}, templateId, intent, hasScreenshot }) {
  const qualityMode = settings.qualityMode || 'balanced';
  const highDetailTemplate = ['pr_review', 'test_plan', 'product_spec', 'bug_report'].includes(templateId);

  if (qualityMode === 'fast') {
    return { primaryModel: 'gpt-4o-mini', fallbackModel: null, temperature: 0.55, maxTokens: 1800 };
  }

  if (qualityMode === 'high_precision' || hasScreenshot || highDetailTemplate || intent === 'code_review') {
    return { primaryModel: 'gpt-4o', fallbackModel: 'gpt-4o-mini', temperature: 0.45, maxTokens: 2200 };
  }

  return { primaryModel: 'gpt-4o-mini', fallbackModel: 'gpt-4o', temperature: 0.65, maxTokens: 2000 };
}
