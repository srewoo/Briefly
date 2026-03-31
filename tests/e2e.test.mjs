/**
 * E2E-style integration tests for the Briefly pipeline.
 *
 * These tests exercise the complete pipeline from intent classification through
 * model plan resolution, context budgeting, and cost estimation — using only
 * the pure, importable modules (no chrome APIs required).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveModelPlan,
  budgetContextTokens,
  estimateCost,
  estimateTokenCount,
  getSignalPriority,
  normalizeSettings
} from '../Briefly/background/modelUtils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Load intent classifier ───
const classifierCode = readFileSync(join(__dirname, '../Briefly/background/intentClassifier.js'), 'utf8');
const selfEnv = {};
const chrome = { storage: { local: { get: async () => ({ intentCorrections: [] }) } } };
new Function('self', 'chrome', 'module', classifierCode)(selfEnv, chrome, {});
const IntentClassifier = selfEnv.IntentClassifier;

// ─── Full pipeline: transcript → intent → model plan ───

test('pipeline: summarize transcript → balanced OpenAI model', () => {
  const intent = IntentClassifier.classify('summarize the key points on this page');
  const plan = resolveModelPlan({
    settings: normalizeSettings({ qualityMode: 'balanced' }),
    templateId: 'general_assistant',
    intent: intent.primary_intent,
    hasScreenshot: false
  });
  assert.equal(intent.primary_intent, 'summarize');
  assert.equal(plan.provider, 'openai');
  assert.equal(plan.primaryModel, 'gpt-4.1-mini');
});

test('pipeline: code review transcript → escalated model', () => {
  const intent = IntentClassifier.classify('review this pull request for bugs');
  const plan = resolveModelPlan({
    settings: normalizeSettings({ qualityMode: 'balanced' }),
    templateId: 'pr_review',
    intent: intent.primary_intent,
    hasScreenshot: false
  });
  assert.equal(intent.primary_intent, 'code_review');
  assert.equal(plan.primaryModel, 'gpt-4.1'); // escalated for code_review
});

test('pipeline: screenshot present → high precision model', () => {
  const plan = resolveModelPlan({
    settings: normalizeSettings({ qualityMode: 'balanced' }),
    templateId: 'general_assistant',
    intent: 'custom',
    hasScreenshot: true
  });
  assert.equal(plan.primaryModel, 'gpt-4.1');
});

test('pipeline: anthropic provider + summarize intent', () => {
  const intent = IntentClassifier.classify('give me a tldr of this article');
  const plan = resolveModelPlan({
    settings: normalizeSettings({ llmProvider: 'anthropic', qualityMode: 'balanced' }),
    templateId: 'general_assistant',
    intent: intent.primary_intent,
    hasScreenshot: false
  });
  assert.equal(plan.provider, 'anthropic');
  assert.equal(plan.primaryModel, 'claude-sonnet-4-6');
});

// ─── Context budgeting by intent ───

test('context budget: code_review prioritises selectedText + codeBlocks', () => {
  const context = {
    selectedText: 'x'.repeat(5000),
    visibleText: 'y'.repeat(5000),
    codeBlocks: [{ lang: 'js', code: 'z'.repeat(2000) }],
    headings: [{ level: 1, text: 'Test' }]
  };
  const { budgeted } = budgetContextTokens(context, 'code_review', 1000);
  // selectedText should have been included (it's #1 in code_review priority)
  assert.ok(budgeted.selectedText?.length > 0, 'selectedText should be budgeted');
});

test('context budget: summarize prioritises visibleText when no selection', () => {
  const context = {
    visibleText: 'article content '.repeat(300),
    headings: [{ level: 1, text: 'Intro' }, { level: 2, text: 'Body' }],
    structuredData: { '@type': 'Article' }
  };
  const { budgeted, usedTokens } = budgetContextTokens(context, 'summarize', 500);
  assert.ok(usedTokens <= 550, `Expected <= 550 tokens, got ${usedTokens}`);
  assert.ok(budgeted.visibleText?.length > 0);
});

test('context budget: token limit is respected within tolerance', () => {
  const context = {
    selectedText: 'a'.repeat(50000),
    visibleText: 'b'.repeat(50000),
    codeBlocks: [{ lang: 'python', code: 'c'.repeat(20000) }]
  };
  const limit = 800;
  const { usedTokens } = budgetContextTokens(context, 'custom', limit);
  assert.ok(usedTokens <= limit + 50, `Exceeded limit: ${usedTokens} > ${limit}`);
});

test('context budget: empty context returns zero tokens', () => {
  const { budgeted, usedTokens } = budgetContextTokens({}, 'explain', 3000);
  assert.equal(usedTokens, 0);
  assert.deepEqual(budgeted, {});
});

test('context budget: signal priority differs by intent', () => {
  const codeFirst = getSignalPriority('code_review');
  const summFirst = getSignalPriority('summarize');
  // code_review: selectedText → codeBlocks → domainArtifacts → headings
  assert.equal(codeFirst[0], 'selectedText');
  assert.ok(codeFirst.includes('codeBlocks'), 'code_review should prioritise codeBlocks');
  assert.ok(codeFirst.indexOf('codeBlocks') < codeFirst.indexOf('headings'));
  // summarize: selectedText → visibleText → headings → structuredData
  assert.ok(summFirst.includes('visibleText'), 'summarize should prioritise visibleText');
  assert.ok(summFirst.indexOf('visibleText') < summFirst.indexOf('headings'));
});

// ─── Cost estimation ───

test('cost: real token counts produce accurate estimate', () => {
  const cost = estimateCost('gpt-4.1', 2000, 500);
  const expectedInput = (2000 / 1000) * 0.002;
  const expectedOutput = (500 / 1000) * 0.008;
  assert.ok(Math.abs(cost.inputCost - expectedInput) < 0.0001);
  assert.ok(Math.abs(cost.outputCost - expectedOutput) < 0.0001);
  assert.ok(Math.abs(cost.totalCost - (expectedInput + expectedOutput)) < 0.0001);
});

test('cost: anthropic claude-opus-4-6 pricing', () => {
  const cost = estimateCost('claude-opus-4-6', 1000, 1000);
  assert.ok(cost.inputCost > 0);
  assert.ok(cost.outputCost > cost.inputCost); // output more expensive
});

test('cost: ollama local models are free', () => {
  const cost = estimateCost('llama3', 10000, 5000);
  assert.equal(cost.totalCost, 0);
});

// ─── Budget warning thresholds ───

function checkBudgetLevel(totalCost, prevCost, budget) {
  if (budget <= 0) return null;
  const prev = prevCost / budget;
  const curr = totalCost / budget;
  if (curr >= 1.0 && prev < 1.0) return 'exceeded';
  if (curr >= 0.9 && prev < 0.9) return 'danger';
  if (curr >= 0.8 && prev < 0.8) return 'warning';
  return null;
}

test('budget warning: fires "warning" when crossing 80%', () => {
  assert.equal(checkBudgetLevel(8.1, 7.9, 10), 'warning');
});

test('budget warning: fires "danger" when crossing 90%', () => {
  assert.equal(checkBudgetLevel(9.1, 8.9, 10), 'danger');
});

test('budget warning: fires "exceeded" when crossing 100%', () => {
  assert.equal(checkBudgetLevel(10.1, 9.9, 10), 'exceeded');
});

test('budget warning: no warning if already above threshold from last request', () => {
  // Already at 85% last time, now at 87% — should not re-fire "warning"
  assert.equal(checkBudgetLevel(8.7, 8.5, 10), null);
});

test('budget warning: no warning when budget is 0 (disabled)', () => {
  assert.equal(checkBudgetLevel(100, 90, 0), null);
});

// ─── Feedback preferences ───

function extractFeedbackPreferences(feedbackLog) {
  const preferences = [];
  for (const entry of (feedbackLog || []).slice(0, 15)) {
    if (entry.rating === 'negative' && entry.note?.trim()) {
      preferences.push(`Avoid: ${entry.note.trim().slice(0, 120)}`);
    } else if (entry.rating === 'positive' && entry.note?.trim()) {
      preferences.push(`User liked: ${entry.note.trim().slice(0, 120)}`);
    }
  }
  return [...new Set(preferences)].slice(0, 3);
}

test('feedback preferences: extracts negative notes as "Avoid:"', () => {
  const log = [
    { rating: 'negative', note: 'Too verbose' },
    { rating: 'negative', note: 'Used bullet lists everywhere' }
  ];
  const prefs = extractFeedbackPreferences(log);
  assert.ok(prefs.some(p => p.includes('Too verbose')));
  assert.ok(prefs.every(p => p.startsWith('Avoid:') || p.startsWith('User liked:')));
});

test('feedback preferences: extracts positive notes as "User liked:"', () => {
  const log = [{ rating: 'positive', note: 'Great concise format' }];
  const prefs = extractFeedbackPreferences(log);
  assert.ok(prefs[0].startsWith('User liked:'));
});

test('feedback preferences: ignores entries without notes', () => {
  const log = [
    { rating: 'negative', note: '' },
    { rating: 'positive' },
    { rating: 'negative', note: '   ' }
  ];
  const prefs = extractFeedbackPreferences(log);
  assert.equal(prefs.length, 0);
});

test('feedback preferences: caps at 3 unique entries', () => {
  const log = Array.from({ length: 10 }, (_, i) => ({
    rating: 'negative',
    note: `Issue ${i}`
  }));
  const prefs = extractFeedbackPreferences(log);
  assert.equal(prefs.length, 3);
});

test('feedback preferences: deduplicates identical notes', () => {
  const log = [
    { rating: 'negative', note: 'Too long' },
    { rating: 'negative', note: 'Too long' },
    { rating: 'negative', note: 'Too long' }
  ];
  const prefs = extractFeedbackPreferences(log);
  assert.equal(prefs.length, 1);
});

// ─── Token estimation ───

test('estimateTokenCount: empty/null returns 0', () => {
  assert.equal(estimateTokenCount(''), 0);
  assert.equal(estimateTokenCount(null), 0);
});

test('estimateTokenCount: scales reasonably with text length', () => {
  const short = estimateTokenCount('hello world');
  const long = estimateTokenCount('hello world '.repeat(100));
  assert.ok(long > short * 50, 'Longer text should produce many more tokens');
});
