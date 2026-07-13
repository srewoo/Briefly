import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers.js';

// Storage reads `chrome` lazily inside its methods, so install the mock before
// importing is not required — but we reset it before each test for isolation.
let Storage;
beforeEach(async () => {
  installChromeMock();
  ({ Storage } = await import('../Briefly/lib/storage.js'));
});

test('getSettings merges saved values over defaults', async () => {
  await chrome.storage.local.set({ settings: { theme: 'light' } });
  const s = await Storage.getSettings();
  assert.equal(s.theme, 'light');
  assert.equal(s.sttProvider, 'webspeech', 'default preserved');
  assert.equal(s.historyLimit, 50);
});

test('setSettings persists a patch and keeps prior values', async () => {
  await Storage.setSettings({ theme: 'light' });
  await Storage.setSettings({ ttsRate: 1.5 });
  const s = await Storage.getSettings();
  assert.equal(s.theme, 'light');
  assert.equal(s.ttsRate, 1.5);
});

test('getKeys returns empty strings for unset keys', async () => {
  const k = await Storage.getKeys();
  assert.equal(k.openaiKey, '');
  assert.equal(k.deepgramKey, '');
});

test('addHistory prepends and enforces historyLimit', async () => {
  await Storage.setSettings({ historyLimit: 2 });
  await Storage.addHistory({ type: 'stt', text: 'one' });
  await Storage.addHistory({ type: 'stt', text: 'two' });
  await Storage.addHistory({ type: 'stt', text: 'three' });
  const h = await Storage.getHistory();
  assert.equal(h.length, 2);
  assert.equal(h[0].text, 'three', 'newest first');
  assert.equal(h[1].text, 'two');
});

test('deleteHistory removes a single entry by id', async () => {
  const a = await Storage.addHistory({ type: 'stt', text: 'a' });
  await Storage.addHistory({ type: 'stt', text: 'b' });
  await Storage.deleteHistory(a.id);
  const h = await Storage.getHistory();
  assert.equal(h.length, 1);
  assert.equal(h[0].text, 'b');
});
