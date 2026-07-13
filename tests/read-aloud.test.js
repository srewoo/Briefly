import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers.js';

// Build a chrome mock that emulates the headless read-aloud surface:
// tabs.query, scripting.executeScript, tabs.sendMessage, runtime.sendMessage.
function installReadAloudChrome({ tab, selection = '', extract, storage = {}, executeThrows = false } = {}) {
  installChromeMock(storage);
  const sent = [];
  chrome.tabs = {
    async query() { return tab ? [tab] : []; },
    async sendMessage(_id, msg) {
      if (msg?.type === 'BRIEFLY_EXTRACT') return extract;
      return undefined;
    }
  };
  chrome.scripting = {
    async executeScript({ func, files }) {
      if (executeThrows) throw new Error('no host access');
      if (files) return [{ result: undefined }];      // content-script injection
      return [{ result: selection.trim() }];          // selection getter (func trims)
    }
  };
  chrome.runtime = { async sendMessage(msg) { sent.push(msg); return { ok: true }; } };
  return sent;
}

let mod;
beforeEach(async () => { mod = await import('../Briefly/lib/read-aloud.js'); });

const deps = () => {
  let called = 0;
  return { calls: () => called, ensureOffscreen: async () => { called++; } };
};

test('isRestricted flags browser-internal pages', () => {
  assert.equal(mod.isRestricted('chrome://extensions'), true);
  assert.equal(mod.isRestricted(''), true);
  assert.equal(mod.isRestricted('https://example.com'), false);
});

test('readSelection speaks the selected text via the offscreen player', async () => {
  const sent = installReadAloudChrome({
    tab: { id: 1, url: 'https://example.com' },
    selection: 'hello world',
    storage: { settings: { ttsProvider: 'webspeech', ttsVoiceURI: 'v1' } }
  });
  const d = deps();
  const r = await mod.readSelection(d);
  assert.equal(r.ok, true);
  assert.equal(d.calls(), 1, 'offscreen ensured');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'LISTEN_START');
  assert.equal(sent[0].provider, 'webspeech');
  assert.deepEqual(sent[0].segments, [{ text: 'hello world', srcIdx: -1 }]);
});

test('readSelection is a no-op on restricted pages', async () => {
  const sent = installReadAloudChrome({ tab: { id: 1, url: 'chrome://settings' }, selection: 'x' });
  const r = await mod.readSelection(deps());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'restricted');
  assert.equal(sent.length, 0);
});

test('readSelection is a no-op when nothing is selected', async () => {
  const sent = installReadAloudChrome({ tab: { id: 1, url: 'https://e.com' }, selection: '   ' });
  const r = await mod.readSelection(deps());
  assert.equal(r.reason, 'no_selection');
  assert.equal(sent.length, 0);
});

test('readSelection reports inject_failed when scripting throws', async () => {
  const sent = installReadAloudChrome({ tab: { id: 1, url: 'https://e.com' }, executeThrows: true });
  const r = await mod.readSelection(deps());
  assert.equal(r.reason, 'inject_failed');
  assert.equal(sent.length, 0);
});

test('readPageAloud maps extracted paragraphs to segments', async () => {
  const sent = installReadAloudChrome({
    tab: { id: 2, url: 'https://blog.example.com/post' },
    extract: { ok: true, title: 'Post', siteName: 'blog', paragraphs: [
      { idx: 0, text: 'Para one.' }, { idx: 1, text: 'Para two.' }
    ] },
    storage: { settings: { ttsProvider: 'webspeech' } }
  });
  const r = await mod.readPageAloud(deps());
  assert.equal(r.ok, true);
  assert.equal(sent[0].title, 'Post');
  assert.deepEqual(sent[0].segments, [
    { text: 'Para one.', srcIdx: 0 },
    { text: 'Para two.', srcIdx: 1 }
  ]);
});

test('readPageAloud reports no_content when extraction is empty', async () => {
  const sent = installReadAloudChrome({
    tab: { id: 2, url: 'https://e.com' },
    extract: { ok: true, paragraphs: [] }
  });
  const r = await mod.readPageAloud(deps());
  assert.equal(r.reason, 'no_content');
  assert.equal(sent.length, 0);
});

test('resolveVoice falls back to webspeech when the provider needs a missing key', async () => {
  installReadAloudChrome({ storage: { settings: { ttsProvider: 'elevenlabs' } } });
  const v = await mod.resolveVoice({ ttsProvider: 'elevenlabs' });
  assert.equal(v.provider, 'webspeech', 'no ElevenLabs key → fall back');
});

test('resolveVoice keeps a usable configured provider', async () => {
  installReadAloudChrome({ storage: { apiKeys: { openaiKey: 'sk' }, settings: { ttsProvider: 'openai', openaiTtsVoice: 'nova', openaiTtsModel: 'tts-1' } } });
  const v = await mod.resolveVoice({ ttsProvider: 'openai' });
  assert.equal(v.provider, 'openai');
  assert.equal(v.options.apiKey, 'sk');
});
