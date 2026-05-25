import { Storage } from '../lib/storage.js';
import { STT, TTS, OPENAI_TTS_VOICES, TRANSLATE_LANGS, translateText } from '../lib/providers.js';

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

// ─── Toast ───────────────────────────────────────────────
function toast(text, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  $('#toastContainer').appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

// ─── Tabs ────────────────────────────────────────────────
$$('.tab').forEach(t => {
  t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.toggle('active', x === t));
    const id = t.dataset.tab;
    $$('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === id));
  });
});

// ─── Theme toggle ────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const isLight = theme === 'light';
  const icon = $('#themeIcon'); const label = $('#themeLabel');
  if (icon)  icon.textContent  = isLight ? '☀' : '🌙';
  if (label) label.textContent = isLight ? 'Light' : 'Dark';
}
$('#themeToggle').addEventListener('click', async () => {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  await Storage.setSettings({ theme: next });
});

// ─── Onboarding banner ──────────────────────────────────
async function maybeShowOnboarding() {
  const { hasOnboarded } = await chrome.storage.local.get('hasOnboarded');
  if (!hasOnboarded) $('#onboardBanner').hidden = false;
}
$('#onboardDismiss').addEventListener('click', async () => {
  $('#onboardBanner').hidden = true;
  await chrome.storage.local.set({ hasOnboarded: true });
});
$('#onboardSettings').addEventListener('click', () => {
  $('#settingsModal').hidden = false;
});

// ─── Footer / settings links ────────────────────────────
function openExtPage(path) {
  chrome.tabs.create({ url: chrome.runtime.getURL(path) });
}
$('#privacyLink').addEventListener('click', e => { e.preventDefault(); openExtPage('privacy.html'); });
$('#privacyFooterLink').addEventListener('click', e => { e.preventDefault(); openExtPage('privacy.html'); });
$('#helpFooterLink').addEventListener('click', e => { e.preventDefault(); openExtPage('help.html'); });

// ─── Push-to-talk from keyboard shortcut ─────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'TOGGLE_RECORD') {
    // Ensure STT tab is active so the user sees what's happening
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'stt'));
    $$('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === 'stt'));
    if (recording) stopRecording(); else startRecording();
  }
});

// ─── Settings + History modals ───────────────────────────
$('#settingsBtn').addEventListener('click', () => $('#settingsModal').hidden = false);
$('#closeSettings').addEventListener('click', () => $('#settingsModal').hidden = true);
$('#settingsModal').addEventListener('click', e => {
  if (e.target.id === 'settingsModal') $('#settingsModal').hidden = true;
});

$('#historyBtn').addEventListener('click', async () => {
  await renderHistory();
  $('#historyDrawer').hidden = false;
});
$('#closeHistory').addEventListener('click', () => $('#historyDrawer').hidden = true);

// ─── Translate target language (settings + button label) ────────
function populateTranslateLangs(selectedCode) {
  const sel = $('#translateTargetLang');
  if (!sel) return;
  sel.innerHTML = '';
  TRANSLATE_LANGS.forEach(l => {
    const o = document.createElement('option');
    o.value = l.code; o.textContent = l.label;
    sel.appendChild(o);
  });
  if (selectedCode) sel.value = selectedCode;
}
function updateTranslateButtonLabel(code) {
  const btn = $('#translateBtn'); if (!btn) return;
  const upper = (code || 'en').toUpperCase();
  const label = (TRANSLATE_LANGS.find(l => l.code === code) || {}).label || upper;
  btn.textContent = `🌐 Translate → ${upper}`;
  btn.title = `Translate the last recording to ${label}`;
}

function setMsg(sel, text, kind = 'muted') {
  const el = $(sel);
  el.textContent = text;
  el.className = `status small ${kind}`;
}

// ─── Settings load/save ──────────────────────────────────
async function loadSettings() {
  const s = await Storage.getSettings();
  const k = await Storage.getKeys();
  $('#sttProvider').value = s.sttProvider;
  $('#sttLang').value = s.sttLang;
  $('#silenceTimeout').value = String(s.silenceTimeoutMs);
  $('#ttsProvider').value = s.ttsProvider;
  $('#elevenModel').value = s.elevenModelId;
  $('#openaiTtsModel').value = s.openaiTtsModel;
  if ($('#streamElementsVoice')) $('#streamElementsVoice').value = s.streamElementsVoice;
  if ($('#gtranslateLang')) $('#gtranslateLang').value = s.gtranslateLang;
  applyTheme(s.theme || 'dark');
  $('#ttsRate').value = s.ttsRate;       $('#ttsRateVal').textContent = s.ttsRate;
  $('#ttsPitch').value = s.ttsPitch;     $('#ttsPitchVal').textContent = s.ttsPitch;
  $('#ttsVolume').value = s.ttsVolume;   $('#ttsVolumeVal').textContent = s.ttsVolume;
  $('#elevenStability').value = s.elevenStability;   $('#elevenStabilityVal').textContent = (+s.elevenStability).toFixed(2);
  $('#elevenSimilarity').value = s.elevenSimilarity; $('#elevenSimilarityVal').textContent = (+s.elevenSimilarity).toFixed(2);
  $('#autoCopyTranscript').checked = !!s.autoCopyTranscript;
  for (const f of ['assemblyaiKey', 'elevenlabsKey', 'openaiKey', 'groqKey', 'deepgramKey']) {
    $(`#${f}`).value = k[f];
  }
  populateOpenAIVoices(s.openaiTtsVoice);
  populateTranslateLangs(s.translateTargetLang);
  updateTranslateButtonLabel(s.translateTargetLang);
  updateSttVisibility();
  updateTtsVisibility();
  updateCharCount();
}

$('#saveSettings').addEventListener('click', async () => {
  await Storage.setKeys({
    assemblyaiKey: $('#assemblyaiKey').value.trim(),
    elevenlabsKey: $('#elevenlabsKey').value.trim(),
    openaiKey: $('#openaiKey').value.trim(),
    groqKey: $('#groqKey').value.trim(),
    deepgramKey: $('#deepgramKey').value.trim()
  });
  await Storage.setSettings({
    autoCopyTranscript: $('#autoCopyTranscript').checked,
    translateTargetLang: $('#translateTargetLang').value
  });
  updateTranslateButtonLabel($('#translateTargetLang').value);
  toast('Settings saved.', 'ok');
  setTimeout(() => $('#settingsModal').hidden = true, 400);
});

$('#resetSettings').addEventListener('click', async () => {
  if (!confirm('Reset all settings, API keys, and history?')) return;
  await Storage.resetAll();
  toast('All settings cleared.', 'ok');
  setTimeout(() => location.reload(), 400);
});

// Test-key buttons
$$('[data-test]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const which = btn.dataset.test;
    const keyInput = $(`#${which}Key`);
    const key = keyInput.value.trim();
    if (!key) { toast('Enter a key first.', 'error'); return; }
    btn.disabled = true; btn.textContent = '…';
    try {
      const provider = STT[which] || TTS[which];
      if (!provider || !provider.testKey) {
        toast('No test endpoint for this provider.', 'error');
      } else {
        const r = await provider.testKey({ apiKey: key });
        toast(r.ok ? `${which}: key OK ✓` : `${which}: failed (${r.status})`, r.ok ? 'ok' : 'error');
      }
    } catch (e) {
      toast(`${which}: ${e.message}`, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Test';
    }
  });
});

// ─── Provider visibility ─────────────────────────────────
function updateSttVisibility() {
  const provider = $('#sttProvider').value;
  $('#sttLangField').style.display = provider === 'webspeech' ? '' : 'none';
  $('#silenceField').style.display = provider === 'webspeech' ? 'none' : '';
  const canStream = provider === 'deepgram' || provider === 'assemblyai';
  $('#liveStreamField').hidden = !canStream;
  if (canStream) {
    $('#liveStreamLabel').textContent =
      provider === 'deepgram'
        ? 'Live streaming (Deepgram) — see words as you speak'
        : 'Live streaming (AssemblyAI Universal v3) — see words as you speak';
  }
}
function updateTtsVisibility() {
  const provider = $('#ttsProvider').value;
  $$('[data-show-for]').forEach(el => {
    el.classList.toggle('visible', el.dataset.showFor === provider);
  });
}

$('#sttProvider').addEventListener('change', async e => {
  await Storage.setSettings({ sttProvider: e.target.value });
  updateSttVisibility();
});
$('#sttLang').addEventListener('change', e => Storage.setSettings({ sttLang: e.target.value }));
$('#silenceTimeout').addEventListener('change', e => Storage.setSettings({ silenceTimeoutMs: Number(e.target.value) }));
$('#ttsProvider').addEventListener('change', async e => {
  await Storage.setSettings({ ttsProvider: e.target.value });
  updateTtsVisibility();
  if (e.target.value === 'elevenlabs') loadElevenVoices();
});

// ─── Web Speech voices ───────────────────────────────────
function populateWebSpeechVoices() {
  const voices = speechSynthesis.getVoices();
  const sel = $('#webspeechVoice');
  sel.innerHTML = '';
  voices.forEach(v => {
    const o = document.createElement('option');
    o.value = v.voiceURI;
    o.textContent = `${v.name} (${v.lang})${v.default ? ' — default' : ''}`;
    sel.appendChild(o);
  });
  Storage.getSettings().then(s => { if (s.ttsVoiceURI) sel.value = s.ttsVoiceURI; });
}
speechSynthesis.onvoiceschanged = populateWebSpeechVoices;
populateWebSpeechVoices();
$('#webspeechVoice').addEventListener('change', e => Storage.setSettings({ ttsVoiceURI: e.target.value }));

// Sliders
for (const [id, key, fmt] of [
  ['ttsRate', 'ttsRate', v => v],
  ['ttsPitch', 'ttsPitch', v => v],
  ['ttsVolume', 'ttsVolume', v => v],
  ['elevenStability', 'elevenStability', v => (+v).toFixed(2)],
  ['elevenSimilarity', 'elevenSimilarity', v => (+v).toFixed(2)]
]) {
  $(`#${id}`).addEventListener('input', e => {
    $(`#${id}Val`).textContent = fmt(e.target.value);
    Storage.setSettings({ [key]: Number(e.target.value) });
  });
}

// OpenAI voices
function populateOpenAIVoices(selected) {
  const sel = $('#openaiVoice');
  sel.innerHTML = '';
  OPENAI_TTS_VOICES.forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  });
  if (selected) sel.value = selected;
}
$('#openaiVoice').addEventListener('change', e => Storage.setSettings({ openaiTtsVoice: e.target.value }));
$('#openaiTtsModel').addEventListener('change', e => Storage.setSettings({ openaiTtsModel: e.target.value }));
$('#elevenModel').addEventListener('change', e => Storage.setSettings({ elevenModelId: e.target.value }));
$('#streamElementsVoice').addEventListener('change', e => Storage.setSettings({ streamElementsVoice: e.target.value }));
$('#translateTargetLang').addEventListener('change', async e => {
  await Storage.setSettings({ translateTargetLang: e.target.value });
  updateTranslateButtonLabel(e.target.value);
});
$('#gtranslateLang').addEventListener('change', e => Storage.setSettings({ gtranslateLang: e.target.value }));

// ElevenLabs voices
async function loadElevenVoices() {
  const sel = $('#elevenVoice');
  sel.innerHTML = '';
  const { elevenlabsKey } = await Storage.getKeys();
  if (!elevenlabsKey) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '— Add ElevenLabs key in settings —';
    sel.appendChild(o);
    return;
  }
  try {
    const voices = await TTS.elevenlabs.listVoices({ apiKey: elevenlabsKey });
    voices.forEach(v => {
      const o = document.createElement('option');
      o.value = v.id; o.textContent = v.name;
      sel.appendChild(o);
    });
    const { elevenVoiceId } = await Storage.getSettings();
    if (elevenVoiceId && voices.some(v => v.id === elevenVoiceId)) sel.value = elevenVoiceId;
  } catch (e) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = `Error: ${e.message}`;
    sel.appendChild(o);
  }
}
$('#refreshElevenVoices').addEventListener('click', loadElevenVoices);
$('#elevenVoice').addEventListener('change', e => Storage.setSettings({ elevenVoiceId: e.target.value }));

// Char counter
function updateCharCount() {
  $('#ttsCharCount').textContent = `${$('#ttsText').value.length} chars`;
}
$('#ttsText').addEventListener('input', updateCharCount);

// ─── Waveform canvas ─────────────────────────────────────
const canvas = $('#waveform');
const ctx = canvas.getContext('2d');
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas);
setTimeout(resizeCanvas, 0);

function themeColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawIdle() {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = themeColor('--border') || '#2a3140';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
}
drawIdle();

// Smooth previous frame towards the new sample so bars animate fluidly
let smoothedBars = null;
function drawBars(bars) {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  if (!smoothedBars || smoothedBars.length !== bars.length) {
    smoothedBars = new Float32Array(bars.length);
  }
  const accent = themeColor('--accent') || '#4f7cff';
  const accentSoft = themeColor('--accent-hover') || accent;
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, accentSoft);
  grad.addColorStop(1, accent);
  ctx.fillStyle = grad;
  const barW = W / bars.length;
  const minH = 2;
  for (let i = 0; i < bars.length; i++) {
    smoothedBars[i] = smoothedBars[i] * 0.55 + bars[i] * 0.45;
    const h = Math.max(minH, (smoothedBars[i] / 255) * H * 0.95);
    const x = i * barW + 1;
    const y = (H - h) / 2;
    const w = barW - 2;
    const r = Math.min(w / 2, 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,       x + w, y + h, r);
    ctx.arcTo(x + w, y + h,   x,     y + h, r);
    ctx.arcTo(x,     y + h,   x,     y,     r);
    ctx.arcTo(x,     y,       x + w, y,     r);
    ctx.closePath();
    ctx.fill();
  }
}

// ─── Mic permission warm-up ──────────────────────────────
async function ensureMicPermission() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e.name === 'NotAllowedError' ? 'mic_denied' : 'mic_error',
      message: e.message
    };
  }
}

// ─── STT: state ──────────────────────────────────────────
let recognizer = null;
let recording = false;
let lastRecordedBlob = null;
let lastRecordedMime = '';

async function ensureOffscreen() {
  return chrome.runtime.sendMessage({ type: 'ENSURE_OFFSCREEN' });
}

function setRecording(on) {
  recording = on;
  const btn = $('#recordBtn');
  btn.classList.toggle('recording', on);
  btn.textContent = on ? '⏹ Stop recording' : '🎙 Start recording';
  if (!on) { smoothedBars = null; drawIdle(); }
}

// Live streaming state
let liveStreaming = false;
let liveBaseline = '';
let liveFinalBuf = '';

// Listen for offscreen events (waveform + silence + live transcripts)
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'WAVEFORM_DATA' && recording) drawBars(msg.bars);
  else if (msg.type === 'SILENCE_DETECTED' && recording) {
    setMsg('#sttStatus', 'Silence detected — stopping…');
    stopRecording();
  } else if (msg.type === 'STREAM_OPEN') {
    setMsg('#sttStatus', 'Live · listening…', 'ok');
  } else if (msg.type === 'STREAM_TRANSCRIPT') {
    if (!liveStreaming) return;
    if (msg.isFinal && msg.text) liveFinalBuf += (liveFinalBuf ? ' ' : '') + msg.text;
    const sep = liveBaseline && !liveBaseline.endsWith('\n') ? '\n' : '';
    $('#transcript').value = liveBaseline + sep + liveFinalBuf + (msg.isFinal ? '' : ` ${msg.text}`);
  } else if (msg.type === 'STREAM_ERROR') {
    setMsg('#sttStatus', msg.message || 'Stream error.', 'error');
  } else if (msg.type === 'STREAM_CLOSED' && liveStreaming) {
    // Will be handled by stopRecording; ignore if user-initiated
  } else if (msg.type === 'STREAM_AUDIO_BLOB') {
    // The offscreen doc captured a backup blob while live-streaming —
    // store it so Translate and Download Recording work after live mode.
    (async () => {
      try {
        lastRecordedBlob = await (await fetch(msg.dataUrl)).blob();
        lastRecordedMime = msg.mimeType;
        $('#downloadAudio').disabled = false;
      } catch (_) {}
    })();
  }
});

$('#recordBtn').addEventListener('click', () => {
  if (recording) stopRecording(); else startRecording();
});

async function startRecording() {
  const provider = $('#sttProvider').value;
  setMsg('#sttStatus', 'Requesting microphone…');
  setRecording(true);

  if (provider === 'webspeech') {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setMsg('#sttStatus', 'Web Speech API not available in this browser.', 'error');
      setRecording(false); return;
    }
    const perm = await ensureMicPermission();
    if (!perm.ok) {
      setMsg('#sttStatus',
        perm.error === 'mic_denied'
          ? 'Microphone permission denied. Allow Chrome mic access in macOS System Settings → Privacy & Security → Microphone.'
          : `Mic error: ${perm.message}`, 'error');
      setRecording(false); return;
    }
    setMsg('#sttStatus', 'Listening…');
    recognizer = new SR();
    recognizer.lang = $('#sttLang').value;
    recognizer.continuous = true;
    recognizer.interimResults = true;
    const baseline = $('#transcript').value;
    let finalBuf = '';
    let hadError = false;
    recognizer.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalBuf += r[0].transcript;
        else interim += r[0].transcript;
      }
      const sep = baseline && !baseline.endsWith('\n') ? '\n' : '';
      $('#transcript').value = baseline + sep + finalBuf + interim;
    };
    recognizer.onerror = e => {
      let msg = `Error: ${e.error}`;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed')
        msg = 'Microphone blocked. Check macOS System Settings → Privacy & Security → Microphone → enable Chrome, then reload.';
      else if (e.error === 'no-speech') msg = 'No speech detected — try again.';
      else if (e.error === 'network') msg = 'Network error (Web Speech needs internet).';
      hadError = true;
      setMsg('#sttStatus', msg, 'error');
      setRecording(false);
    };
    recognizer.onend = () => {
      if (recording && !hadError) {
        try { recognizer.start(); } catch (_) {}
      } else if (!hadError) {
        finishWebSpeech(baseline + (baseline && !baseline.endsWith('\n') ? '\n' : '') + finalBuf);
      }
    };
    try { recognizer.start(); } catch (e) {
      setMsg('#sttStatus', `Error: ${e.message}`, 'error');
      setRecording(false);
    }
    return;
  }

  // Live streaming branch — Deepgram or AssemblyAI with toggle on
  const canStream = provider === 'deepgram' || provider === 'assemblyai';
  if (canStream && $('#liveStream').checked) {
    const keys = await Storage.getKeys();
    const apiKey = provider === 'deepgram' ? keys.deepgramKey : keys.assemblyaiKey;
    if (!apiKey) {
      setMsg('#sttStatus', `Add a ${provider === 'deepgram' ? 'Deepgram' : 'AssemblyAI'} API key in Settings.`, 'error');
      setRecording(false);
      return;
    }
    // Warm up mic permission from the side panel — offscreen documents
    // cannot surface a permission prompt, so we must grant here first.
    const perm = await ensureMicPermission();
    if (!perm.ok) {
      setMsg('#sttStatus',
        perm.error === 'mic_denied'
          ? 'Microphone permission denied. Click the camera/mic icon in the address bar (or macOS System Settings → Privacy & Security → Microphone → enable Chrome) and try again.'
          : `Mic error: ${perm.message}`, 'error');
      setRecording(false);
      return;
    }
    const settings = await Storage.getSettings();
    await ensureOffscreen();
    liveStreaming = true;
    liveBaseline = $('#transcript').value;
    liveFinalBuf = '';
    const startMsg = provider === 'deepgram'
      ? { type: 'STREAM_START_DEEPGRAM', config: { apiKey, model: settings.deepgramModel, silenceTimeoutMs: settings.silenceTimeoutMs } }
      : { type: 'STREAM_START_ASSEMBLYAI', config: { apiKey, silenceTimeoutMs: settings.silenceTimeoutMs } };
    const res = await chrome.runtime.sendMessage(startMsg);
    if (!res || !res.ok) {
      liveStreaming = false;
      const reason = res?.error === 'mic_denied'
        ? 'Microphone permission denied.'
        : (res?.message || 'Failed to open stream.');
      setMsg('#sttStatus', reason, 'error');
      setRecording(false);
    }
    return;
  }

  // Cloud providers — batch mode.
  // Warm up mic permission from the side panel — offscreen documents
  // cannot surface a permission prompt, so we must grant here first.
  const perm = await ensureMicPermission();
  if (!perm.ok) {
    setMsg('#sttStatus',
      perm.error === 'mic_denied'
        ? 'Microphone permission denied. Click the camera/mic icon in the address bar (or macOS System Settings → Privacy & Security → Microphone → enable Chrome) and try again.'
        : `Mic error: ${perm.message}`, 'error');
    setRecording(false);
    return;
  }
  await ensureOffscreen();
  const settings = await Storage.getSettings();
  const res = await chrome.runtime.sendMessage({
    type: 'REC_START',
    config: { silenceTimeoutMs: settings.silenceTimeoutMs }
  });
  if (!res || !res.ok) {
    const reason = res?.error === 'mic_denied'
      ? 'Microphone permission denied.'
      : (res?.message || res?.error || 'Failed to start recording.');
    setMsg('#sttStatus', reason, 'error');
    setRecording(false);
    return;
  }
  setMsg('#sttStatus', 'Listening…');
}

async function finishWebSpeech(finalText) {
  setMsg('#sttStatus', 'Done.', 'ok');
  const trimmed = finalText.trim();
  if (trimmed) {
    await Storage.addHistory({ type: 'stt', provider: 'webspeech', text: trimmed });
    const { autoCopyTranscript } = await Storage.getSettings();
    if (autoCopyTranscript) {
      try { await navigator.clipboard.writeText(trimmed); toast('Copied to clipboard.', 'ok'); } catch (_) {}
    }
  }
}

async function stopRecording() {
  const provider = $('#sttProvider').value;

  if (provider === 'webspeech') {
    setRecording(false);
    if (recognizer) { try { recognizer.stop(); } catch (_) {} recognizer = null; }
    return;
  }

  // Live streaming stop
  if (liveStreaming) {
    setRecording(false);
    await chrome.runtime.sendMessage({ type: 'STREAM_STOP' });
    chrome.runtime.sendMessage({ type: 'CLOSE_OFFSCREEN' });
    liveStreaming = false;
    setMsg('#sttStatus', 'Done.', 'ok');
    const finalText = liveFinalBuf.trim();
    if (finalText) {
      await Storage.addHistory({ type: 'stt', provider: `${provider}-live`, text: finalText });
      const { autoCopyTranscript } = await Storage.getSettings();
      if (autoCopyTranscript) {
        try { await navigator.clipboard.writeText($('#transcript').value); toast('Copied to clipboard.', 'ok'); } catch (_) {}
      }
    }
    return;
  }

  setRecording(false);
  setMsg('#sttStatus', 'Processing…');
  const res = await chrome.runtime.sendMessage({ type: 'REC_STOP' });
  chrome.runtime.sendMessage({ type: 'CLOSE_OFFSCREEN' });

  if (!res || !res.ok) {
    setMsg('#sttStatus',
      res?.error === 'audio_too_short' ? 'Audio too short.' : `Error: ${res?.error || 'unknown'}`,
      'error');
    return;
  }

  // Stash the blob so user can download / re-transcribe / translate
  lastRecordedBlob = await (await fetch(res.dataUrl)).blob();
  lastRecordedMime = res.mimeType;
  $('#downloadAudio').disabled = false;

  await transcribeCloud({ dataUrl: res.dataUrl, mimeType: res.mimeType, provider });
}

async function transcribeCloud({ dataUrl, mimeType, provider, translate }) {
  try {
    setMsg('#sttStatus', translate ? 'Translating…' : 'Transcribing…');
    const settings = await Storage.getSettings();
    const keys = await Storage.getKeys();
    let text = '';
    if (provider === 'assemblyai') {
      text = await STT.assemblyai.transcribe({ audio: dataUrl, mimeType, apiKey: keys.assemblyaiKey });
    } else if (provider === 'openai') {
      text = await STT.openai.transcribe({
        audio: dataUrl, mimeType, apiKey: keys.openaiKey,
        model: settings.openaiSttModel, translate: !!translate
      });
    } else if (provider === 'groq') {
      text = await STT.groq.transcribe({
        audio: dataUrl, mimeType, apiKey: keys.groqKey, model: settings.groqSttModel
      });
    } else if (provider === 'deepgram') {
      text = await STT.deepgram.transcribe({
        audio: dataUrl, mimeType, apiKey: keys.deepgramKey, model: settings.deepgramModel
      });
    }
    const cur = $('#transcript').value;
    const sep = cur && !cur.endsWith('\n') ? '\n' : '';
    $('#transcript').value = cur + sep + text;
    setMsg('#sttStatus', 'Done.', 'ok');

    if (text.trim()) {
      await Storage.addHistory({ type: 'stt', provider, text: text.trim() });
      if (settings.autoCopyTranscript) {
        try { await navigator.clipboard.writeText(text); toast('Copied to clipboard.', 'ok'); } catch (_) {}
      }
    }
  } catch (e) {
    setMsg('#sttStatus', e.message, 'error');
  }
}

// Copy / Clear / Download
$('#copyTranscript').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#transcript').value);
  toast('Copied.', 'ok');
});
$('#clearTranscript').addEventListener('click', () => { $('#transcript').value = ''; });

$('#downloadAudio').addEventListener('click', () => {
  if (!lastRecordedBlob) return;
  const ext = (lastRecordedMime.match(/audio\/([\w-]+)/) || [, 'webm'])[1].split(';')[0];
  const url = URL.createObjectURL(lastRecordedBlob);
  const a = document.createElement('a');
  a.href = url; a.download = `briefly-recording.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// Translate the last recording to the configured target language.
// English → use Whisper /audio/translations (one call).
// Anything else → transcribe in source language, then translate text via chat completions.
// Prefers Groq (free) over OpenAI when both keys exist.
$('#translateBtn').addEventListener('click', async () => {
  if (!lastRecordedBlob) {
    toast('Record audio first (then translate).', 'error');
    return;
  }
  const keys = await Storage.getKeys();
  const settings = await Storage.getSettings();
  const target = settings.translateTargetLang || 'en';
  const useGroq = !!keys.groqKey;
  if (!useGroq && !keys.openaiKey) {
    toast('Add a Groq (free) or OpenAI API key in Settings to translate.', 'error');
    return;
  }
  const providerName = useGroq ? 'groq' : 'openai';
  const targetUpper = target.toUpperCase();
  try {
    let translated;
    if (target === 'en') {
      setMsg('#sttStatus', `Translating → EN via ${useGroq ? 'Groq' : 'OpenAI'}…`);
      translated = useGroq
        ? await STT.groq.transcribe({
            audio: lastRecordedBlob, mimeType: lastRecordedMime,
            apiKey: keys.groqKey, translate: true
          })
        : await STT.openai.transcribe({
            audio: lastRecordedBlob, mimeType: lastRecordedMime,
            apiKey: keys.openaiKey, model: 'whisper-1', translate: true
          });
    } else {
      setMsg('#sttStatus', `Transcribing for translation…`);
      const source = useGroq
        ? await STT.groq.transcribe({
            audio: lastRecordedBlob, mimeType: lastRecordedMime,
            apiKey: keys.groqKey
          })
        : await STT.openai.transcribe({
            audio: lastRecordedBlob, mimeType: lastRecordedMime,
            apiKey: keys.openaiKey, model: 'whisper-1'
          });
      setMsg('#sttStatus', `Translating → ${targetUpper}…`);
      translated = await translateText({
        text: source,
        targetLang: target,
        groqKey: keys.groqKey,
        openaiKey: keys.openaiKey
      });
    }
    const cur = $('#transcript').value;
    const sep = cur && !cur.endsWith('\n') ? '\n' : '';
    $('#transcript').value = cur + sep + `[${targetUpper}] ` + translated;
    setMsg('#sttStatus', 'Translated.', 'ok');
    await Storage.addHistory({ type: 'stt', provider: `${providerName}-translate-${target}`, text: translated });
  } catch (e) {
    setMsg('#sttStatus', e.message, 'error');
  }
});


// ─── Drag-and-drop / file picker ─────────────────────────
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => {
  e.preventDefault(); dz.classList.add('dragover');
}));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => {
  e.preventDefault(); dz.classList.remove('dragover');
}));
dz.addEventListener('drop', e => {
  const file = e.dataTransfer.files[0];
  if (file) handleAudioFile(file);
});
$('#pickFile').addEventListener('click', () => $('#audioFile').click());
$('#audioFile').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) handleAudioFile(file);
});

async function handleAudioFile(file) {
  const provider = $('#sttProvider').value;
  if (provider === 'webspeech') {
    toast('Pick a cloud provider to transcribe a file.', 'error');
    return;
  }
  lastRecordedBlob = file;
  lastRecordedMime = file.type || 'audio/webm';
  $('#downloadAudio').disabled = false;

  const reader = new FileReader();
  reader.onloadend = async () => {
    await transcribeCloud({
      dataUrl: reader.result, mimeType: file.type, provider
    });
  };
  reader.readAsDataURL(file);
}

// ─── TTS ─────────────────────────────────────────────────
let currentAudioUrl = null;
let lastTtsBlob = null;

$('#speakBtn').addEventListener('click', () => speak($('#ttsText').value.trim()));
$('#pasteSpeak').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    $('#ttsText').value = text; updateCharCount();
    speak(text.trim());
  } catch (e) {
    toast('Clipboard read failed.', 'error');
  }
});

async function speak(text) {
  if (!text) { setMsg('#ttsStatus', 'Enter some text first.', 'error'); return; }
  const provider = $('#ttsProvider').value;
  setMsg('#ttsStatus', 'Speaking…');

  if (provider === 'webspeech') {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const settings = await Storage.getSettings();
    u.rate = settings.ttsRate;
    u.pitch = settings.ttsPitch;
    u.volume = settings.ttsVolume;
    const voiceURI = $('#webspeechVoice').value;
    const voice = speechSynthesis.getVoices().find(v => v.voiceURI === voiceURI);
    if (voice) u.voice = voice;
    u.onend = () => { setMsg('#ttsStatus', 'Done.', 'ok'); };
    u.onerror = e => setMsg('#ttsStatus', `Error: ${e.error}`, 'error');
    speechSynthesis.speak(u);
    await Storage.addHistory({ type: 'tts', provider: 'webspeech', text });
    return;
  }

  try {
    const keys = await Storage.getKeys();
    const settings = await Storage.getSettings();
    let blob;
    if (provider === 'elevenlabs') {
      const voiceId = $('#elevenVoice').value || settings.elevenVoiceId;
      blob = await TTS.elevenlabs.synthesize({
        text, apiKey: keys.elevenlabsKey,
        voiceId, modelId: $('#elevenModel').value,
        stability: settings.elevenStability,
        similarity: settings.elevenSimilarity
      });
    } else if (provider === 'openai') {
      blob = await TTS.openai.synthesize({
        text, apiKey: keys.openaiKey,
        voice: $('#openaiVoice').value,
        model: $('#openaiTtsModel').value
      });
    } else if (provider === 'streamelements') {
      blob = await TTS.streamelements.synthesize({
        text, voice: $('#streamElementsVoice').value || settings.streamElementsVoice
      });
    } else if (provider === 'gtranslate') {
      blob = await TTS.gtranslate.synthesize({
        text, lang: $('#gtranslateLang').value || settings.gtranslateLang
      });
    }
    lastTtsBlob = blob;
    $('#downloadTts').disabled = false;
    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = URL.createObjectURL(blob);
    const audio = $('#ttsAudio');
    audio.hidden = false;
    audio.src = currentAudioUrl;
    await audio.play();
    setMsg('#ttsStatus', 'Done.', 'ok');
    await Storage.addHistory({ type: 'tts', provider, text });
  } catch (e) {
    setMsg('#ttsStatus', e.message, 'error');
  }
}

$('#stopSpeakBtn').addEventListener('click', () => {
  if ($('#ttsProvider').value === 'webspeech') speechSynthesis.cancel();
  else {
    const audio = $('#ttsAudio');
    audio.pause(); audio.currentTime = 0;
  }
  setMsg('#ttsStatus', 'Stopped.');
});

$('#downloadTts').addEventListener('click', () => {
  if (!lastTtsBlob) return;
  const url = URL.createObjectURL(lastTtsBlob);
  const a = document.createElement('a');
  a.href = url; a.download = 'briefly-tts.mp3';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ─── History panel ───────────────────────────────────────
async function renderHistory() {
  const list = $('#historyList');
  const items = await Storage.getHistory();
  list.innerHTML = '';
  $('#historyEmpty').style.display = items.length ? 'none' : '';
  items.forEach(item => {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.dataset.id = item.id;
    const date = item.timestamp ? new Date(item.timestamp).toLocaleString() : '';
    const type = (item.type || 'stt').toLowerCase();
    const tag = type.toUpperCase();
    li.innerHTML = `
      <div class="head">
        <span>${tag} · ${item.provider || ''}</span>
        <span>${date} <button class="del" title="Delete">✕</button></span>
      </div>
      <div class="body"></div>
    `;
    li.querySelector('.body').textContent = item.text || '';
    li.addEventListener('click', e => {
      if (e.target.classList.contains('del')) {
        Storage.deleteHistory(item.id).then(renderHistory);
        return;
      }
      if (type === 'stt') {
        $('#transcript').value = item.text || '';
        $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'stt'));
        $$('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === 'stt'));
      } else {
        $('#ttsText').value = item.text || ''; updateCharCount();
        $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'tts'));
        $$('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === 'tts'));
      }
      $('#historyDrawer').hidden = true;
    });
    list.appendChild(li);
  });
}

$('#clearHistory').addEventListener('click', async () => {
  if (!confirm('Clear all history?')) return;
  await Storage.clearHistory();
  await renderHistory();
});

// Persist live-stream toggle
$('#liveStream').addEventListener('change', e => {
  chrome.storage.local.set({ liveStreamPref: e.target.checked });
});

// ─── Boot ────────────────────────────────────────────────
(async () => {
  await loadSettings();
  if ($('#ttsProvider').value === 'elevenlabs') loadElevenVoices();
  const { liveStreamPref } = await chrome.storage.local.get('liveStreamPref');
  $('#liveStream').checked = !!liveStreamPref;
  await maybeShowOnboarding();
})();
