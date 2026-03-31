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
  contextSignalPrefs: { ...DEFAULT_CONTEXT_SIGNAL_PREFS },
  // Multi-LLM provider settings
  llmProvider: 'openai',
  ollamaEndpoint: 'http://localhost:11434',
  ollamaModel: 'llama3',
  // Cost tracking
  costTrackingEnabled: true,
  costBudgetMonthly: 0, // 0 = no limit
  // History
  historyLimit: 500,
  // Feedback
  feedbackEnabled: true,
  // Content script performance
  contextExtractionTimeout: 2000,
  skipHeavyPages: true
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

// ─────────────────────────────────────────────────────────────────
// LLM PROVIDER DEFINITIONS
// ─────────────────────────────────────────────────────────────────
export const LLM_PROVIDERS = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    keyName: 'openai',
    models: {
      fast: 'gpt-4.1-mini',
      balanced: 'gpt-4.1-mini',
      high_precision: 'gpt-4.1'
    },
    fallback: { 'gpt-4.1': 'gpt-4.1-mini', 'gpt-4.1-mini': 'gpt-4.1' },
    supportsStreaming: true,
    supportsVision: true,
    endpoint: 'https://api.openai.com/v1/chat/completions',
    transcriptionEndpoint: 'https://api.openai.com/v1/audio/transcriptions'
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    keyName: 'anthropic',
    models: {
      fast: 'claude-haiku-4-5-20251001',
      balanced: 'claude-sonnet-4-6',
      high_precision: 'claude-opus-4-6'
    },
    fallback: { 'claude-opus-4-6': 'claude-sonnet-4-6', 'claude-sonnet-4-6': 'claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001': 'claude-sonnet-4-6' },
    supportsStreaming: true,
    supportsVision: true,
    endpoint: 'https://api.anthropic.com/v1/messages'
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    keyName: 'gemini',
    models: {
      fast: 'gemini-2.0-flash',
      balanced: 'gemini-2.5-pro',
      high_precision: 'gemini-2.5-pro'
    },
    fallback: { 'gemini-2.5-pro': 'gemini-2.0-flash', 'gemini-2.0-flash': 'gemini-2.5-pro' },
    supportsStreaming: true,
    supportsVision: true,
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models'
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (Local)',
    keyName: null,
    models: {
      fast: 'llama3',
      balanced: 'llama3',
      high_precision: 'llama3'
    },
    fallback: {},
    supportsStreaming: true,
    supportsVision: false,
    endpoint: 'http://localhost:11434/api/chat'
  }
};

export function getProviderConfig(providerId) {
  return LLM_PROVIDERS[providerId] || LLM_PROVIDERS.openai;
}

export function resolveModelPlan({ settings = {}, templateId, intent, hasScreenshot }) {
  const qualityMode = settings.qualityMode || 'balanced';
  const highDetailTemplate = ['pr_review', 'test_plan', 'product_spec', 'bug_report'].includes(templateId);
  const provider = getProviderConfig(settings.llmProvider || 'openai');

  let effectiveQuality = qualityMode;
  if (qualityMode === 'balanced' && (hasScreenshot || highDetailTemplate || intent === 'code_review')) {
    effectiveQuality = 'high_precision';
  }

  const primaryModel = provider.models[effectiveQuality] || provider.models.balanced;
  const fallbackModel = qualityMode === 'fast' ? null : (provider.fallback[primaryModel] || null);

  const temperatureMap = { fast: 0.55, balanced: 0.65, high_precision: 0.45 };
  const maxTokensMap = { fast: 1800, balanced: 2000, high_precision: 2200 };

  return {
    provider: provider.id,
    primaryModel,
    fallbackModel: fallbackModel !== primaryModel ? fallbackModel : null,
    temperature: temperatureMap[effectiveQuality] || 0.65,
    maxTokens: maxTokensMap[effectiveQuality] || 2000,
    supportsStreaming: provider.supportsStreaming,
    supportsVision: provider.supportsVision,
    endpoint: provider.endpoint
  };
}

// ─────────────────────────────────────────────────────────────────
// COST TRACKING
// ─────────────────────────────────────────────────────────────────
const COST_PER_1K_TOKENS = {
  // OpenAI
  'gpt-4.1': { input: 0.002, output: 0.008 },
  'gpt-4.1-mini': { input: 0.0004, output: 0.0016 },
  'gpt-4.1-mini-transcribe': { input: 0.0, output: 0.0 },
  'o4-mini': { input: 0.0011, output: 0.0044 },
  // Anthropic
  'claude-opus-4-6': { input: 0.015, output: 0.075 },
  'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
  'claude-haiku-4-5-20251001': { input: 0.0008, output: 0.004 },
  // Gemini
  'gemini-2.5-pro': { input: 0.00125, output: 0.01 },
  'gemini-2.0-flash': { input: 0.0001, output: 0.0004 },
  // Ollama (local, free)
  'llama3': { input: 0, output: 0 }
};

export function estimateCost(model, inputTokens, outputTokens) {
  const rates = COST_PER_1K_TOKENS[model] || { input: 0, output: 0 };
  return {
    inputCost: (inputTokens / 1000) * rates.input,
    outputCost: (outputTokens / 1000) * rates.output,
    totalCost: (inputTokens / 1000) * rates.input + (outputTokens / 1000) * rates.output,
    model
  };
}

export function estimateTokenCount(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.8);
}

// ─────────────────────────────────────────────────────────────────
// CONTEXT BUDGETING
// ─────────────────────────────────────────────────────────────────
const SIGNAL_PRIORITY_BY_INTENT = {
  summarize: ['selectedText', 'visibleText', 'headings', 'structuredData'],
  code_review: ['selectedText', 'codeBlocks', 'domainArtifacts', 'headings'],
  task_extraction: ['selectedText', 'visibleText', 'formFields', 'headings'],
  documentation: ['selectedText', 'visibleText', 'codeBlocks', 'headings'],
  testing: ['selectedText', 'codeBlocks', 'domainArtifacts', 'visibleText'],
  bug_report: ['selectedText', 'domainArtifacts', 'codeBlocks', 'formFields'],
  explain: ['selectedText', 'visibleText', 'codeBlocks', 'headings'],
  custom: ['selectedText', 'visibleText', 'codeBlocks', 'headings']
};

export function getSignalPriority(intent) {
  return SIGNAL_PRIORITY_BY_INTENT[intent] || SIGNAL_PRIORITY_BY_INTENT.custom;
}

export function budgetContextTokens(context, intent, maxTokens = 3000) {
  const priority = getSignalPriority(intent);
  const budgeted = {};
  let usedTokens = 0;

  for (const signal of priority) {
    if (usedTokens >= maxTokens) break;
    const value = context[signal];
    if (!value) continue;

    const remaining = maxTokens - usedTokens;
    if (typeof value === 'string') {
      const maxChars = Math.floor(remaining * 3.8);
      budgeted[signal] = value.slice(0, maxChars);
      usedTokens += estimateTokenCount(budgeted[signal]);
    } else if (Array.isArray(value)) {
      const items = [];
      for (const item of value) {
        const itemTokens = estimateTokenCount(JSON.stringify(item));
        if (usedTokens + itemTokens > maxTokens) break;
        items.push(item);
        usedTokens += itemTokens;
      }
      budgeted[signal] = items;
    } else {
      budgeted[signal] = value;
      usedTokens += estimateTokenCount(JSON.stringify(value));
    }
  }

  return { budgeted, usedTokens };
}
