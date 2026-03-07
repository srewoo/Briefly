import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONTEXT_SIGNAL_PREFS,
  normalizeSettings,
  summarizeRecentTurns,
  appendRecentTurn,
  resolveModelPlan
} from '../Briefly/background/modelUtils.mjs';

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

test('summarizeRecentTurns respects threadMemory toggle', () => {
  const turns = [{ transcript: 'one', intent: 'custom', templateId: 'general_assistant', output: 'draft' }];
  assert.equal(summarizeRecentTurns(turns, { threadMemory: false }), '');
  assert.match(summarizeRecentTurns(turns, { threadMemory: true }), /Request: one/);
});

test('appendRecentTurn caps history at four turns', () => {
  const turns = [1, 2, 3, 4].map(n => ({ transcript: String(n) }));
  const next = appendRecentTurn(turns, { transcript: '5' });
  assert.equal(next.length, 4);
  assert.deepEqual(next.map(turn => turn.transcript), ['2', '3', '4', '5']);
});

test('resolveModelPlan escalates for screenshots and high precision mode', () => {
  const balanced = resolveModelPlan({ settings: { qualityMode: 'balanced' }, templateId: 'general_assistant', intent: 'custom', hasScreenshot: false });
  const visual = resolveModelPlan({ settings: { qualityMode: 'balanced' }, templateId: 'general_assistant', intent: 'custom', hasScreenshot: true });
  const fast = resolveModelPlan({ settings: { qualityMode: 'fast' }, templateId: 'general_assistant', intent: 'custom', hasScreenshot: false });

  assert.equal(balanced.primaryModel, 'gpt-4o-mini');
  assert.equal(visual.primaryModel, 'gpt-4o');
  assert.equal(fast.primaryModel, 'gpt-4o-mini');
  assert.equal(fast.fallbackModel, null);
});
