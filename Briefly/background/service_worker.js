// Briefly v2 — minimal service worker
// Opens the side panel on toolbar click and manages the offscreen mic document.

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

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
    reasons: ['USER_MEDIA'],
    justification: 'Microphone capture for speech-to-text.'
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

// Push-to-talk: open the panel if needed, then tell the side panel to toggle.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'push-to-talk') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (_) {}
  // Side panel script listens for this; if the panel isn't open yet,
  // the message is dropped harmlessly and the user can press again.
  chrome.runtime.sendMessage({ type: 'TOGGLE_RECORD' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.type !== 'ENSURE_OFFSCREEN' && msg.type !== 'CLOSE_OFFSCREEN')) {
    // Don't claim messages we don't handle — let the offscreen doc respond.
    return false;
  }
  (async () => {
    try {
      if (msg.type === 'ENSURE_OFFSCREEN') await ensureOffscreen();
      else if (msg.type === 'CLOSE_OFFSCREEN') await closeOffscreen();
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});
