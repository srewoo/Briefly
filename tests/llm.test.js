import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSegments, parsePodcastScript, llmCostNote, cleanupTranscript } from '../Briefly/lib/llm.js';
import { fakeResponse, stubFetch } from './helpers.js';

test('toSegments splits on blank lines and strips markdown bullets', () => {
  const segs = toSegments('First para.\n\n- Second bullet\n\n* Third');
  assert.equal(segs.length, 3);
  assert.equal(segs[0].text, 'First para.');
  assert.equal(segs[1].text, 'Second bullet');
  assert.equal(segs[2].text, 'Third');
  assert.equal(segs[0].srcIdx, -1);
});

test('toSegments carries a provided srcIdx', () => {
  const segs = toSegments('Only one.', 7);
  assert.equal(segs[0].srcIdx, 7);
});

test('parsePodcastScript accepts a clean JSON array', () => {
  const turns = parsePodcastScript('[{"host":"A","text":"Hi"},{"host":"B","text":"Hello"}]');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].host, 'A');
  assert.equal(turns[1].host, 'B');
});

test('parsePodcastScript strips code fences and surrounding prose', () => {
  const raw = 'Sure!\n```json\n[{"host":"A","text":"X"},{"host":"b","text":"Y"}]\n```';
  const turns = parsePodcastScript(raw);
  assert.equal(turns.length, 2);
  assert.equal(turns[1].host, 'B', 'host is upper-cased');
});

test('parsePodcastScript rejects invalid host', () => {
  assert.throws(() => parsePodcastScript('[{"host":"C","text":"x"},{"host":"A","text":"y"}]'), /invalid host/);
});

test('parsePodcastScript rejects single-host output', () => {
  assert.throws(() => parsePodcastScript('[{"host":"A","text":"x"},{"host":"A","text":"y"}]'), /single-host/);
});

test('parsePodcastScript rejects too-short output', () => {
  assert.throws(() => parsePodcastScript('[{"host":"A","text":"x"}]'), /too short/);
});

test('llmCostNote is empty when Groq (free) key present', () => {
  assert.equal(llmCostNote({ groqKey: 'g' }), '');
  assert.match(llmCostNote({}), /LLM/);
});

test('cleanupTranscript sends vocabulary + transcript and returns cleaned text', async () => {
  const calls = stubFetch([fakeResponse({
    ok: true, status: 200,
    json: { choices: [{ message: { content: 'I love Kubernetes.' } }] }
  })]);
  const out = await cleanupTranscript({
    text: 'um i love cooper netties you know',
    keys: { groqKey: 'gsk_x' },
    vocabulary: ['Kubernetes', 'Anthropic']
  });
  assert.equal(out, 'I love Kubernetes.');
  const body = JSON.parse(calls[0].init.body);
  assert.match(calls[0].url, /groq\.com/, 'prefers Groq when its key is set');
  assert.match(body.messages[0].content, /Kubernetes, Anthropic/, 'vocab injected into system prompt');
  assert.equal(body.messages[1].content, 'um i love cooper netties you know');
});

test('cleanupTranscript returns empty input untouched without calling the API', async () => {
  let called = 0;
  stubFetch(() => { called++; return fakeResponse({ json: { choices: [] } }); });
  assert.equal(await cleanupTranscript({ text: '   ', keys: { groqKey: 'x' } }), '   ');
  assert.equal(called, 0);
});
