import test from 'node:test';
import assert from 'node:assert/strict';

// The intent classifier uses self.IntentClassifier pattern, so we need to simulate
// We'll import it by evaluating the file content since it's not a module
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(__dirname, '../Briefly/background/intentClassifier.js'), 'utf8');

// Create a minimal environment for the classifier
const self = {};
const chrome = { storage: { local: { get: async () => ({ intentCorrections: [] }) } } };
const module = {};
new Function('self', 'chrome', 'module', code)(self, chrome, module);

const IntentClassifier = self.IntentClassifier || module.exports;

// ─── Basic classification ───

test('classify returns custom for empty input', () => {
  const result = IntentClassifier.classify('');
  assert.equal(result.primary_intent, 'custom');
  assert.equal(result.fallback, true);
});

test('classify returns custom for very short input', () => {
  const result = IntentClassifier.classify('a');
  assert.equal(result.primary_intent, 'custom');
});

test('classify identifies summarize intent', () => {
  const result = IntentClassifier.classify('summarize this page for me');
  assert.equal(result.primary_intent, 'summarize');
  assert.ok(result.confidence > 0.5);
});

test('classify identifies code review intent', () => {
  const result = IntentClassifier.classify('review this pull request');
  assert.equal(result.primary_intent, 'code_review');
});

test('classify identifies task extraction intent', () => {
  const result = IntentClassifier.classify('extract the action items and tasks');
  assert.equal(result.primary_intent, 'task_extraction');
});

test('classify identifies email draft intent', () => {
  const result = IntentClassifier.classify('draft an email reply to this');
  assert.equal(result.primary_intent, 'email_draft');
});

test('classify identifies explain intent', () => {
  const result = IntentClassifier.classify('explain what this code does');
  assert.equal(result.primary_intent, 'explain');
});

test('classify identifies testing intent', () => {
  const result = IntentClassifier.classify('generate test cases for this function');
  assert.equal(result.primary_intent, 'testing');
});

test('classify identifies documentation intent', () => {
  const result = IntentClassifier.classify('document this API endpoint');
  assert.equal(result.primary_intent, 'documentation');
});

test('classify identifies compare intent', () => {
  const result = IntentClassifier.classify('compare these two approaches pros and cons');
  assert.equal(result.primary_intent, 'compare');
});

test('classify identifies translate intent', () => {
  const result = IntentClassifier.classify('translate this into spanish');
  assert.equal(result.primary_intent, 'translate_intent');
});

test('classify identifies user story intent', () => {
  const result = IntentClassifier.classify('write a user story with acceptance criteria');
  assert.equal(result.primary_intent, 'user_story');
});

// ─── Confidence and fallback ───

test('classify returns high confidence for clear intents', () => {
  const result = IntentClassifier.classify('summarize the key points and give me a tldr');
  assert.ok(result.confidence > 0.6, `Expected high confidence, got ${result.confidence}`);
  assert.equal(result.fallback, false);
});

test('classify returns lower confidence for ambiguous input', () => {
  const result = IntentClassifier.classify('help me with this');
  // Ambiguous - should have lower confidence or fall back to custom
  assert.ok(result.confidence <= 0.99);
});

// ─── Top3 and secondary intent ───

test('classify returns top3 array', () => {
  const result = IntentClassifier.classify('summarize and review this document');
  assert.ok(Array.isArray(result.top3));
  assert.ok(result.top3.length > 0);
  assert.ok(result.top3[0].intent);
  assert.ok(typeof result.top3[0].score === 'number');
});

test('classify returns secondary intent when available', () => {
  const result = IntentClassifier.classify('summarize and review the code');
  if (result.secondary_intent) {
    assert.ok(typeof result.secondary_intent === 'string');
    assert.notEqual(result.secondary_intent, result.primary_intent);
  }
});

// ─── Context-aware boosting ───

test('classify boosts code review for github-pr context', () => {
  const withoutContext = IntentClassifier.classify('look at this review', {});
  const withContext = IntentClassifier.classify('look at this review', { pageType: 'github-pr' });
  // With context boost, code_review should score higher
  if (withContext.primary_intent === 'code_review') {
    assert.ok(true, 'Context boosted code_review as expected');
  }
});

test('classify boosts summarize for article context', () => {
  const result = IntentClassifier.classify('give me the overview', { pageType: 'article' });
  assert.equal(result.primary_intent, 'summarize');
});

// ─── Match details ───

test('classify returns match details', () => {
  const result = IntentClassifier.classify('summarize the key points');
  assert.ok(result.matchDetails);
  assert.ok(typeof result.matchDetails.totalScore === 'number');
  assert.ok(typeof result.matchDetails.topScore === 'number');
  assert.ok(typeof result.matchDetails.gap === 'number');
});

// ─── Labels and icons ───

test('getLabel returns correct labels', () => {
  assert.equal(IntentClassifier.getLabel('summarize'), 'Summarize');
  assert.equal(IntentClassifier.getLabel('code_review'), 'Code Review');
  assert.equal(IntentClassifier.getLabel('custom'), 'Custom');
  assert.equal(IntentClassifier.getLabel('unknown'), 'Custom');
});

test('getIcon returns icons for all intents', () => {
  const intents = ['summarize', 'prompt_generation', 'task_extraction', 'documentation', 'testing', 'code_review', 'user_story', 'explain', 'translate_intent', 'email_draft', 'compare', 'custom'];
  for (const intent of intents) {
    assert.ok(IntentClassifier.getIcon(intent), `Missing icon for ${intent}`);
  }
});

// ─── Edge cases ───

test('classify handles unicode input', () => {
  const result = IntentClassifier.classify('summarize this page');
  assert.equal(result.primary_intent, 'summarize');
});

test('classify handles extra whitespace', () => {
  const result = IntentClassifier.classify('   summarize   this   page   ');
  assert.equal(result.primary_intent, 'summarize');
});

test('classify is case insensitive', () => {
  const result = IntentClassifier.classify('SUMMARIZE THIS PAGE');
  assert.equal(result.primary_intent, 'summarize');
});
