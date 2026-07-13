import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceScore, isHQ, rankVoices } from '../Briefly/lib/voice-rank.js';

const V = (name, lang = 'en-US', localService = true) => ({ name, lang, localService, voiceURI: name });

test('voiceScore rewards neural/premium and penalizes novelty', () => {
  assert.ok(voiceScore(V('Google US English')) > voiceScore(V('Samantha')));
  assert.ok(voiceScore(V('Zarvox')) < 0, 'novelty voice penalized');
  assert.ok(voiceScore(V('Ava (Premium)')) > voiceScore(V('Ava (Compact)')));
});

test('isHQ requires a high-quality marker and no low-quality marker', () => {
  assert.equal(isHQ(V('Microsoft Aria Natural')), true);
  assert.equal(isHQ(V('Fred')), false);
  assert.equal(isHQ(V('Whisper')), false, 'novelty despite matching nothing HQ');
});

test('rankVoices puts the UI language first, then quality', () => {
  const voices = [
    V('Fred', 'en-US'),
    V('Google Español', 'es-ES', false),
    V('Google US English', 'en-US', false)
  ];
  const ranked = rankVoices(voices, 'en-GB');
  assert.equal(ranked[0].name, 'Google US English', 'English + HQ first');
  assert.equal(ranked[ranked.length - 1].name, 'Google Español', 'non-UI-language last');
});

test('rankVoices does not mutate the input', () => {
  const voices = [V('B'), V('A')];
  const copy = [...voices];
  rankVoices(voices, 'en');
  assert.deepEqual(voices, copy);
});
