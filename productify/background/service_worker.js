/**
 * Productify — service_worker.js (MV3 Service Worker)
 * Central message router, API orchestration, offscreen management, and keyboard shortcuts.
 *
 * NOTE: manifest.json has "type": "module" so this is an ES module service worker.
 * Side-effect imports below load intentClassifier and outputRouter into `self.*`.
 */

// Side-effect imports — these files set self.IntentClassifier / self.OutputRouter
import './intentClassifier.js';
import './outputRouter.js';

// ─────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────
const OFFSCREEN_URL = chrome.runtime.getURL('offscreen/offscreen.html');

let pendingAudioResolve = null;
let currentTabId = null;
let pendingRecordingMode = 'default';
// Per-tab session state
// Shape: { lastTranscript: string | null, lastOutput: string | null, lastContext: object | null }
const tabSessions = new Map();

function getOrCreateSession(tabId) {
  if (tabId == null) {
    return { lastTranscript: null, lastOutput: null, lastContext: null };
  }
  if (!tabSessions.has(tabId)) {
    tabSessions.set(tabId, { lastTranscript: null, lastOutput: null, lastContext: null });
  }
  return tabSessions.get(tabId);
}

function updateSession(tabId, patch) {
  if (tabId == null) return;
  const session = getOrCreateSession(tabId);
  Object.assign(session, patch);
}

// ─────────────────────────────────────────────────────────────────
// LIFECYCLE
// ─────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    // Open onboarding on first install
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
  }
  // Set default settings
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) {
    await chrome.storage.local.set({
      settings: {
        sttProvider: 'whisper',
        language: 'auto',
        tone: 'auto',
        outputFormat: 'markdown',
        theme: 'dark',
        activeTemplate: 'general_assistant',
        usePageContext: true,
        selectionOnly: false,
        redactSensitive: true,
        reviewBeforeSend: true,
        webhookUrl: ''
      }
    });
  }
});

// Open side panel when action clicked
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
  currentTabId = tab.id;
});

// ─────────────────────────────────────────────────────────────────
// KEYBOARD SHORTCUTS
// ─────────────────────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command, tab) => {
  switch (command) {
    case 'push-to-talk':
      broadcastToPanel({ type: 'SHORTCUT_PUSH_TO_TALK' });
      break;
    case 'copy-last-output':
      broadcastToPanel({ type: 'SHORTCUT_COPY' });
      break;
    case 'toggle-history':
      broadcastToPanel({ type: 'SHORTCUT_HISTORY' });
      break;
    case 'retry-last':
      broadcastToPanel({ type: 'SHORTCUT_RETRY' });
      break;
  }
});

// ─────────────────────────────────────────────────────────────────
// MAIN MESSAGE ROUTER
// ─────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender, sendResponse);
  return true; // Keep channel open for async
});

async function handleMessage(msg, sender, sendResponse) {
  try {
    switch (msg.type) {
      // ── RECORDING ──
      case 'START_RECORDING': {
        pendingRecordingMode = msg.config?.mode || 'default';
        await ensureOffscreen();
        await chrome.runtime.sendMessage({ type: 'START_RECORDING', config: msg.config });
        sendResponse({ success: true });
        break;
      }
      case 'STOP_RECORDING': {
        await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
        sendResponse({ success: true });
        break;
      }
      case 'CANCEL_RECORDING': {
        pendingRecordingMode = 'default';
        await chrome.runtime.sendMessage({ type: 'CANCEL_RECORDING' });
        sendResponse({ success: true });
        break;
      }

      // ── FROM OFFSCREEN ──
      case 'RECORDING_STARTED':
        broadcastToPanel({ type: 'RECORDING_STARTED' });
        sendResponse({ success: true });
        break;
      case 'RECORDING_CANCELLED':
        pendingRecordingMode = 'default';
        broadcastToPanel({ type: 'RECORDING_CANCELLED' });
        sendResponse({ success: true });
        break;
      case 'AUDIO_TOO_SHORT':
        pendingRecordingMode = 'default';
        broadcastToPanel({ type: 'ERROR', error: 'empty_transcript', message: "Didn't catch that" });
        sendResponse({ success: true });
        break;
      case 'RECORDING_ERROR':
        pendingRecordingMode = 'default';
        broadcastToPanel({ type: 'ERROR', error: msg.error, message: msg.message });
        sendResponse({ success: true });
        break;
      case 'WAVEFORM_DATA':
        broadcastToPanel({ type: 'WAVEFORM_DATA', data: msg.data });
        sendResponse({ success: true });
        break;
      case 'AUDIO_READY': {
        broadcastToPanel({ type: 'STATE_TRANSCRIBING' });
        try {
          const transcript = await transcribeAudio(msg.audioData, msg.mimeType);
          // Get page context
          const context = await getPageContext();
          const tabId = currentTabId;
          broadcastToPanel({ type: 'TRANSCRIPT_READY', transcript });
          const recordingMode = pendingRecordingMode;
          pendingRecordingMode = 'default';

          if (recordingMode === 'refine') {
            const session = getOrCreateSession(tabId);
            if (session.lastOutput) {
              updateSession(tabId, { lastContext: session.lastContext || context });
              await refineOutput({
                refinement: transcript,
                previousOutput: session.lastOutput,
                context: session.lastContext || context,
                transcript: session.lastTranscript,
                tabId
              });
              break;
            }
          }

          updateSession(tabId, { lastTranscript: transcript, lastContext: context });
          // Local intent pre-classification
          const localIntent = self.IntentClassifier?.classify(transcript) || { primary_intent: 'custom', confidence: 0.5 };
          broadcastToPanel({ type: 'INTENT_LOCAL', intent: localIntent });
          // Full generation
          await processTranscript({ transcript, context, localIntent, tabId });
          sendResponse({ success: true });
        } catch (err) {
          pendingRecordingMode = 'default';
          broadcastToPanel({ type: 'ERROR', error: 'api_error', message: err.message });
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      // ── PROCESS / REFINE ──
      case 'PROCESS_TEXT': {
        broadcastToPanel({ type: 'STATE_GENERATING' });
        try {
          const context = await getPageContext();
          const tabId = msg.tabId ?? currentTabId;
          updateSession(tabId, { lastTranscript: msg.text, lastContext: context });
          await processTranscript({ transcript: msg.text, context, localIntent: null, overrideIntent: msg.intent, tabId });
          sendResponse({ success: true });
        } catch (err) {
          broadcastToPanel({ type: 'ERROR', error: 'api_error', message: err.message });
          sendResponse({ success: false, error: err.message });
        }
        break;
      }
      case 'REFINE_OUTPUT': {
        broadcastToPanel({ type: 'STATE_GENERATING' });
        try {
          const tabId = msg.tabId ?? currentTabId;
          const session = getOrCreateSession(tabId);
          await refineOutput({
            refinement: msg.refinement,
            previousOutput: session.lastOutput,
            context: session.lastContext,
            transcript: session.lastTranscript,
            tabId
          });
          sendResponse({ success: true });
        } catch (err) {
          broadcastToPanel({ type: 'ERROR', error: 'api_error', message: err.message });
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      // ── INTEGRATIONS ──
      case 'ROUTE_OUTPUT': {
        broadcastToPanel({ type: 'STATE_ROUTING', target: msg.target });
        try {
          const tabId = msg.tabId ?? currentTabId;
          const session = getOrCreateSession(tabId);
          const result = await self.OutputRouter.route(msg.target, session.lastOutput, session.lastContext, tabId);
          broadcastToPanel({ type: 'ROUTE_SUCCESS', result, target: msg.target });
          sendResponse({ success: true, result });
        } catch (err) {
          broadcastToPanel({ type: 'ERROR', error: 'integration_error', message: err.message });
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      // ── SETTINGS ──
      case 'SAVE_SETTINGS': {
        await chrome.storage.local.set({ settings: msg.settings });
        sendResponse({ success: true });
        break;
      }
      case 'GET_SETTINGS': {
        const { settings } = await chrome.storage.local.get('settings');
        sendResponse({ success: true, settings });
        break;
      }
      case 'STORE_KEYS': {
        // Encrypt and store API keys
        await encryptAndStoreKeys(msg.keys);
        sendResponse({ success: true });
        break;
      }

      // ── CONTEXT ──
      case 'GET_PAGE_CONTEXT': {
        const context = await getPageContext();
        sendResponse({ success: true, context });
        break;
      }
      case 'SYNC_SESSION': {
        updateSession(msg.tabId ?? currentTabId, {
          lastTranscript: msg.transcript ?? null,
          lastOutput: msg.output ?? null,
          lastContext: msg.context ?? null
        });
        sendResponse({ success: true });
        break;
      }

      default:
        sendResponse({ success: false, error: `Unknown message type: ${msg.type}` });
    }
  } catch (err) {
    console.error('[Productify SW] Error:', err);
    sendResponse({ success: false, error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────
// API FUNCTIONS
// ─────────────────────────────────────────────────────────────────
async function getDecryptedKey(name) {
  const { encryptedKeys = {}, cryptoKeyRaw } = await chrome.storage.local.get(['encryptedKeys', 'cryptoKeyRaw']);
  const encrypted = encryptedKeys[name];
  if (!encrypted || !cryptoKeyRaw) return '';
  try {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(cryptoKeyRaw), { name: 'AES-GCM' }, false, ['decrypt']);
    const combined = new Uint8Array(atob(encrypted).split('').map(c => c.charCodeAt(0)));
    const iv = combined.slice(0, 12);
    const ct = combined.slice(12);
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(dec);
  } catch { return ''; }
}

async function transcribeAudio(audioDataUrl, mimeType) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  
  // Convert data URL to blob
  const base64 = audioDataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const audioBlob = new Blob([bytes], { type: mimeType });

  const openaiKey = await getDecryptedKey('openai');
  const googleKey = await getDecryptedKey('googleStt');
  const elevenKey = await getDecryptedKey('elevenStt');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const provider = settings.sttProvider || 'whisper';
    let transcript = '';

    if (provider === 'google' && googleKey) {
      transcript = await transcribeWithGoogleStt(audioBlob, mimeType, googleKey, settings.language || 'auto', controller.signal);
    } else if (provider === 'elevenlabs' && elevenKey) {
      transcript = await transcribeWithElevenLabs(audioBlob, mimeType, elevenKey, settings.language || 'auto', controller.signal);
    } else {
      // Default to OpenAI transcription
      if (!openaiKey) throw new Error('OpenAI API key required for transcription.');
      transcript = await transcribeWithOpenAI(audioBlob, openaiKey, settings.language || 'auto', controller.signal);
    }

    clearTimeout(timeout);
    return transcript;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('Transcription timed out. Try again.');
    throw err;
  }
}

async function processTranscript({ transcript, context, localIntent, overrideIntent, tabId }) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const openaiKey = await getDecryptedKey('openai');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    if (!openaiKey) throw new Error('OpenAI API key required for processing.');

    const intent = overrideIntent || localIntent?.primary_intent || 'custom';
    const tone = settings.tone || 'auto';
    const outputFormat = settings.outputFormat || 'markdown';
    const templateId = settings.activeTemplate || 'general_assistant';

    const systemPrompt = buildSystemPrompt(intent, tone, outputFormat, templateId);
    const userMessage = buildUserMessage(transcript, context, settings);

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.7,
        max_tokens: 2000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ]
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error?.message || err.error || `Processing failed: ${res.status}`);
    }

    const data = await res.json();
    const fullOutput = data.choices?.[0]?.message?.content || '';

    if (fullOutput) {
      broadcastToPanel({ type: 'STREAM_CHUNK', text: fullOutput });
      broadcastToPanel({ type: 'GENERATION_COMPLETE', output: fullOutput });
      updateSession(tabId, { lastOutput: fullOutput });
      await saveToHistory({
        transcript,
        output: fullOutput,
        context,
        intent: intent,
        templateId
      });
    }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('Generation timed out. Try again.');
    throw err;
  }
}

async function refineOutput({ refinement, previousOutput, context, transcript, tabId }) {
  const openaiKey = await getDecryptedKey('openai');
  if (!openaiKey) throw new Error('OpenAI API key required for refinement.');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openaiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      max_tokens: 2000,
      messages: [
        {
          role: 'system',
          content: 'You are a helpful AI assistant that refines and improves previously generated content based on user feedback. Maintain the same format and style unless asked to change it.'
        },
        { role: 'user', content: `Original request / context: "${transcript || 'unknown'}"\n\nPage context (optional): ${JSON.stringify(context || {}, null, 2)}` },
        { role: 'assistant', content: previousOutput || '' },
        { role: 'user', content: refinement ? `Please refine: ${refinement}` : 'Please improve this output.' }
      ]
    })
  });

  if (!res.ok) throw new Error(`Refine failed: ${res.status}`);

  const data = await res.json();
  const fullOutput = data.choices?.[0]?.message?.content || '';

  if (fullOutput) {
    broadcastToPanel({ type: 'STREAM_CHUNK', text: fullOutput });
    broadcastToPanel({ type: 'GENERATION_COMPLETE', output: fullOutput });
    updateSession(tabId, { lastOutput: fullOutput });
  }
}

// ─────────────────────────────────────────────────────────────────
// LOCAL PROMPTS (client-side)
// ─────────────────────────────────────────────────────────────────
function buildSystemPrompt(intent, tone, outputFormat, templateId) {
  const baseByIntent = {
    summarize: 'You summarize content into clear, concise bullet points and sections.',
    prompt_generation: 'You turn user ideas into high quality, copy-pastable prompts for powerful LLMs.',
    task_extraction: 'You extract actionable tasks, with clear owners and priorities, from the given content.',
    documentation: 'You write clean, structured technical documentation and README-style guides.',
    testing: 'You design test cases, scenarios, and edge cases for the described feature or code.',
    code_review: 'You perform code reviews, highlight issues, and suggest improvements.',
    user_story: 'You convert ideas into user stories with acceptance criteria.',
    explain: 'You explain concepts step by step in simple language.',
    translate_intent: 'You translate the content while preserving meaning and tone.',
    email_draft: 'You draft professional, well-structured emails based on the content.',
    compare: 'You compare options, listing pros/cons and a recommendation.',
    custom: 'You are a versatile assistant that follows the user instructions precisely.'
  };

  const base = baseByIntent[intent] || baseByIntent.custom;
  const templateNote = buildTemplateInstruction(templateId);
  const toneNote = tone && tone !== 'auto' ? ` Tone: ${tone}.` : '';
  const formatNote =
    outputFormat === 'plain'
      ? ' Respond in clear plain text, no markdown.'
      : outputFormat === 'structured'
      ? ' Prefer structured output with headings, bullet lists, and tables where helpful.'
      : ' Respond in well-formatted Markdown suitable for docs or notes.';

  return `${base}${templateNote}${toneNote}${formatNote}`;
}

function buildTemplateInstruction(templateId) {
  const templateInstructions = {
    general_assistant: ' Act like a strong browser copilot. Use the page context when it improves the answer and call out assumptions when context is incomplete.',
    bug_report: ' Produce a bug report with sections for summary, impact, steps to reproduce, expected result, actual result, likely cause, environment, and open questions.',
    pr_review: ' Review the material like a pull request. Lead with concrete findings, risks, regressions, and missing tests. Keep summaries brief.',
    test_plan: ' Produce a QA test plan with objectives, happy paths, edge cases, negative cases, automation candidates, and data/setup needs.',
    product_spec: ' Produce a product spec with problem, users, goals, non-goals, flows, edge cases, dependencies, launch risks, and success metrics.',
    release_notes: ' Produce release notes with a crisp headline, customer-facing highlights, operational notes, risks, and rollout/follow-up items.',
    customer_reply: ' Draft a concise, empathetic customer-facing response with next steps and a clear ask if more information is needed.'
  };

  return templateInstructions[templateId] || templateInstructions.general_assistant;
}

function buildUserMessage(transcript, context, settings = {}) {
  const sanitizedContext = sanitizePromptContext(context, settings);
  const parts = [`User voice command or input:\n"${transcript}"`];
  if (sanitizedContext?.selectedText) {
    parts.push(`\nSelected text on page:\n"""\n${sanitizedContext.selectedText.slice(0, 1500)}\n"""`);
  }
  if (sanitizedContext?.visibleText && !sanitizedContext.selectedText) {
    parts.push(`\nVisible page content (truncated):\n${sanitizedContext.visibleText.slice(0, 2000)}`);
  }
  if (sanitizedContext?.codeBlocks?.length) {
    const code = sanitizedContext.codeBlocks.map(b => `[${b.lang}]\n${b.code}`).join('\n\n');
    parts.push(`\nCode snippets on page:\n\`\`\`\n${code.slice(0, 2000)}\n\`\`\``);
  }
  if (sanitizedContext?.headings?.length) {
    parts.push(`\nPage headings: ${sanitizedContext.headings.map(h => h.text).join(' > ')}`);
  }
  if (sanitizedContext?.formFields?.length) {
    const fieldSummary = sanitizedContext.formFields
      .map(field => `${field.label || field.type}: ${field.value}`)
      .join(' | ');
    parts.push(`\nRelevant form fields: ${fieldSummary.slice(0, 1200)}`);
  }
  if (sanitizedContext?.pageType && sanitizedContext.pageType !== 'general') {
    parts.push(`\nDetected page type: ${sanitizedContext.pageType}`);
  }
  if (sanitizedContext?.pageTitle) parts.push(`\nPage title: ${sanitizedContext.pageTitle}`);
  if (sanitizedContext?.url) parts.push(`\nURL: ${sanitizedContext.url}`);
  if (settings.redactSensitive) {
    parts.push('\nSensitive strings have been redacted before sending this context.');
  }
  return parts.join('\n');
}

function sanitizePromptContext(context = {}, settings = {}) {
  const usePageContext = settings.usePageContext !== false;
  const selectionOnly = settings.selectionOnly === true;
  const redactSensitive = settings.redactSensitive !== false;

  if (!usePageContext) {
    return {};
  }

  const sanitized = {
    pageTitle: context.pageTitle || '',
    url: context.url || '',
    pageType: context.pageType || 'general',
    selectedText: context.selectedText || '',
    visibleText: selectionOnly ? '' : (context.visibleText || ''),
    codeBlocks: selectionOnly ? [] : (context.codeBlocks || []),
    headings: selectionOnly ? [] : (context.headings || []),
    formFields: selectionOnly ? [] : (context.formFields || [])
  };

  if (selectionOnly && !sanitized.selectedText) {
    sanitized.visibleText = (context.visibleText || '').slice(0, 1200);
  }

  return redactSensitive ? redactContextObject(sanitized) : sanitized;
}

function redactContextObject(value) {
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactContextObject);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, redactContextObject(val)]));
  }

  return value;
}

function redactSensitiveText(text) {
  if (!text) return text;

  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/\b(sk|rk|pk|ghp|gho|ghu|AIza|xoxb|xoxp|xoxe|xoxr|lin_api)_[A-Za-z0-9_\-]{8,}\b/g, '[redacted-key]')
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9-_]{24,}\.[A-Za-z0-9-_]{12,}\.[A-Za-z0-9-_]{12,}\b/g, '[redacted-token]')
    .replace(/\b\d{12,19}\b/g, '[redacted-number]');
}

async function transcribeWithOpenAI(audioBlob, apiKey, language, signal) {
  const formData = new FormData();
  formData.append('file', audioBlob, 'recording.webm');
  const model = 'gpt-4o-mini-transcribe';
  formData.append('model', model);
  if (language && language !== 'auto') {
    formData.append('language', language);
  }

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`
    },
    body: formData,
    signal
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI transcription error: ${res.status}`);
  }
  const data = await res.json();
  return data.text || '';
}

async function transcribeWithGoogleStt(audioBlob, mimeType, apiKey, language, signal) {
  const arrayBuffer = await audioBlob.arrayBuffer();
  const body = {
    config: {
      encoding: mimeType && mimeType.includes('webm') ? 'WEBM_OPUS' : 'LINEAR16',
      sampleRateHertz: 16000,
      languageCode: language === 'auto' ? 'en-US' : language,
      enableAutomaticPunctuation: true,
      model: 'latest_long'
    },
    audio: { content: btoa(String.fromCharCode(...new Uint8Array(arrayBuffer))) }
  };

  const res = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Google STT error: ${res.status}`);
  }
  const data = await res.json();
  return (
    data.results
      ?.map(r => r.alternatives?.[0]?.transcript || '')
      .join(' ')
      .trim() || ''
  );
}

async function transcribeWithElevenLabs(audioBlob, mimeType, apiKey, language, signal) {
  const formData = new FormData();
  formData.append('file', audioBlob, 'recording.webm');
  formData.append('model_id', 'scribe_v2');
  if (language && language !== 'auto') {
    formData.append('language_code', language);
  }

  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey
    },
    body: formData,
    signal
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let parsed;
    try {
      parsed = errText ? JSON.parse(errText) : {};
    } catch {
      parsed = {};
    }
    const message =
      parsed.error ||
      parsed.message ||
      parsed.detail?.message ||
      parsed.detail ||
      errText ||
      `ElevenLabs STT error: ${res.status}`;
    throw new Error(message);
  }

  const data = await res.json();
  return data.text || data.transcript || '';
}

async function getPageContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return {};
    currentTabId = tab.id;
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_CONTEXT' });
    return response?.context || {};
  } catch {
    return {};
  }
}

async function saveToHistory(entry) {
  try {
    const { history = [] } = await chrome.storage.local.get('history');
    const newEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      timestamp: Date.now(),
      ...entry
    };
    const updated = [newEntry, ...history].slice(0, 50);
    await chrome.storage.local.set({ history: updated });
    broadcastToPanel({ type: 'HISTORY_UPDATED', count: updated.length });
  } catch (err) {
    console.warn('[Productify SW] Failed to save history:', err);
  }
}

async function encryptAndStoreKeys(rawKeys) {
  const { cryptoKeyRaw } = await chrome.storage.local.get('cryptoKeyRaw');
  let keyBytes = cryptoKeyRaw;
  if (!keyBytes) {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    keyBytes = Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
    await chrome.storage.local.set({ cryptoKeyRaw: keyBytes });
  }
  const cryptoKey = await crypto.subtle.importKey('raw', new Uint8Array(keyBytes), { name: 'AES-GCM' }, false, ['encrypt']);
  const { encryptedKeys = {} } = await chrome.storage.local.get('encryptedKeys');
  for (const [name, value] of Object.entries(rawKeys)) {
    if (!value) continue;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(value);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
    const combined = new Uint8Array(iv.length + ct.byteLength);
    combined.set(iv); combined.set(new Uint8Array(ct), iv.length);
    encryptedKeys[name] = btoa(String.fromCharCode(...combined));
  }
  await chrome.storage.local.set({ encryptedKeys });
}

// ─────────────────────────────────────────────────────────────────
// OFFSCREEN DOCUMENT MANAGEMENT
// ─────────────────────────────────────────────────────────────────
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Productify needs microphone access for voice recording.'
  });
}

// ─────────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────────
function broadcastToPanel(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // Side panel might not be open — ignore
  });
}
