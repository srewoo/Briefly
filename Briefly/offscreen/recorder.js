// Offscreen mic capture with live waveform + silence detection.
// Posts WAVEFORM_DATA and SILENCE_DETECTED to the side panel.

let mediaRecorder = null;
let stream = null;
let chunks = [];
let audioCtx = null;
let analyser = null;
let monitorRaf = null;
let silenceStartedAt = null;
let silenceTimeoutMs = 0;   // 0 = disabled

function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4'
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function blobToDataUrl(blob) {
  return new Promise(resolve => {
    const r = new FileReader();
    r.onloadend = () => resolve(r.result);
    r.readAsDataURL(blob);
  });
}

function notify(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function sampleAnalyser(an, fftBuf, timeBuf) {
  an.getByteFrequencyData(fftBuf);
  an.getByteTimeDomainData(timeBuf);
  let sumSq = 0;
  for (let i = 0; i < timeBuf.length; i++) {
    const v = (timeBuf[i] - 128) / 128;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / timeBuf.length);
  const bars = 48;
  const stride = Math.floor(fftBuf.length / bars);
  const data = new Array(bars);
  for (let i = 0; i < bars; i++) {
    let sum = 0;
    for (let j = 0; j < stride; j++) sum += fftBuf[i * stride + j];
    data[i] = Math.round(sum / stride);
  }
  return { bars: data, rms };
}

const SILENCE_RMS = 0.015;
function checkSilence(rms) {
  if (silenceTimeoutMs <= 0) return false;
  if (rms < SILENCE_RMS) {
    if (silenceStartedAt == null) silenceStartedAt = performance.now();
    else if (performance.now() - silenceStartedAt >= silenceTimeoutMs) {
      silenceStartedAt = null;
      return true;
    }
  } else {
    silenceStartedAt = null;
  }
  return false;
}

function startMonitor() {
  if (!analyser) return;
  const fftBuf = new Uint8Array(analyser.frequencyBinCount);
  const timeBuf = new Uint8Array(analyser.fftSize);
  // Offscreen documents throttle rAF heavily — use setInterval (~30 fps).
  monitorRaf = setInterval(() => {
    if (!analyser) return;
    const { bars, rms } = sampleAnalyser(analyser, fftBuf, timeBuf);
    if (checkSilence(rms)) notify({ type: 'SILENCE_DETECTED' });
    notify({ type: 'WAVEFORM_DATA', bars, level: rms });
  }, 33);
}

function stopMonitor() {
  if (monitorRaf) clearInterval(monitorRaf);
  monitorRaf = null;
  silenceStartedAt = null;
}

async function start(config = {}) {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    return { ok: false, error: 'already_recording' };
  }
  silenceTimeoutMs = Number(config.silenceTimeoutMs) || 0;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  } catch (e) {
    return {
      ok: false,
      error: e.name === 'NotAllowedError' ? 'mic_denied' : 'mic_error',
      message: e.message
    };
  }

  audioCtx = new AudioContext();
  const src = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.7;
  src.connect(analyser);

  const mimeType = pickMimeType();
  chunks = [];
  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  mediaRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  mediaRecorder.start();
  startMonitor();
  return { ok: true, mimeType: mediaRecorder.mimeType || mimeType || 'audio/webm' };
}

function cleanup() {
  stopMonitor();
  analyser = null;
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
}

async function stop() {
  if (!mediaRecorder) return { ok: false, error: 'not_recording' };
  const mimeType = mediaRecorder.mimeType || 'audio/webm';
  const done = new Promise(resolve => {
    mediaRecorder.onstop = async () => {
      const blob = new Blob(chunks, { type: mimeType });
      chunks = [];
      cleanup();
      if (blob.size < 500) {
        resolve({ ok: false, error: 'audio_too_short' });
        return;
      }
      const dataUrl = await blobToDataUrl(blob);
      resolve({ ok: true, dataUrl, mimeType, size: blob.size });
    };
  });
  try { mediaRecorder.stop(); } catch (_) {}
  mediaRecorder = null;
  return done;
}

async function cancel() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch (_) {}
  }
  mediaRecorder = null;
  chunks = [];
  cleanup();
  return { ok: true };
}

// ─── Live Deepgram streaming via WebSocket + raw PCM ────────────
// We can't stream MediaRecorder chunks (each chunk after the first lacks the
// WebM header). Instead, capture PCM via an AudioWorkletNode and ship raw
// 16-bit linear samples — Deepgram accepts encoding=linear16.

let liveWs = null;
let liveCtx = null;
let liveStream = null;
let liveWorklet = null;
let liveAnalyser = null;
let liveMonitorRaf = null;
// Parallel MediaRecorder for live mode — so Translate / Download have a Blob.
let liveBackupRecorder = null;
let liveBackupChunks = [];
let liveBackupMime = '';

function startBackupRecorder() {
  if (!liveStream) return;
  const mimeType = pickMimeType();
  liveBackupMime = mimeType || 'audio/webm';
  liveBackupChunks = [];
  try {
    liveBackupRecorder = new MediaRecorder(liveStream, mimeType ? { mimeType } : undefined);
    liveBackupRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) liveBackupChunks.push(e.data);
    };
    liveBackupRecorder.start();
  } catch (_) {
    liveBackupRecorder = null;
  }
}

async function stopBackupRecorderAndNotify() {
  if (!liveBackupRecorder) return;
  const mime = liveBackupRecorder.mimeType || liveBackupMime;
  await new Promise(resolve => {
    liveBackupRecorder.onstop = () => resolve();
    try { liveBackupRecorder.stop(); } catch (_) { resolve(); }
  });
  liveBackupRecorder = null;
  const blob = new Blob(liveBackupChunks, { type: mime });
  liveBackupChunks = [];
  if (blob.size < 500) return;
  const dataUrl = await blobToDataUrl(blob);
  notify({ type: 'STREAM_AUDIO_BLOB', dataUrl, mimeType: mime, size: blob.size });
}

const PCM_WORKLET_SRC = `
class PCMWriter extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const ch = input[0];
      const out = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      this.port.postMessage(out.buffer, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-writer', PCMWriter);
`;

function startLiveMonitor() {
  if (!liveAnalyser) return;
  const fft = new Uint8Array(liveAnalyser.frequencyBinCount);
  const timeBuf = new Uint8Array(liveAnalyser.fftSize);
  // Offscreen rAF is throttled; use setInterval for a steady ~30 fps.
  liveMonitorRaf = setInterval(() => {
    if (!liveAnalyser) return;
    const { bars, rms } = sampleAnalyser(liveAnalyser, fft, timeBuf);
    if (checkSilence(rms)) notify({ type: 'SILENCE_DETECTED' });
    notify({ type: 'WAVEFORM_DATA', bars, level: rms });
  }, 33);
}

function stopLiveMonitor() {
  if (liveMonitorRaf) clearInterval(liveMonitorRaf);
  liveMonitorRaf = null;
  silenceStartedAt = null;
}

async function startLiveDeepgram(config) {
  if (liveWs) return { ok: false, error: 'already_streaming' };
  const { apiKey, model = 'nova-3', lang } = config || {};
  if (!apiKey) return { ok: false, error: 'no_key', message: 'Deepgram API key required.' };
  silenceTimeoutMs = Number(config.silenceTimeoutMs) || 0;
  silenceStartedAt = null;

  try {
    liveStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    return { ok: false, error: e.name === 'NotAllowedError' ? 'mic_denied' : 'mic_error', message: e.message };
  }

  liveCtx = new AudioContext({ sampleRate: 16000 });
  try {
    await liveCtx.audioWorklet.addModule(chrome.runtime.getURL('offscreen/pcm-worklet.js'));
  } finally {
    // no-op
  }

  const src = liveCtx.createMediaStreamSource(liveStream);
  liveAnalyser = liveCtx.createAnalyser();
  liveAnalyser.fftSize = 512;
  liveAnalyser.smoothingTimeConstant = 0.7;
  src.connect(liveAnalyser);
  liveWorklet = new AudioWorkletNode(liveCtx, 'pcm-writer');
  src.connect(liveWorklet);

  const params = new URLSearchParams({
    model,
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    smart_format: 'true',
    punctuate: 'true',
    interim_results: 'true'
  });
  if (lang) params.set('language', lang);

  // Deepgram supports auth via sub-protocol: ["token", "<KEY>"]
  liveWs = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', apiKey]);
  liveWs.binaryType = 'arraybuffer';

  liveWs.onopen = () => {
    liveWorklet.port.onmessage = (ev) => {
      if (liveWs && liveWs.readyState === WebSocket.OPEN) liveWs.send(ev.data);
    };
    startBackupRecorder();
    startLiveMonitor();
    notify({ type: 'STREAM_OPEN' });
  };
  liveWs.onmessage = (ev) => {
    try {
      const j = JSON.parse(ev.data);
      if (j.type === 'Results') {
        const alt = j.channel?.alternatives?.[0];
        if (!alt) return;
        notify({
          type: 'STREAM_TRANSCRIPT',
          text: alt.transcript || '',
          isFinal: !!j.is_final,
          speechFinal: !!j.speech_final
        });
      }
    } catch (_) {}
  };
  liveWs.onerror = () => notify({ type: 'STREAM_ERROR', message: 'WebSocket error.' });
  liveWs.onclose = (ev) => notify({ type: 'STREAM_CLOSED', code: ev.code });

  return { ok: true };
}

async function stopLive() {
  stopLiveMonitor();
  // Finalize the backup recorder BEFORE we stop the mic tracks, so the
  // last buffered chunk gets flushed and the side panel receives the blob.
  await stopBackupRecorderAndNotify();
  try { if (liveWorklet) liveWorklet.port.onmessage = null; } catch (_) {}
  try { if (liveWorklet) liveWorklet.disconnect(); } catch (_) {}
  liveWorklet = null;
  liveAnalyser = null;
  if (liveWs) {
    try {
      if (liveWs.readyState === WebSocket.OPEN) {
        // Send both terminators — the server that doesn't recognise its peer's frame just ignores it.
        liveWs.send(JSON.stringify({ type: 'CloseStream' }));      // Deepgram
        liveWs.send(JSON.stringify({ type: 'Terminate' }));        // AssemblyAI v3
      }
    } catch (_) {}
    try { liveWs.close(); } catch (_) {}
    liveWs = null;
  }
  if (liveCtx) { liveCtx.close().catch(() => {}); liveCtx = null; }
  if (liveStream) { liveStream.getTracks().forEach(t => t.stop()); liveStream = null; }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type.startsWith('REC_')) {
    (async () => {
      if (msg.type === 'REC_START') sendResponse(await start(msg.config || {}));
      else if (msg.type === 'REC_STOP') sendResponse(await stop());
      else if (msg.type === 'REC_CANCEL') sendResponse(await cancel());
    })();
    return true;
  }
  if (msg.type === 'STREAM_START_DEEPGRAM') {
    (async () => sendResponse(await startLiveDeepgram(msg.config || {})))();
    return true;
  }
  if (msg.type === 'STREAM_START_ASSEMBLYAI') {
    (async () => sendResponse(await startLiveAssemblyAI(msg.config || {})))();
    return true;
  }
  if (msg.type === 'STREAM_STOP') {
    (async () => sendResponse(await stopLive()))();
    return true;
  }
});

// ─── AssemblyAI Universal Streaming (v3) ─────────────────
async function startLiveAssemblyAI(config) {
  if (liveWs) return { ok: false, error: 'already_streaming' };
  const { apiKey } = config || {};
  if (!apiKey) return { ok: false, error: 'no_key', message: 'AssemblyAI API key required.' };
  silenceTimeoutMs = Number(config.silenceTimeoutMs) || 0;
  silenceStartedAt = null;

  // 1. Get a short-lived streaming token so we don't expose the main key in the URL.
  let token;
  try {
    const tRes = await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=300', {
      headers: { Authorization: apiKey }
    });
    if (!tRes.ok) {
      const body = await tRes.text();
      return { ok: false, error: 'token_failed', message: `AssemblyAI token: ${tRes.status} ${body}` };
    }
    ({ token } = await tRes.json());
  } catch (e) {
    return { ok: false, error: 'token_failed', message: e.message };
  }

  try {
    liveStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    return { ok: false, error: e.name === 'NotAllowedError' ? 'mic_denied' : 'mic_error', message: e.message };
  }

  liveCtx = new AudioContext({ sampleRate: 16000 });
  await liveCtx.audioWorklet.addModule(chrome.runtime.getURL('offscreen/pcm-worklet.js'));

  const src = liveCtx.createMediaStreamSource(liveStream);
  liveAnalyser = liveCtx.createAnalyser();
  liveAnalyser.fftSize = 512;
  liveAnalyser.smoothingTimeConstant = 0.7;
  src.connect(liveAnalyser);
  liveWorklet = new AudioWorkletNode(liveCtx, 'pcm-writer');
  src.connect(liveWorklet);

  const params = new URLSearchParams({
    sample_rate: '16000',
    format_turns: 'true',
    token
  });
  liveWs = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${params}`);
  liveWs.binaryType = 'arraybuffer';

  liveWs.onopen = () => {
    liveWorklet.port.onmessage = (ev) => {
      if (liveWs && liveWs.readyState === WebSocket.OPEN) liveWs.send(ev.data);
    };
    startBackupRecorder();
    startLiveMonitor();
    notify({ type: 'STREAM_OPEN' });
  };
  liveWs.onmessage = (ev) => {
    try {
      const j = JSON.parse(ev.data);
      // AssemblyAI v3 emits "Turn" events with end_of_turn flag
      if (j.type === 'Turn' || j.transcript !== undefined) {
        const text = j.transcript || '';
        const isFinal = !!(j.end_of_turn || j.turn_is_formatted);
        if (text) notify({ type: 'STREAM_TRANSCRIPT', text, isFinal });
      }
    } catch (_) {}
  };
  liveWs.onerror = () => notify({ type: 'STREAM_ERROR', message: 'WebSocket error.' });
  liveWs.onclose = (ev) => notify({ type: 'STREAM_CLOSED', code: ev.code });

  return { ok: true };
}
