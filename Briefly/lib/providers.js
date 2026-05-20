// STT + TTS provider adapters.

// fetch wrapper: retries on 429 + 5xx, exponential backoff, offline detection.
async function rfetch(url, init = {}, opts = {}) {
  const { retries = 3, baseMs = 600, label = '' } = opts;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error(`${label || 'Network'}: you appear to be offline.`);
  }
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${label || url}: ${res.status} ${res.statusText}`);
        // Honor Retry-After if present, else exponential backoff w/ jitter
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay = retryAfter > 0
          ? retryAfter * 1000
          : Math.round(baseMs * Math.pow(2, attempt) * (0.7 + Math.random() * 0.6));
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      return res;   // 4xx (non-429) bubbles up with the body intact
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, baseMs * Math.pow(2, attempt)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('Unknown network error.');
}

function dataUrlToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime = (header.match(/data:([^;]+)/) || [])[1] || 'audio/webm';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function chunkText(text, max) {
  const out = [];
  const parts = text.split(/(\s+|(?<=[.!?,;:])\s*)/);
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length > max) {
      if (buf) out.push(buf);
      if (p.length > max) {
        for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
        buf = '';
      } else {
        buf = p;
      }
    } else {
      buf += p;
    }
  }
  if (buf.trim()) out.push(buf);
  return out.length ? out : [text];
}

function extFromMime(mime) {
  if (!mime) return 'webm';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg')) return 'mp3';
  return 'webm';
}

// Accept either dataUrl, Blob, or File. Returns a Blob.
function toBlob(input) {
  if (!input) throw new Error('No audio input.');
  if (input instanceof Blob) return input;
  if (typeof input === 'string' && input.startsWith('data:')) return dataUrlToBlob(input);
  throw new Error('Unsupported audio input.');
}

// ─── Text translation (for non-English Translate-button targets) ───
// Uses an OpenAI-compatible chat-completions endpoint.
// Groq mirrors OpenAI's chat API for free; we prefer Groq when its key is set.
export const TRANSLATE_LANGS = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Mandarin (Chinese)' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'ru', label: 'Russian' },
  { code: 'ko', label: 'Korean' },
  { code: 'ar', label: 'Arabic' },
  { code: 'tr', label: 'Turkish' },
  { code: 'nl', label: 'Dutch' }
];

export async function translateText({ text, targetLang, groqKey, openaiKey }) {
  if (!text || !text.trim()) return '';
  const label = (TRANSLATE_LANGS.find(l => l.code === targetLang) || { label: targetLang }).label;
  const useGroq = !!groqKey;
  const endpoint = useGroq
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';
  const apiKey = useGroq ? groqKey : openaiKey;
  if (!apiKey) throw new Error('Add a Groq (free) or OpenAI API key in Settings to translate.');
  const model = useGroq ? 'llama-3.1-8b-instant' : 'gpt-4o-mini';
  const res = await rfetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: `You are a precise translator. Translate the user's text into ${label}. Output ONLY the translation, no quotes or notes.` },
        { role: 'user', content: text }
      ]
    })
  }, { label: 'Text translate' });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Translate failed: ${res.status} ${t}`);
  }
  const j = await res.json();
  return (j?.choices?.[0]?.message?.content || '').trim();
}

// ─── STT ───────────────────────────────────────────────────────────

export const STT = {
  webspeech: {
    name: 'Web Speech API (free, browser)',
    needsKey: false,
    needsRecorder: false
  },
  assemblyai: {
    name: 'AssemblyAI',
    needsKey: 'assemblyaiKey',
    needsRecorder: true,
    async testKey({ apiKey }) {
      // AssemblyAI has no lightweight key-check endpoint; hit /transcript with empty body
      // and accept anything other than 401/403 as "key looks valid".
      const r = await fetch('https://api.assemblyai.com/v2/transcript', {
        method: 'GET',
        headers: { Authorization: apiKey }
      });
      if (r.status === 401 || r.status === 403) return { ok: false, status: r.status };
      return { ok: true };
    },
    async transcribe({ audio, mimeType, apiKey }) {
      if (!apiKey) throw new Error('AssemblyAI API key required.');
      const blob = toBlob(audio);
      const up = await rfetch('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/octet-stream' },
        body: blob
      }, { label: 'AssemblyAI upload' });
      if (!up.ok) throw new Error(`AssemblyAI upload failed: ${up.status}`);
      const { upload_url } = await up.json();

      const create = await rfetch('https://api.assemblyai.com/v2/transcript', {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_url: upload_url })
      }, { label: 'AssemblyAI transcript' });
      if (!create.ok) throw new Error(`AssemblyAI job create failed: ${create.status}`);
      const { id } = await create.json();

      const start = Date.now();
      while (Date.now() - start < 120000) {
        await new Promise(r => setTimeout(r, 1500));
        const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
          headers: { Authorization: apiKey }
        });
        const j = await poll.json();
        if (j.status === 'completed') return j.text || '';
        if (j.status === 'error') throw new Error(j.error || 'AssemblyAI error');
      }
      throw new Error('AssemblyAI timed out.');
    }
  },
  openai: {
    name: 'OpenAI Whisper',
    needsKey: 'openaiKey',
    needsRecorder: true,
    async testKey({ apiKey }) {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      return { ok: r.ok, status: r.status };
    },
    async transcribe({ audio, mimeType, apiKey, model, translate }) {
      if (!apiKey) throw new Error('OpenAI API key required.');
      const blob = toBlob(audio);
      const ext = extFromMime(mimeType || blob.type);
      const form = new FormData();
      form.append('file', new File([blob], `audio.${ext}`, { type: blob.type }));
      form.append('model', model || 'whisper-1');
      const endpoint = translate
        ? 'https://api.openai.com/v1/audio/translations'
        : 'https://api.openai.com/v1/audio/transcriptions';
      const res = await rfetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form
      }, { label: 'OpenAI STT' });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`OpenAI STT failed: ${res.status} ${t}`);
      }
      const j = await res.json();
      return j.text || '';
    }
  },
  groq: {
    name: 'Groq Whisper (fast)',
    needsKey: 'groqKey',
    needsRecorder: true,
    async testKey({ apiKey }) {
      const r = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      return { ok: r.ok, status: r.status };
    },
    async transcribe({ audio, mimeType, apiKey, model, translate }) {
      if (!apiKey) throw new Error('Groq API key required.');
      const blob = toBlob(audio);
      const ext = extFromMime(mimeType || blob.type);
      const form = new FormData();
      form.append('file', new File([blob], `audio.${ext}`, { type: blob.type }));
      // Translation requires whisper-large-v3 (not the turbo variant)
      form.append('model', translate ? 'whisper-large-v3' : (model || 'whisper-large-v3-turbo'));
      const endpoint = translate
        ? 'https://api.groq.com/openai/v1/audio/translations'
        : 'https://api.groq.com/openai/v1/audio/transcriptions';
      const res = await rfetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form
      }, { label: 'Groq STT' });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Groq STT failed: ${res.status} ${t}`);
      }
      const j = await res.json();
      return j.text || '';
    }
  },
  deepgram: {
    name: 'Deepgram',
    needsKey: 'deepgramKey',
    needsRecorder: true,
    async testKey({ apiKey }) {
      const r = await fetch('https://api.deepgram.com/v1/projects', {
        headers: { Authorization: `Token ${apiKey}` }
      });
      return { ok: r.ok, status: r.status };
    },
    async transcribe({ audio, mimeType, apiKey, model, lang }) {
      if (!apiKey) throw new Error('Deepgram API key required.');
      const blob = toBlob(audio);
      const params = new URLSearchParams({
        model: model || 'nova-3',
        smart_format: 'true',
        punctuate: 'true'
      });
      if (lang) params.set('language', lang);
      const res = await rfetch(`https://api.deepgram.com/v1/listen?${params}`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': blob.type || mimeType || 'audio/webm'
        },
        body: blob
      }, { label: 'Deepgram' });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Deepgram failed: ${res.status} ${t}`);
      }
      const j = await res.json();
      return j?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    }
  }
};

// ─── TTS ───────────────────────────────────────────────────────────

export const TTS = {
  webspeech: {
    name: 'Web Speech API (free, browser)',
    needsKey: false,
    inProcess: true
  },
  streamelements: {
    name: 'StreamElements (free, no key)',
    needsKey: false,
    async synthesize({ text, voice = 'Brian' }) {
      if (!text || !text.trim()) throw new Error('Text is empty.');
      // StreamElements caps each request around ~500 chars; chunk safely.
      const chunks = chunkText(text, 480);
      const blobs = [];
      for (const chunk of chunks) {
        const url = `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(chunk)}`;
        const res = await rfetch(url, { method: 'GET' }, { label: 'StreamElements TTS' });
        if (!res.ok) {
          const t = await res.text();
          throw new Error(`StreamElements TTS failed: ${res.status} ${t}`);
        }
        blobs.push(await res.blob());
      }
      return new Blob(blobs, { type: 'audio/mpeg' });
    }
  },
  gtranslate: {
    name: 'Google Translate TTS (free, short text)',
    needsKey: false,
    async synthesize({ text, lang = 'en' }) {
      if (!text || !text.trim()) throw new Error('Text is empty.');
      // Google Translate TTS endpoint caps at ~200 chars per call.
      const chunks = chunkText(text, 190);
      const blobs = [];
      for (let i = 0; i < chunks.length; i++) {
        const params = new URLSearchParams({
          ie: 'UTF-8', q: chunks[i], tl: lang, total: String(chunks.length),
          idx: String(i), textlen: String(chunks[i].length), client: 'tw-ob'
        });
        const res = await rfetch(
          `https://translate.google.com/translate_tts?${params}`,
          { method: 'GET', headers: { Referer: 'https://translate.google.com/' } },
          { label: 'Google Translate TTS' }
        );
        if (!res.ok) {
          const t = await res.text();
          throw new Error(`Google Translate TTS failed: ${res.status} ${t}`);
        }
        blobs.push(await res.blob());
      }
      return new Blob(blobs, { type: 'audio/mpeg' });
    }
  },
  elevenlabs: {
    name: 'ElevenLabs',
    needsKey: 'elevenlabsKey',
    async testKey({ apiKey }) {
      const r = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': apiKey }
      });
      return { ok: r.ok, status: r.status };
    },
    async synthesize({ text, apiKey, voiceId, modelId, stability, similarity }) {
      if (!apiKey) throw new Error('ElevenLabs API key required.');
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
      const body = {
        text,
        model_id: modelId || 'eleven_multilingual_v2'
      };
      if (typeof stability === 'number' || typeof similarity === 'number') {
        body.voice_settings = {
          stability: typeof stability === 'number' ? stability : 0.5,
          similarity_boost: typeof similarity === 'number' ? similarity : 0.75
        };
      }
      const res = await rfetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg'
        },
        body: JSON.stringify(body)
      }, { label: 'ElevenLabs TTS' });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`ElevenLabs failed: ${res.status} ${t}`);
      }
      return await res.blob();
    },
    async listVoices({ apiKey }) {
      if (!apiKey) throw new Error('ElevenLabs API key required.');
      const res = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': apiKey }
      });
      if (!res.ok) throw new Error(`ElevenLabs voices failed: ${res.status}`);
      const j = await res.json();
      return (j.voices || []).map(v => ({ id: v.voice_id, name: v.name }));
    }
  },
  openai: {
    name: 'OpenAI TTS',
    needsKey: 'openaiKey',
    async testKey({ apiKey }) {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      return { ok: r.ok, status: r.status };
    },
    async synthesize({ text, apiKey, voice, model }) {
      if (!apiKey) throw new Error('OpenAI API key required.');
      const res = await rfetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: model || 'tts-1',
          voice: voice || 'alloy',
          input: text
        })
      }, { label: 'OpenAI TTS' });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`OpenAI TTS failed: ${res.status} ${t}`);
      }
      return await res.blob();
    }
  }
};

export const OPENAI_TTS_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
