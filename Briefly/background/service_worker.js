// Briefly — service worker
// Opens the side panel on toolbar click, manages the offscreen document, and
// powers the keyboard shortcuts that read text aloud WITHOUT opening any UI.
import { readSelection, readPageAloud, isRestricted } from '../lib/read-aloud.js';
import { Storage } from '../lib/storage.js';
import { webSpeechLang } from '../lib/lang.js';
import { parseVocab, applyVocab } from '../lib/vocab.js';
import { cleanupTranscript } from '../lib/llm.js';

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const PANEL_PATH = 'sidepanel/sidepanel.html';

// Per-tab side panel: disabled globally, enabled only on the tab where the
// user opens it — so it doesn't appear on every tab of the window.
chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});

// `sidePanel.open()` may only be called while the user gesture is still
// active. Awaiting anything first (even setOptions) drops the gesture and the
// call rejects, so both calls are issued in the same synchronous turn — the
// browser applies them in order, so open() sees the panel already enabled.
function openPanelForTab(tabId) {
  const configured = chrome.sidePanel
    .setOptions({ tabId, path: PANEL_PATH, enabled: true });
  const opened = chrome.sidePanel.open({ tabId });
  return Promise.all([configured, opened]);
}

chrome.action.onClicked.addListener((tab) => {
  if (tab?.id == null) return;
  openPanelForTab(tab.id).catch((e) => {
    console.error('Briefly: failed to open side panel', e);
  });
});

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Microphone capture for speech-to-text and audio playback for Read Page.'
  });
}

async function closeOffscreen() {
  if (!(await hasOffscreen())) return;
  // Never tear down the offscreen doc while the Listen player is active —
  // playback must survive the side panel closing.
  try {
    const state = await chrome.runtime.sendMessage({ type: 'LISTEN_GET_STATE' });
    if (state && ['loading', 'playing', 'paused'].includes(state.status)) return;
  } catch (_) {}
  await chrome.offscreen.closeDocument().catch(() => {});
}

// ─── Headless "read aloud" (keyboard shortcuts, no window required) ─────
// A keyboard command grants activeTab, so we can read the page/selection and
// drive the offscreen player directly — nothing is shown to the user. The
// logic lives in lib/read-aloud.js (unit-tested); we inject ensureOffscreen.

async function stopPlayback() {
  await chrome.runtime.sendMessage({ type: 'LISTEN_STOP' }).catch(() => {});
  await closeOffscreen();
}

// ─── Headless dictation (speech → cursor + clipboard) ───────────────────
// The Dictate shortcut shows a recording pill on the page and runs Web Speech
// recognition IN THE PAGE (content script) — the Web Speech API doesn't work in
// the extension's offscreen document. On the second press the content script
// asks us for an AI cleanup pass, then inserts + copies. State lives in
// storage.session so it survives the worker being torn down between presses.

function toTab(tabId, msg) {
  if (tabId != null) chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

async function startDictation() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || isRestricted(tab.url)) return;   // can't overlay/record here
  const settings = await Storage.getSettings();
  const lang = webSpeechLang(settings.sttLang, self.navigator?.language);
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/pill.js'] });
  } catch (_) { return; }   // no host access (e.g. restricted page)
  toTab(tab.id, { type: 'DICTATE_START', lang });
  await chrome.storage.session.set({ dictate: { tabId: tab.id } });
}

async function stopDictation(tabId) {
  await chrome.storage.session.remove('dictate');
  toTab(tabId, { type: 'DICTATE_STOP' });   // content script transcribes, cleans, inserts
}

async function toggleDictation() {
  const { dictate } = await chrome.storage.session.get('dictate');
  if (dictate) await stopDictation(dictate.tabId);
  else await startDictation();
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'push-to-talk') return toggleDictation().catch(() => {});
  if (command === 'read-selection') return readSelection({ ensureOffscreen }).catch(() => {});
  if (command === 'read-page') return readPageAloud({ ensureOffscreen }).catch(() => {});
  if (command === 'stop-playback') return stopPlayback();
});

// AI cleanup + vocabulary pass requested by the content script on dictation stop.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'DICTATE_CLEANUP') return false;
  (async () => {
    let text = (msg.text || '').trim();
    if (text) {
      const settings = await Storage.getSettings();
      const keys = await Storage.getKeys();
      const vocab = parseVocab(settings.dictateVocabulary);
      if (settings.dictateAiCleanup && (keys.groqKey || keys.openaiKey)) {
        try { text = (await cleanupTranscript({ text, keys, vocabulary: vocab })).trim() || text; }
        catch (_) { text = applyVocab(text, vocab); }
      } else {
        text = applyVocab(text, vocab);
      }
    }
    sendResponse({ text });
  })();
  return true;   // async response
});

const HANDLED = ['ENSURE_OFFSCREEN', 'CLOSE_OFFSCREEN', 'DOWNLOAD_AUDIO'];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !HANDLED.includes(msg.type)) {
    // Don't claim messages we don't handle — let the offscreen doc respond.
    return false;
  }
  (async () => {
    try {
      if (msg.type === 'ENSURE_OFFSCREEN') await ensureOffscreen();
      else if (msg.type === 'CLOSE_OFFSCREEN') await closeOffscreen();
      else if (msg.type === 'DOWNLOAD_AUDIO') {
        await chrome.downloads.download({
          url: msg.dataUrl,
          filename: msg.filename || 'briefly-episode.mp3',
          saveAs: true
        });
      }
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});
