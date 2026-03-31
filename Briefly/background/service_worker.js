/**
 * Briefly — service_worker.js (MV3 Service Worker)
 * Central message router, API orchestration, offscreen management, and keyboard shortcuts.
 *
 * NOTE: manifest.json has "type": "module" so this is an ES module service worker.
 * Side-effect imports below load intentClassifier and outputRouter into `self.*`.
 */

// Side-effect imports — these files set self.IntentClassifier / self.OutputRouter
import './intentClassifier.js';
import './outputRouter.js';
import {
  DEFAULT_CONTEXT_SIGNAL_PREFS,
  DEFAULT_SETTINGS,
  normalizeSettings,
  summarizeRecentTurns,
  appendRecentTurn,
  resolveModelPlan,
  getProviderConfig,
  estimateCost,
  estimateTokenCount,
  budgetContextTokens,
  getSignalPriority
} from './modelUtils.mjs';

// ─────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────
const OFFSCREEN_URL = chrome.runtime.getURL('offscreen/offscreen.html');
const PERSISTED_SESSION_KEY = 'tabSessions';

let pendingAudioResolve = null;
let currentTabId = null;
let pendingRecordingMode = 'default';
let sessionsLoaded = false;
let sessionsPersistTimer = null;
// Per-tab session state
// Shape: { lastTranscript, lastRefinement, lastOutput, lastContext, lastIntent, lastTemplateId, recentTurns }
const tabSessions = new Map();

function getOrCreateSession(tabId) {
  if (tabId == null) {
    return { lastTranscript: null, lastRefinement: null, lastOutput: null, lastContext: null, lastIntent: null, lastTemplateId: null, recentTurns: [] };
  }
  if (!tabSessions.has(tabId)) {
    tabSessions.set(tabId, { lastTranscript: null, lastRefinement: null, lastOutput: null, lastContext: null, lastIntent: null, lastTemplateId: null, recentTurns: [] });
  }
  return tabSessions.get(tabId);
}

function updateSession(tabId, patch) {
  if (tabId == null) return;
  const session = getOrCreateSession(tabId);
  Object.assign(session, patch);
  schedulePersistSessions();
}

function normalizeSession(session = {}) {
  return {
    lastTranscript: session.lastTranscript || null,
    lastRefinement: session.lastRefinement || null,
    lastOutput: session.lastOutput || null,
    lastContext: session.lastContext || null,
    lastIntent: session.lastIntent || null,
    lastTemplateId: session.lastTemplateId || null,
    recentTurns: Array.isArray(session.recentTurns) ? session.recentTurns.slice(-4) : []
  };
}

async function ensureSessionsLoaded() {
  if (sessionsLoaded) return;
  const stored = await chrome.storage.local.get(PERSISTED_SESSION_KEY);
  const serialized = stored[PERSISTED_SESSION_KEY] || {};
  tabSessions.clear();
  Object.entries(serialized).forEach(([tabId, session]) => {
    const numericTabId = Number(tabId);
    if (Number.isFinite(numericTabId)) {
      tabSessions.set(numericTabId, normalizeSession(session));
    }
  });
  sessionsLoaded = true;
}

function schedulePersistSessions() {
  if (!sessionsLoaded) return;
  if (sessionsPersistTimer) clearTimeout(sessionsPersistTimer);
  sessionsPersistTimer = setTimeout(() => {
    persistSessions().catch(err => {
      console.warn('[Briefly SW] Failed to persist sessions:', err);
    });
  }, 120);
}

async function persistSessions() {
  const serialized = Object.fromEntries(
    Array.from(tabSessions.entries()).map(([tabId, session]) => [String(tabId), normalizeSession(session)])
  );
  await chrome.storage.local.set({ [PERSISTED_SESSION_KEY]: serialized });
}

function clearSession(tabId) {
  if (tabId == null) return;
  tabSessions.delete(tabId);
  schedulePersistSessions();
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
      settings: normalizeSettings()
    });
  }
});

// Open side panel when action clicked
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
  currentTabId = tab.id;
});

chrome.tabs.onRemoved.addListener(tabId => {
  ensureSessionsLoaded()
    .then(() => clearSession(tabId))
    .catch(() => {});
});

// Autorefresh context when user switches tab or navigates
chrome.tabs.onActivated.addListener(({ tabId }) => {
  currentTabId = tabId;
  broadcastToPanel({ type: 'TAB_CHANGED', tabId });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) {
    broadcastToPanel({ type: 'TAB_NAVIGATED', tabId, url: tab.url });
  }
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
    await ensureSessionsLoaded();
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
        const totalSegments = msg.audioSegments?.length || (msg.audioData ? 1 : 0);
        broadcastToPanel({ type: 'STATE_TRANSCRIBING', totalSegments });
        try {
          const transcript = await transcribeAudioSegments(
            msg.audioSegments?.length
              ? msg.audioSegments
              : [{ audioData: msg.audioData, mimeType: msg.mimeType }]
          );
          if (!transcript.trim()) {
            throw new Error("Didn't catch that");
          }
          // Get page context
          const context = await getPageContext({ includeScreenshot: true });
          const tabId = currentTabId;
          broadcastToPanel({ type: 'TRANSCRIPT_READY', transcript });
          const recordingMode = pendingRecordingMode;
          pendingRecordingMode = 'default';

          if (recordingMode === 'refine') {
            const session = getOrCreateSession(tabId);
            if (session.lastOutput) {
              updateSession(tabId, { lastContext: session.lastContext || context, lastRefinement: transcript });
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

          updateSession(tabId, { lastTranscript: transcript, lastRefinement: null, lastContext: stripEphemeralContext(context) });
          // Local intent pre-classification
          const localIntent = self.IntentClassifier?.classify(transcript) || { primary_intent: 'custom', confidence: 0.5 };
          broadcastToPanel({ type: 'INTENT_LOCAL', intent: localIntent });
          // Full generation
          await processTranscript({ transcript, context, localIntent, tabId });
          sendResponse({ success: true });
        } catch (err) {
          pendingRecordingMode = 'default';
          const isEmptyTranscript = err.message === "Didn't catch that";
          broadcastToPanel({
            type: 'ERROR',
            error: isEmptyTranscript ? 'empty_transcript' : 'api_error',
            message: err.message
          });
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      // ── PROCESS / REFINE ──
      case 'PROCESS_TEXT': {
        broadcastToPanel({ type: 'STATE_GENERATING' });
        try {
          const context = await getPageContext({ includeScreenshot: true });
          const tabId = msg.tabId ?? currentTabId;
          updateSession(tabId, { lastTranscript: msg.text, lastRefinement: null, lastContext: stripEphemeralContext(context) });
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
          const result = await self.OutputRouter.route(msg.target, session.lastOutput, session.lastContext, tabId, msg.options || {});
          broadcastToPanel({ type: 'ROUTE_SUCCESS', result, target: msg.target });
          notifyUser('Briefly delivery complete', result?.message || `Sent to ${msg.target}`).catch(() => {});
          sendResponse({ success: true, result });
        } catch (err) {
          broadcastToPanel({ type: 'ERROR', error: 'integration_error', message: err.message });
          notifyUser('Briefly delivery failed', err.message || 'The destination rejected the payload.').catch(() => {});
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

      // ── USAGE / COST ──
      case 'GET_USAGE': {
        const [{ usageTotals = {} }, { usageLog = [] }] = await Promise.all([
          chrome.storage.local.get('usageTotals'),
          chrome.storage.local.get('usageLog')
        ]);
        sendResponse({ success: true, totals: usageTotals, log: usageLog.slice(0, 100) });
        break;
      }
      case 'CLEAR_USAGE': {
        await chrome.storage.local.set({ usageLog: [], usageTotals: { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, monthStart: getMonthStart() } });
        sendResponse({ success: true });
        break;
      }
      // ── FEEDBACK ──
      case 'SAVE_FEEDBACK': {
        const { feedbackLog = [] } = await chrome.storage.local.get('feedbackLog');
        const feedbackEntry = { id: Date.now().toString(36), timestamp: Date.now(), ...msg.feedback };
        await chrome.storage.local.set({ feedbackLog: [feedbackEntry, ...feedbackLog].slice(0, 500) });
        sendResponse({ success: true });
        break;
      }
      case 'GET_FEEDBACK': {
        const { feedbackLog = [] } = await chrome.storage.local.get('feedbackLog');
        sendResponse({ success: true, feedback: feedbackLog });
        break;
      }
      // ── GITHUB DEVICE FLOW ──
      case 'GITHUB_DEVICE_FLOW_START': {
        const { oauthClients = {} } = await chrome.storage.local.get('oauthClients');
        const clientId = oauthClients.github?.clientId;
        if (!clientId) {
          sendResponse({ success: false, error: 'GitHub OAuth App client ID not configured. Go to Settings → Integrations to add it.' });
          break;
        }
        const deviceRes = await fetch('https://github.com/login/device/code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ client_id: clientId, scope: 'repo read:org' })
        });
        if (!deviceRes.ok) {
          sendResponse({ success: false, error: `GitHub Device Flow request failed: ${deviceRes.status}` });
          break;
        }
        const deviceData = await deviceRes.json();
        sendResponse({
          success: true,
          userCode: deviceData.user_code,
          verificationUri: deviceData.verification_uri || 'https://github.com/login/device',
          deviceCode: deviceData.device_code,
          expiresIn: deviceData.expires_in || 900,
          interval: deviceData.interval || 5
        });
        break;
      }
      case 'GITHUB_DEVICE_FLOW_POLL': {
        const { oauthClients: oc = {} } = await chrome.storage.local.get('oauthClients');
        const pollClientId = oc.github?.clientId;
        if (!pollClientId || !msg.deviceCode) {
          sendResponse({ success: false, error: 'Missing client ID or device code.' });
          break;
        }
        const pollRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            client_id: pollClientId,
            device_code: msg.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          })
        });
        const pollData = await pollRes.json();
        if (pollData.access_token) {
          await encryptAndStoreKeys({ github: pollData.access_token });
          sendResponse({ success: true, status: 'authorized' });
        } else {
          sendResponse({ success: true, status: pollData.error || 'authorization_pending' });
        }
        break;
      }
      // ── REGENERATE WITH DIFFERENT MODEL ──
      case 'REGENERATE': {
        broadcastToPanel({ type: 'STATE_GENERATING' });
        try {
          const regenTabId = msg.tabId ?? currentTabId;
          const session = getOrCreateSession(regenTabId);
          if (!session.lastTranscript) throw new Error('No previous request to regenerate.');
          const regenContext = session.lastContext || await getPageContext({ includeScreenshot: false });
          const regenSettings = normalizeSettings({ ...(await chrome.storage.local.get('settings')).settings, ...msg.overrides });
          const regenIntent = self.IntentClassifier?.classify(session.lastTranscript) || { primary_intent: 'custom', confidence: 0.5 };
          await processTranscript({ transcript: session.lastTranscript, context: regenContext, localIntent: regenIntent, tabId: regenTabId });
          sendResponse({ success: true });
        } catch (err) {
          broadcastToPanel({ type: 'ERROR', error: 'api_error', message: err.message });
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      // ── CONTEXT ──
      case 'GET_PAGE_CONTEXT': {
        const context = await getPageContext({ includeScreenshot: msg.includeScreenshot === true });
        sendResponse({ success: true, context });
        break;
      }
      case 'GET_PAGE_ACTIONS': {
        const actions = await getPageActions();
        sendResponse({ success: true, actions });
        break;
      }
      case 'SYNC_SESSION': {
        updateSession(msg.tabId ?? currentTabId, {
          lastTranscript: msg.transcript ?? null,
          lastRefinement: msg.refinement ?? null,
          lastOutput: msg.output ?? null,
          lastContext: stripEphemeralContext(msg.context ?? null)
        });
        sendResponse({ success: true });
        break;
      }
      case 'GET_SESSION': {
        sendResponse({ success: true, session: normalizeSession(getOrCreateSession(msg.tabId ?? currentTabId)) });
        break;
      }

      default:
        sendResponse({ success: false, error: `Unknown message type: ${msg.type}` });
    }
  } catch (err) {
    console.error('[Briefly SW] Error:', err);
    sendResponse({ success: false, error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────
// API FUNCTIONS
// ─────────────────────────────────────────────────────────────────
async function getDecryptedKey(name) {
  const { encryptedKeys = {} } = await chrome.storage.local.get('encryptedKeys');
  const encrypted = encryptedKeys[name];
  if (!encrypted) return '';

  // Try session storage first (ephemeral key), then fall back to local
  let cryptoKeyRaw;
  if (chrome.storage.session) {
    const session = await chrome.storage.session.get('cryptoKeyRaw');
    cryptoKeyRaw = session.cryptoKeyRaw;
  }
  if (!cryptoKeyRaw) {
    const local = await chrome.storage.local.get('cryptoKeyRaw');
    cryptoKeyRaw = local.cryptoKeyRaw;
    // Migrate to session if available
    if (cryptoKeyRaw && chrome.storage.session) {
      await chrome.storage.session.set({ cryptoKeyRaw });
      await chrome.storage.local.remove('cryptoKeyRaw');
    }
  }
  if (!cryptoKeyRaw) return '';

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
  const normalizedSettings = normalizeSettings(settings);
  
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
    const provider = normalizedSettings.sttProvider || 'whisper';
    let transcript = '';

    if (provider === 'google' && googleKey) {
      transcript = await transcribeWithGoogleStt(audioBlob, mimeType, googleKey, normalizedSettings.language || 'auto', controller.signal);
    } else if (provider === 'elevenlabs' && elevenKey) {
      transcript = await transcribeWithElevenLabs(audioBlob, mimeType, elevenKey, normalizedSettings.language || 'auto', controller.signal);
    } else {
      // Default to OpenAI transcription
      if (!openaiKey) throw new Error('OpenAI API key required for transcription.');
      transcript = await transcribeWithOpenAI(audioBlob, openaiKey, normalizedSettings.language || 'auto', controller.signal);
    }

    clearTimeout(timeout);
    return transcript;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('Transcription timed out. Try again.');
    throw err;
  }
}

async function transcribeAudioSegments(audioSegments = []) {
  const segments = audioSegments.filter(segment => segment?.audioData);
  if (!segments.length) return '';

  const transcriptParts = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const transcript = (await transcribeAudio(segment.audioData, segment.mimeType)).trim();
    if (transcript) transcriptParts.push(transcript);
    broadcastToPanel({
      type: 'TRANSCRIPT_PROGRESS',
      transcript: transcriptParts.join(' ').trim(),
      completedSegments: index + 1,
      totalSegments: segments.length
    });
  }

  return transcriptParts.join(' ').trim();
}

async function processTranscript({ transcript, context, localIntent, overrideIntent, tabId }) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const normalizedSettings = normalizeSettings(settings);
  const llmProvider = normalizedSettings.llmProvider || 'openai';
  const providerConfig = getProviderConfig(llmProvider);
  const apiKey = providerConfig.keyName ? await getDecryptedKey(providerConfig.keyName) : null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    if (providerConfig.keyName && !apiKey) {
      throw new Error(`${providerConfig.label} API key required for processing. Add it in Settings.`);
    }

    const session = getOrCreateSession(tabId);
    const intent = overrideIntent || localIntent?.primary_intent || 'custom';
    const tone = normalizedSettings.tone || 'auto';
    const outputFormat = normalizedSettings.outputFormat || 'markdown';
    const templateId = normalizedSettings.activeTemplate || 'general_assistant';
    const modelPlan = resolveModelPlan({
      settings: normalizedSettings,
      templateId,
      intent,
      hasScreenshot: Boolean(context?.screenshotDataUrl)
    });

    // Load recent feedback preferences to tune the prompt
    const feedbackPreferences = await loadFeedbackPreferences();
    const systemPrompt = buildSystemPrompt(intent, tone, outputFormat, templateId, normalizedSettings, {
      hasScreenshot: Boolean(context?.screenshotDataUrl),
      hasRecentTurns: normalizedSettings.threadMemory !== false && session.recentTurns?.length > 0,
      feedbackPreferences
    });
    const userMessage = buildUserMessagePayload(transcript, context, normalizedSettings, session, intent);

    const inputTokenEstimate = estimateTokenCount(systemPrompt + (typeof userMessage === 'string' ? userMessage : JSON.stringify(userMessage)));

    let generationResult;
    if (context?.contextSource === 'internet' && llmProvider === 'openai') {
      const output = await generateInternetSearchOutput({
        apiKey, transcript, context, settings: normalizedSettings, session, systemPrompt, signal: controller.signal
      });
      generationResult = { output, inputTokens: null, outputTokens: null };
    } else {
      generationResult = await generateWithProvider({
        provider: llmProvider,
        apiKey,
        systemPrompt,
        userMessage,
        modelPlan,
        settings: normalizedSettings,
        signal: controller.signal,
        onChunk(text) {
          broadcastToPanel({ type: 'STREAM_CHUNK', text });
        }
      });
    }
    clearTimeout(timeout);

    const fullOutput = generationResult.output;
    // Prefer real token counts from the API response; fall back to estimates
    const inputTokens = generationResult.inputTokens ?? inputTokenEstimate;
    const outputTokens = generationResult.outputTokens ?? estimateTokenCount(fullOutput);
    const costData = estimateCost(modelPlan.primaryModel, inputTokens, outputTokens);
    await trackUsage({ ...costData, inputTokens, outputTokens, provider: llmProvider, action: 'generation', timestamp: Date.now() });

    broadcastToPanel({ type: 'GENERATION_COMPLETE', output: fullOutput });
    updateSession(tabId, {
      lastOutput: fullOutput,
      lastIntent: intent,
      lastTemplateId: templateId,
      lastContext: { ...stripEphemeralContext(context || {}), intent, templateId },
      recentTurns: appendRecentTurn(session.recentTurns, {
        transcript,
        output: fullOutput,
        intent,
        templateId,
        timestamp: Date.now()
      })
    });
    await saveToHistory({
      transcript,
      output: fullOutput,
      context: stripEphemeralContext(context),
      intent: intent,
      templateId
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('Generation timed out. Try again.');
    throw err;
  }
}

async function refineOutput({ refinement, previousOutput, context, transcript, tabId }) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const normalizedSettings = normalizeSettings(settings);
  const llmProvider = normalizedSettings.llmProvider || 'openai';
  const providerConfig = getProviderConfig(llmProvider);
  const apiKey = providerConfig.keyName ? await getDecryptedKey(providerConfig.keyName) : null;
  if (providerConfig.keyName && !apiKey) throw new Error(`${providerConfig.label} API key required for refinement.`);
  const sanitizedContext = sanitizePromptContext(context || {}, {
    ...normalizedSettings,
    usePageContext: true,
    redactSensitive: true
  });
  const session = getOrCreateSession(tabId);
  const modelPlan = resolveModelPlan({
    settings: normalizedSettings,
    templateId: session.lastTemplateId || normalizedSettings.activeTemplate,
    intent: session.lastIntent || 'custom',
    hasScreenshot: false
  });

  const refineSystemPrompt = [
    'You are Briefly, refining an existing draft using the user\'s latest instruction.',
    'Preserve accurate details from the prior draft unless the new instruction asks to remove or replace them.',
    'Follow the latest refinement request over the previous draft when they conflict.',
    'Keep the same format and overall structure unless the user explicitly asks for a different format.',
    'Do not invent missing facts. If essential information is missing, keep the draft useful and note the assumption briefly.',
    'Return only the improved final draft.'
  ].join('\n');

  const refineMessages = [
    { role: 'system', content: refineSystemPrompt },
    {
      role: 'user',
      content: [
        `Original request:\n${transcript || 'unknown'}`,
        buildPageContextBlock(sanitizedContext)
      ].filter(Boolean).join('\n\n')
    },
    { role: 'assistant', content: previousOutput || '' },
    {
      role: 'user',
      content: refinement
        ? `Refinement request:\n${refinement}\n\nRevise the previous draft accordingly.`
        : 'Improve the previous draft for clarity, accuracy, and usefulness without changing its format.'
    }
  ];

  const { output: fullOutput } = await generateWithProvider({
    provider: llmProvider,
    apiKey,
    systemPrompt: refineSystemPrompt,
    userMessage: refineMessages.filter(m => m.role !== 'system').map(m => m.content).join('\n\n'),
    modelPlan,
    settings: normalizedSettings,
    signal: undefined,
    onChunk(text) {
      broadcastToPanel({ type: 'STREAM_CHUNK', text });
    }
  });

  broadcastToPanel({ type: 'GENERATION_COMPLETE', output: fullOutput });
  updateSession(tabId, {
    lastOutput: fullOutput,
    lastRefinement: refinement || null,
    recentTurns: appendRecentTurn(session.recentTurns, {
      transcript: refinement || transcript || 'refine previous output',
      output: fullOutput,
      intent: session.lastIntent || 'custom',
      templateId: session.lastTemplateId || normalizedSettings.activeTemplate,
      timestamp: Date.now()
    })
  });
}

// ─────────────────────────────────────────────────────────────────
// LOCAL PROMPTS (client-side)
// ─────────────────────────────────────────────────────────────────
function buildSystemPrompt(intent, tone, outputFormat, templateId, settings = {}, options = {}) {
  const baseByIntent = {
    summarize: 'Primary task: distill the source into the smallest useful set of high-signal takeaways, decisions, risks, and next steps.',
    prompt_generation: 'Primary task: turn the request and context into a high-leverage prompt that is specific, reusable, and ready to paste into another LLM.',
    task_extraction: 'Primary task: extract concrete work items with owners, priorities, dependencies, and unresolved questions when possible.',
    documentation: 'Primary task: produce clear, technically accurate documentation that is easy to scan and immediately usable.',
    testing: 'Primary task: design a test plan that covers happy paths, edge cases, negative cases, regressions, and automation opportunities.',
    code_review: 'Primary task: review the material like a senior engineer and lead with concrete findings, risks, regressions, and missing tests.',
    user_story: 'Primary task: convert the material into crisp user stories with acceptance criteria and implementation notes.',
    explain: 'Primary task: explain the material clearly, step by step, with the right level of depth for the request.',
    translate_intent: 'Primary task: translate the content while preserving meaning, nuance, and important terminology.',
    email_draft: 'Primary task: draft a clear, professional email that is ready to send with minimal editing.',
    compare: 'Primary task: compare options fairly, surface tradeoffs, and end with a concrete recommendation when warranted.',
    custom: 'Primary task: follow the user request precisely and produce the most useful output for the current page context.'
  };

  const base = baseByIntent[intent] || baseByIntent.custom;
  const templateNote = buildTemplateInstruction(templateId, settings);
  const toneNote = buildToneInstruction(tone);
  const formatNote = buildFormatInstruction(outputFormat);

  return [
    'You are Briefly, a high-judgment browser copilot.',
    base,
    'General rules:',
    '- Prioritize the user\'s explicit request over page context when they conflict.',
    '- Treat selected text as the highest-priority evidence, then code snippets, then the visible page snapshot.',
    '- Use page context aggressively when it improves precision, but do not claim facts that are not present.',
    '- Keep the answer dense with signal. Avoid filler, repetition, and generic advice.',
    '- If context is incomplete, state the assumption briefly instead of hallucinating specifics.',
    '- Preserve important names, identifiers, statuses, and technical details exactly when present.',
    '- When reviewing code or technical content, be concrete and evidence-based.',
    options.hasScreenshot ? '- A screenshot may be attached. Use it to reason about UI state, layout, visual regressions, and charts when relevant.' : '',
    options.hasRecentTurns ? '- Treat recent tab history as continuity context, not as stronger evidence than the current page and request.' : '',
    options.feedbackPreferences?.length
      ? `User style preferences from recent feedback:\n${options.feedbackPreferences.map(p => `- ${p}`).join('\n')}`
      : '',
    templateNote,
    toneNote,
    formatNote
  ].filter(Boolean).join('\n');
}

function buildTemplateInstruction(templateId, settings = {}) {
  const customTemplate = (settings.customRecipes || []).find(template => template.id === templateId);
  if (customTemplate) {
    return [
      `Output contract for ${customTemplate.label}:`,
      `- Objective: ${customTemplate.summary || 'Produce the strongest output for this saved recipe.'}`,
      `- Follow this recipe instruction exactly: ${customTemplate.instruction}`,
      '- Preserve concrete facts, identifiers, and evidence from the page context.',
      '- If required context is missing, say what is missing instead of inventing it.',
      '- Return a final answer only, in the smallest useful structure for this recipe.'
    ].join('\n');
  }

  const templateInstructions = {
    general_assistant: [
      'Output contract:',
      '- Answer the user directly.',
      '- Organize the response into the smallest useful structure.',
      '- End with recommended next steps when the context implies action.'
    ].join('\n'),
    bug_report: [
      'Output contract for bug reports:',
      '- Use sections for Summary, Impact, Steps to Reproduce, Expected Result, Actual Result, Evidence, Likely Cause, Environment, and Open Questions.',
      '- Distinguish confirmed facts from inferred causes.',
      '- If reproduction details are incomplete, produce the best draft possible and label the missing information clearly.'
    ].join('\n'),
    pr_review: [
      'Output contract for PR/code reviews:',
      '- Start with Findings and order them by severity.',
      '- Each finding should explain the risk, why it matters, and what is missing or broken.',
      '- After findings, include Open Questions or Residual Risks only if needed.',
      '- If there are no substantive findings, say so explicitly and mention testing gaps or confidence limits.'
    ].join('\n'),
    test_plan: [
      'Output contract for test plans:',
      '- Use sections for Objective, Scope, Happy Paths, Edge Cases, Negative Cases, Regression Risks, Automation Candidates, and Setup/Data Needs.',
      '- Include concrete scenarios, not just category names.',
      '- Prioritize cases most likely to fail in production.'
    ].join('\n'),
    product_spec: [
      'Output contract for product specs:',
      '- Use sections for Problem, Users, Goals, Non-Goals, User Flows, Requirements, Edge Cases, Dependencies, Risks, and Success Metrics.',
      '- Keep requirements testable and unambiguous.',
      '- Call out unresolved decisions explicitly.'
    ].join('\n'),
    release_notes: [
      'Output contract for release notes:',
      '- Start with a short release headline.',
      '- Include Customer Highlights, Operational Notes, Risks or Caveats, and Follow-up Items.',
      '- Focus on what changed and why it matters to users or operators.'
    ].join('\n'),
    customer_reply: [
      'Output contract for customer replies:',
      '- Write as a polished message ready to send.',
      '- Be concise, empathetic, and specific.',
      '- Include the next step, any needed clarification, and avoid internal-only language.'
    ].join('\n')
  };

  return templateInstructions[templateId] || templateInstructions.general_assistant;
}

function buildUserMessagePayload(transcript, context, settings = {}, session = {}, intent = 'custom') {
  const textContent = buildUserMessage(transcript, context, settings, session, intent);
  if (!context?.screenshotDataUrl) {
    return textContent;
  }

  return [
    { type: 'text', text: textContent },
    {
      type: 'image_url',
      image_url: {
        url: context.screenshotDataUrl
      }
    }
  ];
}

function buildUserMessage(transcript, context, settings = {}, session = {}, intent = 'custom') {
  const sanitizedContext = sanitizePromptContext(context, settings);
  const isInternetContext = sanitizedContext?.contextSource === 'internet';
  const parts = isInternetContext
    ? [
        `User request:\n${transcript}`,
        'Context source:\nLive internet web search',
        'Instruction:\nSearch the live web for the most relevant current information, synthesize it into one direct answer, and state uncertainty briefly when the sources do not fully agree.'
      ]
    : [
        `User request:\n${transcript}`,
        'Context priority:\n1. Selected text\n2. Code snippets\n3. Visible page snapshot\n4. Metadata such as headings, forms, and page type'
      ];
  const recentTurnsSummary = summarizeRecentTurns(session?.recentTurns, settings);
  if (recentTurnsSummary) {
    parts.push(`Recent tab history:\n${recentTurnsSummary}`);
  }
  if (isInternetContext) {
    if (sanitizedContext?.pageTitle) parts.push(`Fallback context label:\n${sanitizedContext.pageTitle}`);
    if (sanitizedContext?.url) parts.push(`Active tab URL:\n${sanitizedContext.url}`);
    if (settings.redactSensitive) {
      parts.push('Sensitive strings have been redacted before sending this request.');
    }
    return parts.join('\n\n');
  }
  // Budget context tokens by intent priority to avoid sending low-signal content
  const contextForBudget = {
    ...sanitizedContext,
    structuredData: sanitizedContext.structuredDataSummary,
    domainArtifacts: sanitizedContext.domainArtifactsSummary
  };
  const { budgeted } = budgetContextTokens(contextForBudget, intent, 3000);
  if (budgeted.selectedText) {
    parts.push(`Selected text:\n"""\n${budgeted.selectedText}\n"""`);
  }
  if (budgeted.visibleText && !sanitizedContext.selectedText) {
    parts.push(`Visible page snapshot:\n${budgeted.visibleText}`);
  }
  if (budgeted.codeBlocks?.length) {
    const code = budgeted.codeBlocks
      .map((b, index) => `Snippet ${index + 1} [${b.lang || 'unknown'}]\n${b.code}`)
      .join('\n\n');
    parts.push(`Code snippets:\n\`\`\`\n${code}\n\`\`\``);
  }
  if (budgeted.headings?.length) {
    parts.push(`Page headings:\n${budgeted.headings.map(h => `- H${h.level}: ${h.text}`).join('\n')}`);
  }
  if (budgeted.formFields?.length) {
    const fieldSummary = budgeted.formFields
      .map(field => `${field.label || field.type}: ${field.value}`)
      .join(' | ');
    parts.push(`Relevant form fields:\n${fieldSummary}`);
  }
  if (sanitizedContext?.tool) {
    parts.push(`Detected tool:\n${sanitizedContext.tool}`);
  }
  if (budgeted.structuredData) {
    parts.push(`Structured page data:\n${budgeted.structuredData}`);
  }
  if (budgeted.domainArtifacts) {
    parts.push(`Domain-specific context:\n${budgeted.domainArtifacts}`);
  }
  if (sanitizedContext?.pageType && sanitizedContext.pageType !== 'general') {
    parts.push(`Detected page type:\n${sanitizedContext.pageType}`);
  }
  if (sanitizedContext?.pageTitle) parts.push(`Page title:\n${sanitizedContext.pageTitle}`);
  if (sanitizedContext?.url) parts.push(`URL:\n${sanitizedContext.url}`);
  if (context?.screenshotDataUrl) {
    parts.push('A screenshot of the current visible page is attached. Use it only when the visual layout, UI state, chart, or screenshot evidence matters.');
  }
  if (settings.redactSensitive) {
    parts.push('Sensitive strings have been redacted before sending this context.');
  }
  return parts.join('\n\n');
}

function sanitizePromptContext(context = {}, settings = {}) {
  const usePageContext = settings.usePageContext !== false;
  const selectionOnly = settings.selectionOnly === true;
  const redactSensitive = settings.redactSensitive !== false;
  const signalPrefs = {
    ...DEFAULT_CONTEXT_SIGNAL_PREFS,
    ...(settings.contextSignalPrefs || {})
  };

  if (!usePageContext) {
    return {};
  }

  const sanitized = {
    contextSource: context.contextSource || 'page',
    pageTitle: context.pageTitle || '',
    url: context.url || '',
    domain: context.domain || '',
    pageType: context.pageType || 'general',
    tool: context.domainContext?.tool || '',
    selectedText: signalPrefs.selectedText === false ? '' : (context.selectedText || ''),
    visibleText: selectionOnly || signalPrefs.visibleText === false ? '' : (context.visibleText || ''),
    codeBlocks: selectionOnly || signalPrefs.codeBlocks === false ? [] : (context.codeBlocks || []),
    headings: selectionOnly || signalPrefs.headings === false ? [] : (context.headings || []),
    formFields: selectionOnly || signalPrefs.formFields === false ? [] : (context.formFields || []),
    structuredDataSummary: selectionOnly || signalPrefs.structuredData === false ? '' : summarizeStructuredData(context.structuredData),
    domainArtifactsSummary: selectionOnly || signalPrefs.domainArtifacts === false ? '' : summarizeDomainArtifacts(context.domainArtifacts)
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

function buildToneInstruction(tone) {
  if (!tone || tone === 'auto') return '';
  return `Tone requirement:\n- Write in a ${tone} tone without becoming vague or wordy.`;
}

function buildFormatInstruction(outputFormat) {
  if (outputFormat === 'plain') {
    return 'Format requirement:\n- Return plain text only. No Markdown.';
  }

  if (outputFormat === 'structured') {
    return 'Format requirement:\n- Use headings, bullets, and tables when they improve clarity.';
  }

  return 'Format requirement:\n- Return polished Markdown with concise headings and lists where helpful.';
}

function buildPageContextBlock(context = {}) {
  if (context.contextSource === 'internet') {
    const parts = ['Context source: live internet web search'];
    if (context.pageTitle) parts.push(`Label: ${context.pageTitle}`);
    if (context.url) parts.push(`Active tab URL: ${context.url}`);
    return `Context:\n${parts.join('\n')}`;
  }

  const parts = [];
  if (context.pageType) parts.push(`Page type: ${context.pageType}`);
  if (context.pageTitle) parts.push(`Page title: ${context.pageTitle}`);
  if (context.url) parts.push(`URL: ${context.url}`);
  if (context.selectedText) parts.push(`Selected text:\n"""\n${context.selectedText.slice(0, 1500)}\n"""`);
  if (context.codeBlocks?.length) {
    const code = context.codeBlocks
      .map((block, index) => `Snippet ${index + 1} [${block.lang || 'unknown'}]\n${block.code}`)
      .join('\n\n');
    parts.push(`Code snippets:\n\`\`\`\n${code.slice(0, 2600)}\n\`\`\``);
  }
  if (context.visibleText) parts.push(`Visible snapshot:\n${context.visibleText.slice(0, 1600)}`);
  if (context.domainArtifactsSummary) parts.push(`Domain-specific context:\n${context.domainArtifactsSummary}`);
  return parts.length ? `Page context:\n${parts.join('\n\n')}` : '';
}

function summarizeStructuredData(structuredData) {
  if (!structuredData || typeof structuredData !== 'object') return '';

  const compact = JSON.stringify(structuredData);
  if (!compact || compact === '{}') return '';

  return compact.slice(0, 1200);
}

function summarizeDomainArtifacts(domainArtifacts) {
  if (!domainArtifacts || typeof domainArtifacts !== 'object') return '';

  const lines = [];
  Object.entries(domainArtifacts).forEach(([key, value]) => {
    if (value == null || value === '') return;
    if (Array.isArray(value)) {
      const compactItems = value
        .map(item => typeof item === 'string' ? item : JSON.stringify(item))
        .filter(Boolean)
        .slice(0, 8);
      if (compactItems.length) {
        lines.push(`${key}: ${compactItems.join(' | ')}`);
      }
      return;
    }
    if (typeof value === 'object') {
      const compact = JSON.stringify(value);
      if (compact && compact !== '{}') {
        lines.push(`${key}: ${compact}`);
      }
      return;
    }
    lines.push(`${key}: ${String(value)}`);
  });

  return lines.join('\n').slice(0, 1400);
}

// ─────────────────────────────────────────────────────────────────
// MULTI-PROVIDER GENERATION
// ─────────────────────────────────────────────────────────────────
async function generateWithProvider({ provider, apiKey, systemPrompt, userMessage, modelPlan, settings, signal, onChunk }) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ];
  const fallbackMessages = modelPlan.fallbackModel ? [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ] : null;

  switch (provider) {
    case 'anthropic':
      return generateWithAnthropic({ apiKey, messages, modelPlan, signal, onChunk });
    case 'gemini':
      return generateWithGemini({ apiKey, messages, modelPlan, signal, onChunk });
    case 'ollama':
      return generateWithOllama({ messages, modelPlan, settings, signal, onChunk });
    case 'openai':
    default: {
      const result = await generateGuaranteedOutput({
        apiKey,
        body: { model: modelPlan.primaryModel, temperature: modelPlan.temperature, max_tokens: modelPlan.maxTokens, messages },
        fallbackBody: modelPlan.fallbackModel ? { model: modelPlan.fallbackModel, temperature: modelPlan.temperature, max_tokens: modelPlan.maxTokens, messages: fallbackMessages } : null,
        signal,
        onChunk
      });
      // generateGuaranteedOutput returns { output, inputTokens, outputTokens }
      return result;
    }
  }
}

async function generateWithAnthropic({ apiKey, messages, modelPlan, signal, onChunk }) {
  const systemContent = messages.find(m => m.role === 'system')?.content || '';
  const userContent = messages.filter(m => m.role !== 'system').map(m => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    if (Array.isArray(m.content)) {
      return {
        role: m.role,
        content: m.content.map(part => {
          if (part.type === 'text') return { type: 'text', text: part.text };
          if (part.type === 'image_url') return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: part.image_url.url.split(',')[1] || '' } };
          return part;
        })
      };
    }
    return { role: m.role, content: String(m.content) };
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: modelPlan.primaryModel,
      max_tokens: modelPlan.maxTokens,
      system: systemContent,
      messages: userContent,
      stream: true
    }),
    signal
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
    throw new Error(err.error?.message || `Anthropic API error: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const event = JSON.parse(data);
        if (event.type === 'content_block_delta' && event.delta?.text) {
          output += event.delta.text;
          if (onChunk) onChunk(event.delta.text);
        } else if (event.type === 'message_start' && event.message?.usage) {
          inputTokens = event.message.usage.input_tokens || 0;
        } else if (event.type === 'message_delta' && event.usage) {
          outputTokens = event.usage.output_tokens || 0;
        }
      } catch { /* skip malformed JSON */ }
    }
  }

  if (!output.trim() && modelPlan.fallbackModel) {
    return generateWithAnthropic({
      apiKey,
      messages,
      modelPlan: { ...modelPlan, primaryModel: modelPlan.fallbackModel, fallbackModel: null },
      signal,
      onChunk
    });
  }

  return { output: output.trim() || '', inputTokens, outputTokens };
}

async function generateWithGemini({ apiKey, messages, modelPlan, signal, onChunk }) {
  const systemContent = messages.find(m => m.role === 'system')?.content || '';
  const userParts = messages.filter(m => m.role !== 'system').map(m => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (typeof m.content === 'string') return { role, parts: [{ text: m.content }] };
    if (Array.isArray(m.content)) {
      return {
        role,
        parts: m.content.map(part => {
          if (part.type === 'text') return { text: part.text };
          if (part.type === 'image_url') return { inlineData: { mimeType: 'image/jpeg', data: part.image_url.url.split(',')[1] || '' } };
          return { text: String(part) };
        })
      };
    }
    return { role, parts: [{ text: String(m.content) }] };
  });

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelPlan.primaryModel}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemContent }] },
      contents: userParts,
      generationConfig: { temperature: modelPlan.temperature, maxOutputTokens: modelPlan.maxTokens }
    }),
    signal
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
    throw new Error(err.error?.message || `Gemini API error: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n');
    buffer = events.pop() || '';

    for (const line of events) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data) continue;
      try {
        const event = JSON.parse(data);
        const text = event.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text) {
          output += text;
          if (onChunk) onChunk(text);
        }
        if (event.usageMetadata) {
          inputTokens = event.usageMetadata.promptTokenCount || inputTokens;
          outputTokens = event.usageMetadata.candidatesTokenCount || outputTokens;
        }
      } catch { /* skip */ }
    }
  }

  if (!output.trim() && modelPlan.fallbackModel) {
    return generateWithGemini({
      apiKey,
      messages,
      modelPlan: { ...modelPlan, primaryModel: modelPlan.fallbackModel, fallbackModel: null },
      signal,
      onChunk
    });
  }

  return { output: output.trim() || '', inputTokens, outputTokens };
}

async function generateWithOllama({ messages, modelPlan, settings, signal, onChunk }) {
  const ollamaEndpoint = settings.ollamaEndpoint || 'http://localhost:11434';
  const model = settings.ollamaModel || modelPlan.primaryModel || 'llama3';

  const ollamaMessages = messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  }));

  const res = await fetch(`${ollamaEndpoint}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: ollamaMessages, stream: true }),
    signal
  });

  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status}. Is Ollama running at ${ollamaEndpoint}?`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        const text = data.message?.content || '';
        if (text) {
          output += text;
          if (onChunk) onChunk(text);
        }
        if (data.done) {
          inputTokens = data.prompt_eval_count || 0;
          outputTokens = data.eval_count || 0;
        }
      } catch { /* skip */ }
    }
  }

  return { output: output.trim() || '', inputTokens, outputTokens };
}

// ─────────────────────────────────────────────────────────────────
// COST TRACKING
// ─────────────────────────────────────────────────────────────────
async function trackUsage(entry) {
  try {
    const { usageLog = [] } = await chrome.storage.local.get('usageLog');
    const newEntry = { id: Date.now().toString(36), ...entry };
    const updated = [newEntry, ...usageLog].slice(0, 1000);
    await chrome.storage.local.set({ usageLog: updated });

    // Update running totals
    const { usageTotals = { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, monthStart: getMonthStart() } } = await chrome.storage.local.get('usageTotals');
    const currentMonth = getMonthStart();
    if (usageTotals.monthStart !== currentMonth) {
      usageTotals.totalCost = 0;
      usageTotals.totalInputTokens = 0;
      usageTotals.totalOutputTokens = 0;
      usageTotals.totalRequests = 0;
      usageTotals.monthStart = currentMonth;
    }
    const prevCost = usageTotals.totalCost;
    usageTotals.totalCost += entry.totalCost || 0;
    usageTotals.totalInputTokens += entry.inputTokens || 0;
    usageTotals.totalOutputTokens += entry.outputTokens || 0;
    usageTotals.totalRequests += 1;
    await chrome.storage.local.set({ usageTotals });

    // Budget warning: notify panel when crossing 80%, 90%, or 100% thresholds
    const { settings = {} } = await chrome.storage.local.get('settings');
    const budget = settings.costBudgetMonthly || 0;
    if (budget > 0 && settings.costTrackingEnabled !== false) {
      const prev = prevCost / budget;
      const curr = usageTotals.totalCost / budget;
      if (curr >= 1.0 && prev < 1.0) {
        broadcastToPanel({ type: 'BUDGET_WARNING', level: 'exceeded', totalCost: usageTotals.totalCost, budget });
      } else if (curr >= 0.9 && prev < 0.9) {
        broadcastToPanel({ type: 'BUDGET_WARNING', level: 'danger', totalCost: usageTotals.totalCost, budget, pct: curr });
      } else if (curr >= 0.8 && prev < 0.8) {
        broadcastToPanel({ type: 'BUDGET_WARNING', level: 'warning', totalCost: usageTotals.totalCost, budget, pct: curr });
      }
    }
  } catch { /* non-critical */ }
}

function getMonthStart() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function loadFeedbackPreferences() {
  try {
    const { feedbackLog = [] } = await chrome.storage.local.get('feedbackLog');
    const preferences = [];
    for (const entry of feedbackLog.slice(0, 15)) {
      if (entry.rating === 'negative' && entry.note?.trim()) {
        preferences.push(`Avoid: ${entry.note.trim().slice(0, 120)}`);
      } else if (entry.rating === 'positive' && entry.note?.trim()) {
        preferences.push(`User liked: ${entry.note.trim().slice(0, 120)}`);
      }
    }
    return [...new Set(preferences)].slice(0, 3);
  } catch {
    return [];
  }
}

async function streamChatCompletionWithFallback({ apiKey, body, fallbackBody, signal, onChunk }) {
  let chunkCount = 0;
  try {
    const result = await streamChatCompletion({
      apiKey,
      body,
      signal,
      onChunk(text) {
        chunkCount += 1;
        if (onChunk) onChunk(text);
      }
    });
    return { ...result, model: body.model };
  } catch (error) {
    if (!fallbackBody || chunkCount > 0 || error.name === 'AbortError') {
      throw error;
    }

    const result = await streamChatCompletion({
      apiKey,
      body: fallbackBody,
      signal,
      onChunk
    });
    return { ...result, model: fallbackBody.model };
  }
}

async function chatCompletionOnce({ apiKey, body, signal }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      ...body,
      stream: false
    }),
    signal
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error?.message || err.error || `Processing failed: ${res.status}`);
  }

  const payload = await res.json();
  return payload.choices?.[0]?.message?.content?.trim() || '';
}

async function generateGuaranteedOutput({ apiKey, body, fallbackBody, signal, onChunk }) {
  const { output, model, inputTokens, outputTokens } = await streamChatCompletionWithFallback({
    apiKey,
    body,
    fallbackBody,
    signal,
    onChunk
  });

  if (output && output.trim()) {
    return { output: output.trim(), inputTokens, outputTokens };
  }

  const retryBody = fallbackBody && model !== fallbackBody.model ? fallbackBody : body;
  const retryOutput = await chatCompletionOnce({
    apiKey,
    body: retryBody,
    signal
  });

  if (retryOutput && retryOutput.trim()) {
    // Non-streaming fallback: no real token counts available
    return { output: retryOutput.trim(), inputTokens: null, outputTokens: null };
  }

  throw new Error('Generation returned no output. Try again.');
}

async function generateInternetSearchOutput({ apiKey, transcript, context, settings = {}, session = {}, systemPrompt, signal }) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'o4-mini',
      tools: [{ type: 'web_search' }],
      instructions: systemPrompt,
      input: buildUserMessage(transcript, context, settings, session)
    }),
    signal
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(err.error?.message || err.error || `Internet search failed: ${response.status}`);
  }

  const payload = await response.json();
  const output = extractResponsesText(payload);
  if (!output) {
    throw new Error('Internet search returned no answer. Try again.');
  }
  return output;
}

function extractResponsesText(payload = {}) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const chunks = [];
  (payload.output || []).forEach(item => {
    (item?.content || []).forEach(part => {
      const candidate =
        part?.text ||
        part?.output_text ||
        part?.content ||
        part?.summary?.text ||
        '';
      if (typeof candidate === 'string' && candidate.trim()) {
        chunks.push(candidate.trim());
      }
    });
  });

  return chunks.join('\n\n').trim();
}

async function streamChatCompletion({ apiKey, body, signal, onChunk }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      ...body,
      stream: true,
      stream_options: { include_usage: true }
    }),
    signal
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error?.message || err.error || `Processing failed: ${res.status}`);
  }

  if (!res.body) {
    throw new Error('Streaming response body unavailable.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  let usageData = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const event of events) {
      const lines = event
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
      const dataLines = lines
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim());

      for (const data of dataLines) {
        if (!data || data === '[DONE]') continue;
        const payload = JSON.parse(data);
        const delta = payload.choices?.[0]?.delta?.content || '';
        if (delta) {
          output += delta;
          if (onChunk) onChunk(delta);
        }
        // stream_options: {include_usage: true} sends usage in the final chunk
        if (payload.usage) {
          usageData = payload.usage;
        }
      }
    }
  }

  return {
    output: output.trim(),
    inputTokens: usageData?.prompt_tokens ?? null,
    outputTokens: usageData?.completion_tokens ?? null
  };
}

async function transcribeWithOpenAI(audioBlob, apiKey, language, signal) {
  const formData = new FormData();
  formData.append('file', audioBlob, 'recording.webm');
  const model = 'gpt-4.1-mini-transcribe';
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

async function getPageContext(options = {}) {
  try {
    const { settings = {} } = await chrome.storage.local.get('settings');
    const normalizedSettings = normalizeSettings(settings);
    if (normalizedSettings.usePageContext === false) {
      return {};
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return buildInternetFallbackContext(null, 'no_active_tab');
    currentTabId = tab.id;
    if (shouldUseInternetFallback(tab)) {
      return buildInternetFallbackContext(tab, 'empty_or_inaccessible_tab');
    }

    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_CONTEXT' });
    } catch {
      return buildInternetFallbackContext(tab, 'content_script_unavailable');
    }
    const context = {
      ...(response?.context || {}),
      contextSource: 'page'
    };
    if (!context.pageTitle) context.pageTitle = tab.title || '';
    if (!context.url) context.url = tab.url || tab.pendingUrl || '';
    if (!context.domain && context.url) {
      try {
        context.domain = new URL(context.url).hostname;
      } catch {
        context.domain = '';
      }
    }

    if (
      options.includeScreenshot &&
      normalizedSettings.useVisionContext &&
      normalizedSettings.contextSignalPrefs?.screenshot !== false &&
      tab.windowId != null
    ) {
      try {
        const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: 'jpeg',
          quality: 60
        });
        if (screenshotDataUrl) {
          context.screenshotDataUrl = screenshotDataUrl;
        }
      } catch (err) {
        console.warn('[Briefly SW] Screenshot capture failed:', err);
      }
    }

    return context;
  } catch {
    return buildInternetFallbackContext(null, 'context_lookup_failed');
  }
}

function shouldUseInternetFallback(tab) {
  if (!tab?.id) return true;
  const url = (tab.url || tab.pendingUrl || '').trim();
  if (!url) return true;

  return [
    /^about:blank$/i,
    /^about:/i,
    /^chrome:\/\//i,
    /^chrome-search:\/\//i,
    /^chrome-extension:\/\//i,
    /^edge:\/\//i,
    /^brave:\/\//i,
    /^vivaldi:\/\//i,
    /^opera:\/\//i,
    /^devtools:\/\//i,
    /^data:/i,
    /^blob:/i,
    /^view-source:/i
  ].some(pattern => pattern.test(url));
}

function buildInternetFallbackContext(tab, reason) {
  const url = tab?.url || tab?.pendingUrl || '';
  return {
    pageTitle: 'Internet context',
    url,
    domain: 'Web search',
    pageType: 'internet',
    contextSource: 'internet',
    selectedText: '',
    visibleText: '',
    visibleTextLimit: 0,
    codeBlocks: [],
    headings: [],
    formFields: [],
    structuredData: {},
    domainArtifacts: {},
    extractedAt: Date.now(),
    fallbackReason: reason || 'empty_or_inaccessible_tab'
  };
}

async function getPageActions() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return [];
    currentTabId = tab.id;
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_ACTIONS' });
    return response?.actions || [];
  } catch {
    return [];
  }
}

function stripEphemeralContext(context) {
  if (!context || typeof context !== 'object') return context || null;
  const sanitized = { ...context };
  delete sanitized.screenshotDataUrl;
  return sanitized;
}

async function notifyUser(title, message) {
  if (!chrome.notifications?.create) return;
  await chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message: String(message || '').slice(0, 240)
  });
}

async function saveToHistory(entry) {
  try {
    const [{ history = [] }, { settings = {} }] = await Promise.all([
      chrome.storage.local.get('history'),
      chrome.storage.local.get('settings')
    ]);
    const limit = normalizeSettings(settings).historyLimit || 500;
    const newEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      timestamp: Date.now(),
      ...entry
    };
    const updated = [newEntry, ...history].slice(0, limit);
    await chrome.storage.local.set({ history: updated });
    broadcastToPanel({ type: 'HISTORY_UPDATED', count: updated.length });
  } catch (err) {
    console.warn('[Briefly SW] Failed to save history:', err);
  }
}

async function encryptAndStoreKeys(rawKeys) {
  // Try session storage first, then local
  let keyBytes;
  if (chrome.storage.session) {
    const session = await chrome.storage.session.get('cryptoKeyRaw');
    keyBytes = session.cryptoKeyRaw;
  }
  if (!keyBytes) {
    const local = await chrome.storage.local.get('cryptoKeyRaw');
    keyBytes = local.cryptoKeyRaw;
    if (keyBytes && chrome.storage.session) {
      await chrome.storage.session.set({ cryptoKeyRaw: keyBytes });
      await chrome.storage.local.remove('cryptoKeyRaw');
    }
  }
  if (!keyBytes) {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    keyBytes = Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
    if (chrome.storage.session) {
      await chrome.storage.session.set({ cryptoKeyRaw: keyBytes });
    } else {
      await chrome.storage.local.set({ cryptoKeyRaw: keyBytes });
    }
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
    justification: 'Briefly needs microphone access for voice recording.'
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
