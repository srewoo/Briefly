// Briefly — Listen player (offscreen document).
// Plays a queue of text segments via the chosen TTS provider with lookahead
// synthesis, a persistent IndexedDB audio cache, and a streaming queue so
// LLM modes can append segments while earlier ones already play.
// Lives in the offscreen doc so playback survives the side panel closing.
import { TTS, chunkText } from '../lib/providers.js';
import { cacheKey, cacheGet, cachePut } from '../lib/audio-cache.js';
import { encodeWav, episodeFormat } from '../lib/wav.js';

const LOOKAHEAD = 2;
// Per-request input caps: Deepgram /speak rejects >2000 chars; Groq PlayAI
// caps around 10k but long inputs degrade — keep requests modest so the
// lookahead pipeline hides latency.
const PROVIDER_MAX_CHARS = { openai: 3800, elevenlabs: 4500, groqtts: 2800, deepgramtts: 1800 };

const state = {
  status: 'idle',          // idle | loading | playing | paused | done | error
  segIndex: -1,
  srcIdx: -1,              // source paragraph index for highlight sync (-1 = none)
  totalSegs: 0,
  queueComplete: true,     // false while an LLM mode is still appending
  title: '',
  error: ''
};

let segments = [];          // [{ text, srcIdx }]
let cfg = null;             // { provider, options, rate, voiceSig }
let blobCache = new Map();  // segIdx -> Blob (in-memory, this session)
let synthInFlight = new Set();
let audio = null;           // single reused HTMLAudioElement
let session = 0;            // bumped on stop/start to cancel stale async work

function broadcast() {
  chrome.runtime.sendMessage({ type: 'LISTEN_STATE', ...state }).catch(() => {});
}

function setState(patch) {
  Object.assign(state, patch);
  broadcast();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── synthesis (memory cache → IndexedDB cache → provider) ─

async function synthesizeSegment(idx) {
  if (blobCache.has(idx)) return blobCache.get(idx);
  if (synthInFlight.has(idx)) {
    while (synthInFlight.has(idx)) await sleep(120);
    return blobCache.get(idx);
  }
  synthInFlight.add(idx);
  try {
    const text = segments[idx].text;
    const host = segments[idx].host || 'A';
    const opts = (cfg.hostVoices && cfg.hostVoices[host]) || cfg.options;
    const sig = (cfg.voiceSigs && cfg.voiceSigs[host]) || cfg.voiceSig;
    const key = await cacheKey([cfg.provider, sig, text]);
    let blob = await cacheGet(key);
    if (!blob) {
      const max = PROVIDER_MAX_CHARS[cfg.provider] || 0;
      const pieces = max && text.length > max ? chunkText(text, max) : [text];
      const blobs = [];
      for (const piece of pieces) {
        blobs.push(await TTS[cfg.provider].synthesize({ text: piece, ...opts }));
      }
      blob = blobs.length === 1 ? blobs[0] : new Blob(blobs, { type: blobs[0].type || 'audio/mpeg' });
      cachePut(key, blob); // fire-and-forget
    }
    blobCache.set(idx, blob);
    return blob;
  } finally {
    synthInFlight.delete(idx);
  }
}

function prefetch(fromIdx, mySession) {
  for (let i = fromIdx; i < Math.min(fromIdx + LOOKAHEAD, segments.length); i++) {
    synthesizeSegment(i).catch(() => {});
    if (mySession !== session) return;
  }
}

// ─── playback: blob providers ──────────────────────────────

function playBlob(blob, mySession) {
  return new Promise((resolve, reject) => {
    if (!audio) audio = new Audio();
    const url = URL.createObjectURL(blob);
    audio.src = url;
    audio.playbackRate = cfg.rate || 1;
    audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
    audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Audio playback failed.')); };
    audio.play().catch(reject);
    if (mySession !== session) { audio.pause(); resolve(); }
  });
}

// ─── playback: web speech ──────────────────────────────────

function speakWebSpeech(text, mySession, host = 'A') {
  return new Promise((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = cfg.rate || 1;
    const voices = speechSynthesis.getVoices();
    let v = voices.find(v => v.voiceURI === cfg.options.voiceURI) || null;
    if (host === 'B') {
      // Host B: a stable, different voice in the same language family.
      const lang = (v?.lang || 'en').slice(0, 2);
      v = voices.find(o => o.lang.startsWith(lang) && o.voiceURI !== (v?.voiceURI || '')) || v;
    }
    if (v) u.voice = v;
    u.onend = () => resolve();
    u.onerror = (e) => (e.error === 'interrupted' || e.error === 'canceled')
      ? resolve()
      : reject(new Error(`Speech error: ${e.error}`));
    if (mySession !== session) return resolve();
    speechSynthesis.speak(u);
  });
}

// ─── main loop ─────────────────────────────────────────────

async function runQueue(startIdx) {
  const mySession = ++session;
  setState({ status: 'loading', segIndex: startIdx, totalSegs: segments.length, error: '' });
  const isWebSpeech = cfg.provider === 'webspeech';
  let consecutiveFailures = 0;

  for (let i = startIdx; ; i++) {
    if (mySession !== session) return;
    // Streaming: queue may still be growing while we play.
    while (i >= segments.length && !state.queueComplete) {
      if (mySession !== session) return;
      setState({ status: 'loading', totalSegs: segments.length });
      await sleep(300);
    }
    if (i >= segments.length) break;

    setState({
      segIndex: i,
      srcIdx: segments[i].srcIdx ?? -1,
      totalSegs: segments.length,
      status: state.status === 'paused' ? 'paused' : 'playing'
    });
    try {
      if (isWebSpeech) {
        await speakWebSpeech(segments[i].text, mySession, segments[i].host || 'A');
      } else {
        prefetch(i + 1, mySession);
        const blob = await synthesizeSegment(i);
        if (mySession !== session) return;
        await playBlob(blob, mySession);
      }
      consecutiveFailures = 0;
    } catch (e) {
      if (mySession !== session) return;
      // Skip a bad segment instead of killing the whole session; only give
      // up when the provider is clearly down (3 failures in a row).
      if (++consecutiveFailures >= 3) {
        setState({ status: 'error', error: String(e.message || e) });
        return;
      }
    }
  }
  if (mySession === session) setState({ status: 'done', segIndex: -1, srcIdx: -1 });
}

// ─── controls ──────────────────────────────────────────────

function pause() {
  if (state.status !== 'playing') return;
  if (cfg.provider === 'webspeech') speechSynthesis.pause();
  else if (audio) audio.pause();
  setState({ status: 'paused' });
}

function resume() {
  if (state.status !== 'paused') return;
  if (cfg.provider === 'webspeech') speechSynthesis.resume();
  else if (audio) audio.play().catch(() => {});
  setState({ status: 'playing' });
}

function stop() {
  session++;
  if (cfg && cfg.provider === 'webspeech') speechSynthesis.cancel();
  if (audio) { audio.pause(); audio.src = ''; }
  setState({ status: 'idle', segIndex: -1, srcIdx: -1, queueComplete: true, error: '' });
}

function seek(delta) {
  const next = Math.max(0, Math.min(segments.length - 1, state.segIndex + delta));
  if (next === state.segIndex) return;
  if (cfg.provider === 'webspeech') speechSynthesis.cancel();
  if (audio) { audio.pause(); audio.src = ''; }
  runQueue(next);
}

function setRate(rate) {
  cfg.rate = rate;
  if (audio) audio.playbackRate = rate;
  // Web Speech rate applies from the next utterance.
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type || !msg.type.startsWith('LISTEN_')) return false;
  switch (msg.type) {
    case 'LISTEN_START':
      stop();
      segments = msg.segments || [];
      cfg = {
        provider: msg.provider,
        options: msg.options || {},
        rate: msg.rate || 1,
        voiceSig: msg.voiceSig || '',
        hostVoices: msg.hostVoices || null,
        voiceSigs: msg.voiceSigs || null
      };
      state.canExport = msg.provider !== 'webspeech';
      blobCache = new Map();
      state.title = msg.title || '';
      state.queueComplete = !msg.streaming;
      if (!segments.length && state.queueComplete) {
        setState({ status: 'error', error: 'Nothing to read.' });
      } else {
        runQueue(0);
      }
      sendResponse({ ok: true });
      break;
    case 'LISTEN_APPEND':
      // Ignore stale appends after a stop/error.
      if (['idle', 'error', 'done'].includes(state.status)) { sendResponse({ ok: false }); break; }
      segments.push(...(msg.segments || []));
      setState({ totalSegs: segments.length });
      sendResponse({ ok: true });
      break;
    case 'LISTEN_COMPLETE':
      state.queueComplete = true;
      broadcast();
      sendResponse({ ok: true });
      break;
    case 'LISTEN_PAUSE': pause(); sendResponse({ ok: true }); break;
    case 'LISTEN_RESUME': resume(); sendResponse({ ok: true }); break;
    case 'LISTEN_STOP': stop(); sendResponse({ ok: true }); break;
    case 'LISTEN_SEEK': seek(msg.delta || 0); sendResponse({ ok: true }); break;
    case 'LISTEN_RATE': setRate(msg.rate || 1); sendResponse({ ok: true }); break;
    case 'LISTEN_GET_STATE': sendResponse({ ...state }); break;
    case 'LISTEN_EXPORT':
      exportAudio(msg.filename || 'briefly-episode.mp3')
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true; // async response
    default: return false;
  }
  return false;
});

// ─── export ────────────────────────────────────────────────

// Build ONE valid audio file from per-segment blobs. Frame-concatenating is
// only valid for MP3 streams; providers that return WAV (or a mix) would yield
// a file where only the first segment plays. For those we decode every segment
// and re-encode a single WAV. Returns { blob, ext }.
async function buildEpisode(blobs) {
  if (episodeFormat(blobs.map(b => b.type)) === 'mp3') {
    return { blob: new Blob(blobs, { type: 'audio/mpeg' }), ext: 'mp3' };
  }
  // Non-MP3 or mixed containers → decode + concatenate PCM → one WAV.
  const actx = new AudioContext();
  try {
    const buffers = [];
    for (const b of blobs) {
      buffers.push(await actx.decodeAudioData(await b.arrayBuffer()));
    }
    const sampleRate = buffers[0]?.sampleRate || 44100;
    const total = buffers.reduce((n, buf) => n + buf.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const buf of buffers) {
      const ch0 = buf.getChannelData(0);
      if (buf.numberOfChannels > 1) {
        const ch1 = buf.getChannelData(1);
        for (let i = 0; i < buf.length; i++) merged[offset + i] = (ch0[i] + ch1[i]) / 2;
      } else {
        merged.set(ch0, offset);
      }
      offset += buf.length;
    }
    return { blob: new Blob([encodeWav(merged, sampleRate)], { type: 'audio/wav' }), ext: 'wav' };
  } finally {
    actx.close().catch(() => {});
  }
}

// Synthesize any missing segments, build a single valid file, and hand a data
// URL to the service worker for chrome.downloads.
async function exportAudio(filename) {
  if (!cfg || cfg.provider === 'webspeech') {
    throw new Error('Web Speech has no audio data to export — use OpenAI or ElevenLabs.');
  }
  if (!segments.length) throw new Error('Nothing to export.');
  const blobs = [];
  for (let i = 0; i < segments.length; i++) {
    blobs.push(await synthesizeSegment(i));
  }
  const { blob, ext } = await buildEpisode(blobs);
  const outName = filename.replace(/\.(mp3|wav|ogg)$/i, '') + '.' + ext;
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(r.result);
    r.onerror = () => reject(new Error('Failed to encode audio.'));
    r.readAsDataURL(blob);
  });
  const res = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_AUDIO', dataUrl, filename: outName });
  if (!res || !res.ok) throw new Error(res?.error || 'Download failed.');
  return { ok: true };
}
