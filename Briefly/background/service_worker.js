// Briefly v2 — minimal service worker
// Opens the side panel on toolbar click and manages the offscreen mic document.

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const PANEL_PATH = 'sidepanel/sidepanel.html';

// Per-tab side panel: disabled globally, enabled only on the tab where the
// user opens it — so it doesn't appear on every tab of the window.
chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});

async function openPanelForTab(tabId) {
  await chrome.sidePanel.setOptions({ tabId, path: PANEL_PATH, enabled: true });
  await chrome.sidePanel.open({ tabId });
}

chrome.action.onClicked.addListener((tab) => {
  if (tab?.id != null) openPanelForTab(tab.id).catch(() => {});
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

// Push-to-talk: open the panel if needed, then tell the side panel to toggle.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'push-to-talk') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) await openPanelForTab(tab.id);
  } catch (_) {}
  // Side panel script listens for this; if the panel isn't open yet,
  // the message is dropped harmlessly and the user can press again.
  chrome.runtime.sendMessage({ type: 'TOGGLE_RECORD' }).catch(() => {});
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
