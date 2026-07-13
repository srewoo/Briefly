import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, extFromMime, rfetch, STT, TRANSLATE_LANGS } from '../Briefly/lib/providers.js';
import { fakeResponse, stubFetch } from './helpers.js';

test('chunkText keeps chunks within max', () => {
  const chunks = chunkText('The quick brown fox jumps over the lazy dog.', 10);
  for (const c of chunks) assert.ok(c.length <= 10, `chunk too long: "${c}"`);
  assert.equal(chunks.join('').replace(/\s+/g, ' ').trim().length > 0, true);
});

test('chunkText hard-splits a word longer than max', () => {
  const chunks = chunkText('supercalifragilistic', 5);
  for (const c of chunks) assert.ok(c.length <= 5);
  assert.equal(chunks.join(''), 'supercalifragilistic');
});

test('chunkText returns the original for short text', () => {
  assert.deepEqual(chunkText('hi', 100), ['hi']);
});

test('extFromMime maps common containers', () => {
  assert.equal(extFromMime('audio/webm;codecs=opus'), 'webm');
  assert.equal(extFromMime('audio/ogg'), 'ogg');
  assert.equal(extFromMime('audio/mp4'), 'mp4');
  assert.equal(extFromMime('audio/wav'), 'wav');
  assert.equal(extFromMime('audio/mpeg'), 'mp3');
  assert.equal(extFromMime(''), 'webm');
});

test('TRANSLATE_LANGS includes English and is well-formed', () => {
  assert.ok(TRANSLATE_LANGS.every(l => l.code && l.label));
  assert.ok(TRANSLATE_LANGS.some(l => l.code === 'en'));
});

test('rfetch returns immediately on 2xx', async () => {
  const calls = stubFetch([fakeResponse({ ok: true, status: 200 })]);
  const res = await rfetch('https://x', {}, { retries: 2, baseMs: 1 });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
});

test('rfetch retries on 500 then succeeds', async () => {
  const calls = stubFetch([
    fakeResponse({ ok: false, status: 500, statusText: 'err' }),
    fakeResponse({ ok: true, status: 200 })
  ]);
  const res = await rfetch('https://x', {}, { retries: 3, baseMs: 1 });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2, 'one retry');
});

test('rfetch does NOT retry a 404 and returns it', async () => {
  const calls = stubFetch([fakeResponse({ ok: false, status: 404 })]);
  const res = await rfetch('https://x', {}, { retries: 3, baseMs: 1 });
  assert.equal(res.status, 404);
  assert.equal(calls.length, 1);
});

test('Deepgram batch: auto-detect sets detect_language, parses transcript', async () => {
  const calls = stubFetch([fakeResponse({
    ok: true, status: 200,
    json: { results: { channels: [{ alternatives: [{ transcript: 'hello world' }] }] } }
  })]);
  const text = await STT.deepgram.transcribe({
    audio: new Blob(['x'], { type: 'audio/webm' }),
    apiKey: 'k', lang: 'auto'
  });
  assert.equal(text, 'hello world');
  assert.match(calls[0].url, /detect_language=true/);
  assert.doesNotMatch(calls[0].url, /language=auto/);
});

test('Deepgram batch: concrete language sets language param', async () => {
  const calls = stubFetch([fakeResponse({
    ok: true, status: 200,
    json: { results: { channels: [{ alternatives: [{ transcript: 'hola' }] }] } }
  })]);
  await STT.deepgram.transcribe({ audio: new Blob(['x']), apiKey: 'k', lang: 'es' });
  assert.match(calls[0].url, /language=es/);
});
