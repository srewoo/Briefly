import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONTEXT_SIGNAL_PREFS,
  normalizeSettings,
  summarizeRecentTurns,
  appendRecentTurn,
  resolveModelPlan,
  LLM_PROVIDERS,
  getProviderConfig,
  estimateCost,
  estimateTokenCount,
  budgetContextTokens,
  getSignalPriority
} from '../Briefly/background/modelUtils.mjs';

// ─── normalizeSettings ───

test('normalizeSettings deep-merges context signal prefs', () => {
  const settings = normalizeSettings({
    qualityMode: 'fast',
    contextSignalPrefs: {
      screenshot: false,
      codeBlocks: false
    }
  });

  assert.equal(settings.qualityMode, 'fast');
  assert.equal(settings.contextSignalPrefs.screenshot, false);
  assert.equal(settings.contextSignalPrefs.codeBlocks, false);
  assert.equal(settings.contextSignalPrefs.selectedText, DEFAULT_CONTEXT_SIGNAL_PREFS.selectedText);
});

test('normalizeSettings includes new multi-LLM fields', () => {
  const settings = normalizeSettings({});
  assert.equal(settings.llmProvider, 'openai');
  assert.equal(settings.ollamaEndpoint, 'http://localhost:11434');
  assert.equal(settings.historyLimit, 500);
  assert.equal(settings.costTrackingEnabled, true);
  assert.equal(settings.feedbackEnabled, true);
  assert.equal(settings.contextExtractionTimeout, 2000);
});

test('normalizeSettings preserves user overrides for new fields', () => {
  const settings = normalizeSettings({ llmProvider: 'anthropic', historyLimit: 1000 });
  assert.equal(settings.llmProvider, 'anthropic');
  assert.equal(settings.historyLimit, 1000);
});

// ─── summarizeRecentTurns ───

test('summarizeRecentTurns respects threadMemory toggle', () => {
  const turns = [{ transcript: 'one', intent: 'custom', templateId: 'general_assistant', output: 'draft' }];
  assert.equal(summarizeRecentTurns(turns, { threadMemory: false }), '');
  assert.match(summarizeRecentTurns(turns, { threadMemory: true }), /Request: one/);
});

test('summarizeRecentTurns handles empty arrays', () => {
  assert.equal(summarizeRecentTurns([], {}), '');
  assert.equal(summarizeRecentTurns(null, {}), '');
  assert.equal(summarizeRecentTurns(undefined, {}), '');
});

test('summarizeRecentTurns truncates long transcripts', () => {
  const longText = 'a'.repeat(500);
  const turns = [{ transcript: longText, intent: 'custom', templateId: 'general_assistant', output: 'draft' }];
  const result = summarizeRecentTurns(turns, { threadMemory: true });
  assert.ok(result.length < longText.length);
});

// ─── appendRecentTurn ───

test('appendRecentTurn caps history at four turns', () => {
  const turns = [1, 2, 3, 4].map(n => ({ transcript: String(n) }));
  const next = appendRecentTurn(turns, { transcript: '5' });
  assert.equal(next.length, 4);
  assert.deepEqual(next.map(turn => turn.transcript), ['2', '3', '4', '5']);
});

test('appendRecentTurn handles null/undefined input', () => {
  const result = appendRecentTurn(null, { transcript: 'first' });
  assert.equal(result.length, 1);
  assert.equal(result[0].transcript, 'first');
});

// ─── resolveModelPlan ───

test('resolveModelPlan returns OpenAI models by default', () => {
  const plan = resolveModelPlan({ settings: { qualityMode: 'balanced' }, templateId: 'general_assistant', intent: 'custom', hasScreenshot: false });
  assert.equal(plan.provider, 'openai');
  assert.equal(plan.primaryModel, 'gpt-4.1-mini');
});

test('resolveModelPlan escalates for screenshots', () => {
  const plan = resolveModelPlan({ settings: { qualityMode: 'balanced' }, templateId: 'general_assistant', intent: 'custom', hasScreenshot: true });
  assert.equal(plan.primaryModel, 'gpt-4.1');
});

test('resolveModelPlan respects fast mode', () => {
  const plan = resolveModelPlan({ settings: { qualityMode: 'fast' }, templateId: 'general_assistant', intent: 'custom', hasScreenshot: false });
  assert.equal(plan.primaryModel, 'gpt-4.1-mini');
  assert.equal(plan.fallbackModel, null);
});

test('resolveModelPlan supports Anthropic provider', () => {
  const plan = resolveModelPlan({ settings: { llmProvider: 'anthropic', qualityMode: 'balanced' }, templateId: 'general_assistant', intent: 'custom', hasScreenshot: false });
  assert.equal(plan.provider, 'anthropic');
  assert.equal(plan.primaryModel, 'claude-sonnet-4-6');
});

test('resolveModelPlan supports Gemini provider', () => {
  const plan = resolveModelPlan({ settings: { llmProvider: 'gemini', qualityMode: 'high_precision' }, templateId: 'general_assistant', intent: 'custom', hasScreenshot: false });
  assert.equal(plan.provider, 'gemini');
  assert.equal(plan.primaryModel, 'gemini-2.5-pro');
});

test('resolveModelPlan supports Ollama provider', () => {
  const plan = resolveModelPlan({ settings: { llmProvider: 'ollama', qualityMode: 'balanced' }, templateId: 'general_assistant', intent: 'custom', hasScreenshot: false });
  assert.equal(plan.provider, 'ollama');
  assert.equal(plan.primaryModel, 'llama3');
});

test('resolveModelPlan escalates for high-detail templates', () => {
  for (const templateId of ['pr_review', 'test_plan', 'product_spec', 'bug_report']) {
    const plan = resolveModelPlan({ settings: { qualityMode: 'balanced' }, templateId, intent: 'custom', hasScreenshot: false });
    assert.equal(plan.primaryModel, 'gpt-4.1', `Expected high-detail model for ${templateId}`);
  }
});

test('resolveModelPlan escalates for code_review intent', () => {
  const plan = resolveModelPlan({ settings: { qualityMode: 'balanced' }, templateId: 'general_assistant', intent: 'code_review', hasScreenshot: false });
  assert.equal(plan.primaryModel, 'gpt-4.1');
});

// ─── LLM Providers ───

test('LLM_PROVIDERS has all expected providers', () => {
  assert.ok(LLM_PROVIDERS.openai);
  assert.ok(LLM_PROVIDERS.anthropic);
  assert.ok(LLM_PROVIDERS.gemini);
  assert.ok(LLM_PROVIDERS.ollama);
});

test('getProviderConfig returns OpenAI for unknown provider', () => {
  const config = getProviderConfig('unknown');
  assert.equal(config.id, 'openai');
});

test('each provider has fast/balanced/high_precision models', () => {
  for (const [id, provider] of Object.entries(LLM_PROVIDERS)) {
    assert.ok(provider.models.fast, `${id} missing fast model`);
    assert.ok(provider.models.balanced, `${id} missing balanced model`);
    assert.ok(provider.models.high_precision, `${id} missing high_precision model`);
  }
});

// ─── Cost Tracking ───

test('estimateCost calculates correctly for known models', () => {
  const cost = estimateCost('gpt-4.1-mini', 1000, 500);
  assert.ok(cost.totalCost > 0);
  assert.equal(cost.model, 'gpt-4.1-mini');
  assert.ok(cost.inputCost >= 0);
  assert.ok(cost.outputCost >= 0);
  assert.ok(Math.abs(cost.totalCost - cost.inputCost - cost.outputCost) < 0.0001);
});

test('estimateCost returns zero for unknown models', () => {
  const cost = estimateCost('unknown-model', 1000, 500);
  assert.equal(cost.totalCost, 0);
});

test('estimateCost returns zero for Ollama (local)', () => {
  const cost = estimateCost('llama3', 1000, 500);
  assert.equal(cost.totalCost, 0);
});

test('estimateTokenCount approximates correctly', () => {
  assert.equal(estimateTokenCount(''), 0);
  assert.equal(estimateTokenCount(null), 0);
  const estimate = estimateTokenCount('Hello world, this is a test');
  assert.ok(estimate > 0);
  assert.ok(estimate < 20);
});

// ─── Context Budgeting ───

test('getSignalPriority returns array for known intents', () => {
  const priority = getSignalPriority('code_review');
  assert.ok(Array.isArray(priority));
  assert.ok(priority.includes('codeBlocks'));
});

test('getSignalPriority returns default for unknown intents', () => {
  const priority = getSignalPriority('nonexistent');
  assert.ok(Array.isArray(priority));
  assert.ok(priority.length > 0);
});

test('budgetContextTokens respects token limit', () => {
  const context = {
    selectedText: 'a'.repeat(10000),
    visibleText: 'b'.repeat(10000),
    codeBlocks: [{ lang: 'js', code: 'c'.repeat(5000) }]
  };
  const { budgeted, usedTokens } = budgetContextTokens(context, 'summarize', 500);
  assert.ok(usedTokens <= 600); // some tolerance
  assert.ok(budgeted.selectedText.length < 10000);
});

test('budgetContextTokens handles empty context', () => {
  const { budgeted, usedTokens } = budgetContextTokens({}, 'summarize', 500);
  assert.equal(usedTokens, 0);
  assert.deepEqual(budgeted, {});
});
