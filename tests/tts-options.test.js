import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers.js';

let buildOptions, buildHostVoices;
beforeEach(async () => {
  installChromeMock();
  ({ buildOptions, buildHostVoices } = await import('../Briefly/lib/tts-options.js'));
});

test('buildOptions returns webspeech options with no key', async () => {
  await chrome.storage.local.set({ settings: { ttsVoiceURI: 'v1' } });
  const { options, voiceSig } = await buildOptions('webspeech');
  assert.equal(options.voiceURI, 'v1');
  assert.match(voiceSig, /^ws:/);
});

test('buildOptions throws when a paid provider has no key', async () => {
  await assert.rejects(() => buildOptions('elevenlabs'), /ElevenLabs API key/);
});

test('buildOptions reads the ElevenLabs key from storage', async () => {
  await chrome.storage.local.set({
    apiKeys: { elevenlabsKey: 'sk_x' },
    settings: { elevenVoiceId: 'vid', elevenModelId: 'm' }
  });
  const { options } = await buildOptions('elevenlabs');
  assert.equal(options.apiKey, 'sk_x');
  assert.equal(options.voiceId, 'vid');
});

test('buildHostVoices picks a distinct Host B for OpenAI', () => {
  const hostA = { options: { voice: 'nova', model: 'tts-1' }, voiceSig: 'oa:tts-1:nova' };
  const { hostVoices, voiceSigs } = buildHostVoices('openai', hostA);
  assert.equal(hostVoices.A.voice, 'nova');
  assert.equal(hostVoices.B.voice, 'onyx');
  assert.notEqual(voiceSigs.A, voiceSigs.B);
});

test('buildHostVoices swaps ElevenLabs voice ids', () => {
  const RACHEL = '21m00Tcm4TlvDq8ikWAM';
  const hostA = { options: { voiceId: RACHEL, modelId: 'm' }, voiceSig: `el:m:${RACHEL}` };
  const { hostVoices } = buildHostVoices('elevenlabs', hostA);
  assert.notEqual(hostVoices.B.voiceId, RACHEL);
});
