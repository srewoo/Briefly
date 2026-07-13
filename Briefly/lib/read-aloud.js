// Headless "read aloud" used by the keyboard shortcuts. Kept out of the
// service worker so it can be unit-tested against a mocked chrome.* — the
// browser-only bits (offscreen creation) are injected as `deps.ensureOffscreen`.
import { Storage } from './storage.js';
import { buildOptions } from './tts-options.js';

// Pages we must not (and cannot) script/read.
export function isRestricted(url) {
  return !url || /^(chrome|edge|about|chrome-extension|devtools):/.test(url);
}

// Resolve the TTS voice for headless playback: the user's Text→Speech provider,
// falling back to free Web Speech if that provider needs a key we don't have.
export async function resolveVoice(settings) {
  const wanted = settings.ttsProvider || 'webspeech';
  try {
    return { provider: wanted, ...(await buildOptions(wanted)) };
  } catch (_) {
    return { provider: 'webspeech', ...(await buildOptions('webspeech')) };
  }
}

export async function speakHeadless(segments, title, deps = {}) {
  if (!segments || !segments.length) return { ok: false, reason: 'empty' };
  const settings = await Storage.getSettings();
  const { provider, options, voiceSig } = await resolveVoice(settings);
  if (deps.ensureOffscreen) await deps.ensureOffscreen();
  await chrome.runtime.sendMessage({
    type: 'LISTEN_START',
    title: title || 'Briefly',
    provider,
    options,
    voiceSig,
    rate: 1,
    segments
  });
  return { ok: true, provider };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

export async function readSelection(deps = {}) {
  const tab = await activeTab();
  if (!tab?.id || isRestricted(tab.url)) return { ok: false, reason: 'restricted' };
  let text = '';
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ((window.getSelection && window.getSelection().toString()) || '').trim()
    });
    text = res?.result || '';
  } catch (_) {
    return { ok: false, reason: 'inject_failed' };
  }
  if (!text) return { ok: false, reason: 'no_selection' };
  return speakHeadless([{ text, srcIdx: -1 }], 'Selection', deps);
}

export async function readPageAloud(deps = {}) {
  const tab = await activeTab();
  if (!tab?.id || isRestricted(tab.url)) return { ok: false, reason: 'restricted' };
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/reader.js'] });
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'BRIEFLY_EXTRACT' });
    if (!res?.ok || !res.paragraphs?.length) return { ok: false, reason: 'no_content' };
    const segments = res.paragraphs.map(p => ({ text: p.text, srcIdx: p.idx }));
    return speakHeadless(segments, res.title || res.siteName, deps);
  } catch (_) {
    return { ok: false, reason: 'extract_failed' };
  }
}
