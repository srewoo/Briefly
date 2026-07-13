import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheKey } from '../Briefly/lib/audio-cache.js';

test('cacheKey is a deterministic 64-char SHA-256 hex', async () => {
  const k1 = await cacheKey(['openai', 'oa:tts-1:nova', 'Hello world']);
  const k2 = await cacheKey(['openai', 'oa:tts-1:nova', 'Hello world']);
  assert.equal(k1, k2);
  assert.equal(k1.length, 64);
  assert.match(k1, /^[0-9a-f]{64}$/);
});

test('cacheKey differs when any part changes', async () => {
  const base = await cacheKey(['openai', 'sig', 'text']);
  assert.notEqual(base, await cacheKey(['openai', 'sig', 'text2']));
  assert.notEqual(base, await cacheKey(['elevenlabs', 'sig', 'text']));
});
