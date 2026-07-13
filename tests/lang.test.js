import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAuto, webSpeechLang, AUTO, STT_LANGS } from '../Briefly/lib/lang.js';

test('isAuto treats empty and "auto" as auto-detect', () => {
  assert.equal(isAuto('auto'), true);
  assert.equal(isAuto(''), true);
  assert.equal(isAuto(undefined), true);
  assert.equal(isAuto('en-US'), false);
});

test('webSpeechLang resolves auto to the browser language', () => {
  assert.equal(webSpeechLang(AUTO, 'fr-FR'), 'fr-FR');
  assert.equal(webSpeechLang('auto', undefined), 'en-US');
  assert.equal(webSpeechLang('de-DE', 'fr-FR'), 'de-DE', 'concrete tag passes through');
});

test('STT_LANGS lists Auto-detect first', () => {
  assert.equal(STT_LANGS[0].code, AUTO);
  assert.ok(STT_LANGS.some(l => l.code === 'en-US'));
});
