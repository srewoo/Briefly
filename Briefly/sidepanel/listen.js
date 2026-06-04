// Briefly — Listen tab. Extraction, page-type detection, AI modes
// (explain / summary / technical brief), cost estimate, and a remote control
// for the player living in the offscreen document.
import { Storage } from '../lib/storage.js';
import {
  explainBatch, generateSummary, generateTechBrief, generatePodcastScript,
  toSegments, llmCostNote
} from '../lib/llm.js';

const $ = (s) => document.querySelector(s);

// Per-character pricing (USD). LLM cost noted separately.
// groqtts: free tier. deepgramtts: ~$0.015/1k chars, but drawn from the
// $200 signup credit — shown so users can see the burn rate.
const COST_PER_CHAR = {
  openai: 15 / 1_000_000,
  elevenlabs: 0.18 / 1000,
  deepgramtts: 0.015 / 1000
};
const EXPLAIN_BATCH_CHARS = 2800;
const SPOKEN_CHARS_PER_MIN = 900; // ~150 wpm × ~6 chars/word

let page = null;       // result of BRIEFLY_EXTRACT
let pageTabId = null;  // tab we extracted from (for highlight sync)
let pageType = null;   // 'Jira issue' | 'Confluence page' | …
let lastSrcIdx = -1;
let genSession = 0;    // cancels in-flight LLM generation on stop/restart

// ─── page-type detection ───────────────────────────────────

function detectPageType(url, title = '') {
  const u = url.toLowerCase();
  if (/atlassian\.net\/browse\/|\/jira\/|jira\./.test(u)) return 'Jira issue';
  if (/atlassian\.net\/wiki|confluence/.test(u)) return 'Confluence page';
  if (/\/-\/merge_requests\/\d+/.test(u)) return 'GitLab merge request';
  if (/github\.com\/.+\/pull\/\d+/.test(u)) return 'GitHub pull request';
  if (/swagger|openapi|\/api-docs|\/reference\/|readme\.io/.test(u + ' ' + title.toLowerCase())) {
    return 'API documentation';
  }
  return null;
}

// ─── page detection ────────────────────────────────────────

async function detectPage() {
  const status = $('#listenStatus');
  status.textContent = 'Detecting…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) throw new Error('No active tab.');
    if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
      throw new Error('This page cannot be read (browser-internal page).');
    }
    // activeTab alone is revoked on tab switch/navigation — ask for a
    // per-origin grant (remembered by Chrome) while we have a user gesture.
    const origin = new URL(tab.url).origin + '/*';
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error('Permission to read this site was declined.');
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/reader.js']
    });
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'BRIEFLY_EXTRACT' });
    if (!res || !res.ok) throw new Error('No readable content found on this page.');
    page = res;
    pageTabId = tab.id;
    pageType = detectPageType(tab.url, res.title);
    $('#pageTitle').textContent = res.title || res.siteName;
    const mins = Math.max(1, Math.round(res.wordCount / 180));
    $('#pageMeta').textContent =
      `${res.siteName} · ${res.paragraphs.length} paragraphs · ~${mins} min listen` +
      (pageType ? ` · ${pageType}` : '');
    const tbRow = $('#techbriefRow');
    const tbInput = tbRow.querySelector('input');
    tbRow.classList.toggle('disabled', !pageType);
    tbInput.disabled = !pageType;
    $('#techbriefLabel').innerHTML = pageType
      ? `Technical brief <em class="badge">${pageType}</em>`
      : 'Technical brief <em class="badge">AI</em>';
    if (!pageType && tbInput.checked) $('input[name="listenMode"][value="read"]').checked = true;
    $('#listenStart').disabled = false;
    status.textContent = 'Ready';
    updateCost();
  } catch (e) {
    page = null;
    pageTabId = null;
    pageType = null;
    $('#listenStart').disabled = true;
    $('#pageTitle').textContent = 'No page detected';
    $('#pageMeta').textContent = String(e.message || e);
    status.textContent = 'Idle';
  }
}

// ─── cost estimate ─────────────────────────────────────────

function currentMode() {
  return document.querySelector('input[name="listenMode"]:checked')?.value || 'read';
}

async function updateCost() {
  const el = $('#listenCost');
  const provider = $('#listenProvider').value;
  const mode = currentMode();
  $('#lengthField').hidden = !['summary', 'podcast'].includes(mode);
  if (!page) { el.textContent = 'Est. cost: —'; return; }

  const fullChars = page.paragraphs.reduce((n, p) => n + p.text.length, 0);
  const minutes = Number($('#listenLength').value) || 2;
  const ttsChars = {
    read: fullChars,
    explain: Math.round(fullChars * 1.1),
    summary: minutes * SPOKEN_CHARS_PER_MIN,
    techbrief: 5 * SPOKEN_CHARS_PER_MIN,
    podcast: minutes * SPOKEN_CHARS_PER_MIN
  }[mode] || fullChars;

  if (provider === 'kokoro') {
    const keys2 = await Storage.getKeys();
    const llm = mode === 'read' ? '' : (llmCostNote(keys2) || ' + free LLM (Groq)');
    el.textContent = `Est. cost: free, on-device${llm} · first run downloads ~80MB (cached)`;
    return;
  }
  const rate = COST_PER_CHAR[provider];
  const ttsPart = rate ? `~$${Math.max(0.01, ttsChars * rate).toFixed(2)} TTS` : 'free TTS';
  const keys = await Storage.getKeys();
  const llmPart = mode === 'read' ? '' : (llmCostNote(keys) || ' + free LLM (Groq)');
  el.textContent = `Est. cost: ${ttsPart}${llmPart} (${(ttsChars / 1000).toFixed(1)}k chars)`;
}

// ─── provider options from saved settings/keys ─────────────

async function buildOptions(provider) {
  const [settings, keys] = await Promise.all([Storage.getSettings(), Storage.getKeys()]);
  switch (provider) {
    case 'webspeech':
      return { options: { voiceURI: settings.ttsVoiceURI }, voiceSig: `ws:${settings.ttsVoiceURI}` };
    case 'kokoro':
      // On-device, no key. First use downloads ~80MB (cached forever).
      return {
        options: { voice: settings.kokoroVoice, dtype: settings.kokoroDtype },
        voiceSig: `kk:${settings.kokoroDtype}:${settings.kokoroVoice}`
      };
    // StreamElements deliberately excluded: its free endpoint throttles with
    // intermittent 401s — fine for one snippet, fatal for a 70-paragraph read.
    case 'groqtts':
      if (!keys.groqKey) throw new Error('Add a Groq API key in Settings first (free at console.groq.com).');
      return {
        options: { apiKey: keys.groqKey, voice: settings.groqTtsVoice, model: 'canopylabs/orpheus-v1-english' },
        voiceSig: `gq:orpheus:${settings.groqTtsVoice}`
      };
    case 'deepgramtts':
      if (!keys.deepgramKey) throw new Error('Add a Deepgram API key in Settings first ($200 free credit at deepgram.com).');
      return {
        options: { apiKey: keys.deepgramKey, model: settings.deepgramTtsModel },
        voiceSig: `dg:${settings.deepgramTtsModel}`
      };
    case 'openai':
      if (!keys.openaiKey) throw new Error('Add an OpenAI API key in Settings first.');
      return {
        options: { apiKey: keys.openaiKey, voice: settings.openaiTtsVoice, model: settings.openaiTtsModel },
        voiceSig: `oa:${settings.openaiTtsModel}:${settings.openaiTtsVoice}`
      };
    case 'elevenlabs':
      if (!keys.elevenlabsKey) throw new Error('Add an ElevenLabs API key in Settings first.');
      return {
        options: {
          apiKey: keys.elevenlabsKey,
          voiceId: settings.elevenVoiceId,
          modelId: settings.elevenModelId,
          stability: settings.elevenStability,
          similarity: settings.elevenSimilarity
        },
        voiceSig: `el:${settings.elevenModelId}:${settings.elevenVoiceId}`
      };
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// Two distinct voices for podcast mode. Host A keeps the user's configured
// voice; Host B gets a stable, clearly different default.
function buildHostVoices(provider, hostA) {
  const a = { ...hostA.options };
  const b = { ...hostA.options };
  let sigB = hostA.voiceSig + ':B';
  if (provider === 'openai') {
    b.voice = a.voice === 'nova' ? 'onyx' : 'nova';
    sigB = `oa:${b.model}:${b.voice}`;
  } else if (provider === 'kokoro') {
    // Pair a female (A) with a male (B) voice by default.
    b.voice = a.voice?.startsWith('am_') || a.voice?.startsWith('bm_') ? 'af_heart' : 'am_adam';
    sigB = `kk:${b.dtype}:${b.voice}`;
  } else if (provider === 'groqtts') {
    b.voice = a.voice === 'troy' ? 'hannah' : 'troy';
    sigB = `gq:orpheus:${b.voice}`;
  } else if (provider === 'deepgramtts') {
    b.model = a.model === 'aura-2-apollo-en' ? 'aura-2-thalia-en' : 'aura-2-apollo-en';
    sigB = `dg:${b.model}`;
  } else if (provider === 'elevenlabs') {
    const RACHEL = '21m00Tcm4TlvDq8ikWAM';
    const ADAM = 'pNInz6obpgDQGcFmaJgB';
    b.voiceId = a.voiceId === RACHEL ? ADAM : RACHEL;
    sigB = `el:${b.modelId}:${b.voiceId}`;
  }
  // webspeech: the player picks an alternate voice for Host B itself.
  return {
    hostVoices: { A: a, B: b },
    voiceSigs: { A: hostA.voiceSig, B: sigB }
  };
}

// ─── generation pipelines ──────────────────────────────────

function batchParagraphs(paragraphs, maxChars) {
  const batches = [];
  let buf = [], len = 0;
  for (const p of paragraphs) {
    if (len + p.text.length > maxChars && buf.length) {
      batches.push(buf); buf = []; len = 0;
    }
    buf.push(p); len += p.text.length;
  }
  if (buf.length) batches.push(buf);
  return batches;
}

const send = (msg) => chrome.runtime.sendMessage(msg);

// "Listened" history: segments + metadata only — NEVER provider options
// (they contain API keys). Replay rebuilds options from current Settings,
// so cached audio replays free and instantly.
function saveListenHistory(mode, provider, segments) {
  if (!page || !segments?.length) return;
  Storage.addHistory({
    type: 'listen',
    provider,
    text: `${page.title || page.siteName} · ${mode}`,
    listen: { mode, title: page.title, url: page.url, segments }
  }).catch(() => {});
}

async function start() {
  if (!page) return;
  const status = $('#listenStatus');
  const mySession = ++genSession;
  try {
    const provider = $('#listenProvider').value;
    const { options, voiceSig } = await buildOptions(provider);
    const keys = await Storage.getKeys();
    const mode = currentMode();
    const base = { title: page.title, provider, options, voiceSig, rate: Number($('#playerRate').value) || 1 };
    await send({ type: 'ENSURE_OFFSCREEN' });

    if (mode === 'read') {
      const segments = page.paragraphs.map(p => ({ text: p.text, srcIdx: p.idx }));
      await send({ type: 'LISTEN_START', ...base, segments });
      saveListenHistory(mode, provider, segments);
      return;
    }

    if (mode === 'podcast') {
      status.textContent = 'Writing podcast script…';
      const fullText = page.paragraphs.map(p => p.text).join('\n\n');
      const minutes = Number($('#listenLength').value) || 5;
      const turns = await generatePodcastScript({ text: fullText, minutes, keys });
      if (mySession !== genSession) return;
      const hostCfg = buildHostVoices(provider, { options, voiceSig });
      await send({ type: 'LISTEN_START', ...base, ...hostCfg, segments: turns });
      saveListenHistory(mode, provider, turns);
      return;
    }

    if (mode === 'summary' || mode === 'techbrief') {
      status.textContent = mode === 'summary' ? 'Summarizing…' : 'Building technical brief…';
      const fullText = page.paragraphs.map(p => p.text).join('\n\n');
      const minutes = Number($('#listenLength').value) || 2;
      const script = mode === 'summary'
        ? await generateSummary({ text: fullText, minutes, keys })
        : await generateTechBrief({ text: fullText, pageType: pageType || 'technical document', keys });
      if (mySession !== genSession) return;
      const segments = toSegments(script);
      await send({ type: 'LISTEN_START', ...base, segments });
      saveListenHistory(mode, provider, segments);
      return;
    }

    if (mode === 'explain') {
      // Progressive: rewrite batch 1, start playing, keep appending.
      const batches = batchParagraphs(page.paragraphs, EXPLAIN_BATCH_CHARS);
      const rewriteBatch = async (batch) => {
        const text = batch.map(p => p.text).join('\n\n');
        const rewritten = await explainBatch({ text, keys });
        return toSegments(rewritten, batch[0].idx);
      };
      status.textContent = `Explaining section 1/${batches.length}…`;
      const first = await rewriteBatch(batches[0]);
      if (mySession !== genSession) return;
      await send({ type: 'LISTEN_START', ...base, streaming: true, segments: first });
      const allSegments = [...first];
      let complete = false;
      try {
        for (let b = 1; b < batches.length; b++) {
          if (mySession !== genSession) return;
          status.textContent = `Explaining section ${b + 1}/${batches.length}…`;
          const segs = await rewriteBatch(batches[b]);
          if (mySession !== genSession) return;
          await send({ type: 'LISTEN_APPEND', segments: segs });
          allSegments.push(...segs);
        }
        complete = true;
      } finally {
        if (mySession === genSession) await send({ type: 'LISTEN_COMPLETE' });
      }
      // Save only fully-generated sessions — a partial explain isn't replayable.
      if (complete) saveListenHistory(mode, provider, allSegments);
    }
  } catch (e) {
    if (mySession === genSession) status.textContent = String(e.message || e);
  }
}

function sendControl(type, extra = {}) {
  send({ type, ...extra }).catch(() => {});
}

// ─── state rendering ───────────────────────────────────────

function highlight(idx) {
  if (pageTabId == null) return;
  const msg = idx >= 0
    ? { type: 'BRIEFLY_HIGHLIGHT', idx }
    : { type: 'BRIEFLY_CLEAR_HIGHLIGHT' };
  chrome.tabs.sendMessage(pageTabId, msg).catch(() => {});
}

function renderState(s) {
  const status = $('#listenStatus');
  const player = $('#listenPlayer');
  const toggle = $('#playerToggle');
  const labels = {
    idle: 'Idle', loading: 'Synthesizing…', playing: 'Playing',
    paused: 'Paused', done: 'Finished', error: s.error || 'Error'
  };
  status.textContent = labels[s.status] || s.status;

  const active = ['loading', 'playing', 'paused'].includes(s.status);
  player.hidden = !active && s.status !== 'done';
  $('#listenStart').disabled = active || !page;
  toggle.textContent = s.status === 'paused' ? '▶ Resume' : '❚❚ Pause';
  $('#playerDownload').hidden = !s.canExport || (!active && s.status !== 'done');

  if (s.totalSegs > 0 && s.segIndex >= 0) {
    const suffix = s.queueComplete === false ? '+' : '';
    $('#playerSeg').textContent = `${s.segIndex + 1} / ${s.totalSegs}${suffix}`;
    $('#playerBar').value = (s.segIndex + 1) / s.totalSegs;
  }
  const srcIdx = typeof s.srcIdx === 'number' ? s.srcIdx : -1;
  if (srcIdx !== lastSrcIdx) {
    lastSrcIdx = srcIdx;
    highlight(active ? srcIdx : -1);
  }
  if (['done', 'idle', 'error'].includes(s.status)) {
    highlight(-1);
    // Only an error aborts in-flight LLM generation — LISTEN_START itself
    // broadcasts a transient 'idle' that must not cancel its own pipeline.
    if (s.status === 'error') genSession++;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'LISTEN_STATE') renderState(msg);
});

// ─── wiring ────────────────────────────────────────────────

$('#detectPage').addEventListener('click', detectPage);
$('#listenProvider').addEventListener('change', updateCost);
$('#listenLength').addEventListener('change', updateCost);
for (const r of document.querySelectorAll('input[name="listenMode"]')) {
  r.addEventListener('change', updateCost);
}
$('#listenStart').addEventListener('click', start);
$('#playerToggle').addEventListener('click', () => {
  const paused = $('#playerToggle').textContent.includes('Resume');
  sendControl(paused ? 'LISTEN_RESUME' : 'LISTEN_PAUSE');
});
$('#playerStop').addEventListener('click', () => { genSession++; sendControl('LISTEN_STOP'); });
$('#playerDownload').addEventListener('click', async () => {
  const status = $('#listenStatus');
  status.textContent = 'Preparing download…';
  const name = (page?.title || 'briefly-episode').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'briefly-episode';
  const res = await send({ type: 'LISTEN_EXPORT', filename: `${name}.mp3` }).catch((e) => ({ ok: false, error: String(e) }));
  status.textContent = res?.ok ? 'Saved.' : (res?.error || 'Download failed.');
});
$('#playerPrev').addEventListener('click', () => sendControl('LISTEN_SEEK', { delta: -1 }));
$('#playerNext').addEventListener('click', () => sendControl('LISTEN_SEEK', { delta: 1 }));
$('#playerRate').addEventListener('change', () =>
  sendControl('LISTEN_RATE', { rate: Number($('#playerRate').value) || 1 }));

// Replay a "Listened" history entry (dispatched by the history drawer).
// Same segments + same voice settings → IndexedDB cache hits → free + instant.
window.addEventListener('briefly-replay-listen', async (e) => {
  const item = e.detail;
  const h = item?.listen;
  const status = $('#listenStatus');
  if (!h?.segments?.length) { status.textContent = 'This entry has no replayable audio.'; return; }
  genSession++;
  try {
    const provider = h.provider || item.provider;
    const { options, voiceSig } = await buildOptions(provider);
    const hostCfg = h.mode === 'podcast' ? buildHostVoices(provider, { options, voiceSig }) : {};
    // Highlight sync only makes sense if we're still on the same page.
    if (!page || page.url !== h.url) pageTabId = null;
    $('#pageTitle').textContent = h.title || 'Replaying from history';
    $('#pageMeta').textContent = `Replay · ${h.mode} · ${h.segments.length} segments`;
    status.textContent = 'Replaying…';
    await send({ type: 'ENSURE_OFFSCREEN' });
    await send({
      type: 'LISTEN_START',
      title: h.title,
      provider,
      options,
      voiceSig,
      ...hostCfg,
      rate: Number($('#playerRate').value) || 1,
      segments: h.segments
    });
  } catch (err) {
    status.textContent = String(err.message || err);
  }
});

// Re-sync with an already-running player when the panel reopens.
send({ type: 'LISTEN_GET_STATE' })
  .then((s) => { if (s && s.status && s.status !== 'idle') renderState(s); })
  .catch(() => {});
