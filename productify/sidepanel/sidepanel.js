/**
 * Productify — sidepanel.js
 * Complete UI controller: state machine, events, rendering, history, library, settings.
 */
'use strict';

// ─────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────
const State = {
  // Recording state machine
  mode: 'idle', // idle | recording | transcribing | generating | done | error

  // Data
  transcript: '',
  output: '',
  intent: null,
  history: [],
  library: [],
  settings: {},

  // UI
  currentView: 'main', // main | history | library | settings
  historyCollapsed: false,
  transcriptCollapsed: false,
  isStreaming: false,
  waveformActive: false,
  pushToTalkActive: false,
  lastErrorType: null
};

// ─────────────────────────────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = {
  app: $('app'),
  micBtn: $('mic-btn'),
  micWrapper: $('mic-wrapper'),
  micSpinner: $('mic-spinner'),
  micHint: $('mic-hint'),
  sttLabel: $('stt-label'),
  waveformCanvas: $('waveform-canvas'),
  intentRow: $('intent-row'),
  intentBadge: $('intent-badge'),
  intentIcon: $('intent-icon'),
  intentName: $('intent-name'),
  intentConfidence: $('intent-confidence'),
  intentSuggestions: $('intent-suggestions'),
  transcriptSection: $('transcript-section'),
  transcriptBody: $('transcript-body'),
  transcriptText: $('transcript-text'),
  outputSection: $('output-section'),
  outputContent: $('output-content'),
  outputPlaceholder: $('output-placeholder'),
  markdownOutput: $('markdown-output'),
  streamingDots: $('streaming-dots'),
  actionBar: $('action-bar'),
  btnCopy: $('btn-copy'),
  btnExport: $('btn-export'),
  btnIntegrate: $('btn-integrate'),
  btnRefine: $('btn-refine'),
  refineSection: $('refine-section'),
  refineInput: $('refine-input'),
  btnRefineSubmit: $('btn-refine-submit'),
  historySection: $('history-section'),
  historyList: $('history-list'),
  historyEmpty: $('history-empty'),
  historyCount: $('history-count'),
  historyListFull: $('history-list-full'),
  historySearch: $('history-search'),
  libraryList: $('library-list'),
  libraryEmpty: $('library-empty'),
  librarySearch: $('library-search'),
  toastContainer: $('toast-container'),
  errorOverlay: $('error-overlay'),
  errorIcon: $('error-icon'),
  errorTitle: $('error-title'),
  errorMessage: $('error-message'),
  btnTheme: $('btn-theme'),
  btnSettings: $('btn-settings'),
  btnHistory: $('btn-history'),
  btnLibrary: $('btn-library'),
  btnStar: $('btn-star'),
  modalExport: $('modal-export'),
  modalIntegrate: $('modal-integrate'),
};

// Waveform canvas context
const wctx = el.waveformCanvas.getContext('2d');

// ─────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────
async function init() {
  await Markdown.loadDependencies();
  await loadSettings();
  await loadHistory();
  await loadLibrary();
  applyTheme(State.settings.theme || 'dark');
  updateSttBadge(State.settings.sttProvider || 'whisper');
  bindEvents();
  setupMessageListener();
}

async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  State.settings = {
    sttProvider: 'whisper',
    language: 'auto',
    tone: 'auto',
    outputFormat: 'markdown',
    theme: 'dark',
    ...settings
  };
  // Populate settings UI
  const fields = {
    'stt-provider': State.settings.sttProvider,
    'stt-language': State.settings.language,
    'output-tone': State.settings.tone,
    'output-format': State.settings.outputFormat
  };
  for (const [id, val] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (el && val) el.value = val;
  }
}

async function loadHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  State.history = history;
  renderHistoryList();
}

async function loadLibrary() {
  const { library = [] } = await chrome.storage.local.get('library');
  State.library = library;
  renderLibraryList();
}

// ─────────────────────────────────────────────────────────────────
// MESSAGE LISTENER (from service worker)
// ─────────────────────────────────────────────────────────────────
function setupMessageListener() {
  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'RECORDING_STARTED':    setMode('recording'); break;
      case 'RECORDING_CANCELLED':  setMode('idle'); break;
      case 'STATE_TRANSCRIBING':   setMode('transcribing'); break;
      case 'STATE_GENERATING':     setMode('generating'); break;
      case 'TRANSCRIPT_READY':
        State.transcript = msg.transcript;
        showTranscript(msg.transcript);
        break;
      case 'INTENT_LOCAL':
      case 'INTENT_SERVER':
        showIntentBadge(msg.intent);
        break;
      case 'STREAM_CHUNK':
        appendStreamChunk(msg.text);
        break;
      case 'GENERATION_COMPLETE':
        State.output = msg.output;
        setMode('done');
        finalizeOutput();
        break;
      case 'WAVEFORM_DATA':
        if (State.mode === 'recording') drawWaveform(msg.data);
        break;
      case 'HISTORY_UPDATED':
        loadHistory();
        break;
      case 'ROUTE_SUCCESS':
        showToast(`✅ Sent to ${capitalize(msg.target)}!`, 'success');
        closeModal('modal-integrate');
        break;
      case 'ERROR':
        handleError(msg.error, msg.message);
        break;
      // Shortcut handlers
      case 'SHORTCUT_PUSH_TO_TALK': toggleRecording(); break;
      case 'SHORTCUT_COPY':         copyOutput(); break;
      case 'SHORTCUT_HISTORY':      navigateTo('history'); break;
      case 'SHORTCUT_RETRY':        retryLast(); break;
    }
  });
}

// ─────────────────────────────────────────────────────────────────
// STATE MACHINE
// ─────────────────────────────────────────────────────────────────
function setMode(mode) {
  State.mode = mode;
  const micIcon = el.micBtn.querySelector('.mic-icon-idle');
  const stopIcon = el.micBtn.querySelector('.mic-icon-recording');

  el.micWrapper.classList.remove('recording', 'processing');
  el.micBtn.classList.remove('recording', 'processing');
  stopIcon.style.display = 'none';
  micIcon.style.display = '';
  el.micSpinner.style.display = 'none';

  switch (mode) {
    case 'idle':
      el.micHint.textContent = 'Hold Space or click to speak';
      el.waveformCanvas.classList.remove('visible');
      break;
    case 'recording':
      el.micWrapper.classList.add('recording');
      el.micBtn.classList.add('recording');
      micIcon.style.display = 'none';
      stopIcon.style.display = '';
      el.micHint.textContent = 'Recording… click to stop';
      el.waveformCanvas.classList.add('visible');
      State.waveformActive = true;
      break;
    case 'transcribing':
      el.micBtn.classList.add('processing');
      el.micSpinner.style.display = 'flex';
      el.micHint.textContent = 'Transcribing…';
      el.waveformCanvas.classList.remove('visible');
      break;
    case 'generating':
      el.micBtn.classList.add('processing');
      el.micSpinner.style.display = 'flex';
      el.micHint.textContent = 'Generating…';
      showOutputSection(true); // Show with loading dots
      break;
    case 'done':
      el.micHint.textContent = 'Done! Click mic to try again.';
      el.streamingDots.style.display = 'none';
      break;
    case 'error':
      el.micHint.textContent = 'Something went wrong. Try again.';
      break;
  }
}

// ─────────────────────────────────────────────────────────────────
// RECORDING
// ─────────────────────────────────────────────────────────────────
async function startRecording() {
  if (State.mode === 'recording') return;
  const { settings = {} } = await chrome.storage.local.get('settings');
  chrome.runtime.sendMessage({ type: 'START_RECORDING', config: { provider: settings.sttProvider } });
}

async function stopRecording() {
  if (State.mode !== 'recording') return;
  State.waveformActive = false;
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
}

async function toggleRecording() {
  if (State.mode === 'idle' || State.mode === 'done' || State.mode === 'error') {
    await startRecording();
  } else if (State.mode === 'recording') {
    await stopRecording();
  }
}

async function retryLast() {
  if (!State.transcript) return;
  setMode('generating');
  chrome.runtime.sendMessage({ type: 'PROCESS_TEXT', text: State.transcript });
}

// ─────────────────────────────────────────────────────────────────
// TRANSCRIPT
// ─────────────────────────────────────────────────────────────────
function showTranscript(text) {
  el.transcriptSection.style.display = '';
  el.transcriptText.textContent = text || '';
}

// ─────────────────────────────────────────────────────────────────
// OUTPUT / STREAMING
// ─────────────────────────────────────────────────────────────────
function showOutputSection(loading = false) {
  el.outputSection.style.display = '';
  el.actionBar.style.display = '';
  el.markdownOutput.innerHTML = '';
  if (loading) {
    el.streamingDots.style.display = 'flex';
  }
}

let streamBuffer = '';
let streamCursor = null;

function appendStreamChunk(text) {
  if (!State.isStreaming) {
    State.isStreaming = true;
    el.streamingDots.style.display = 'none';
    showOutputSection(false);
    streamBuffer = '';
    // Add cursor element
    streamCursor = document.createElement('span');
    streamCursor.className = 'stream-cursor';
    el.markdownOutput.appendChild(streamCursor);
  }
  streamBuffer += text;
  // Re-render the markdown with cursor at end
  const rendered = Markdown.render(streamBuffer);
  el.markdownOutput.innerHTML = rendered;
  // Re-add cursor
  streamCursor = document.createElement('span');
  streamCursor.className = 'stream-cursor animate-cursor';
  el.markdownOutput.appendChild(streamCursor);
  // Scroll to bottom
  el.markdownOutput.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

function finalizeOutput() {
  State.isStreaming = false;
  if (streamCursor) streamCursor.remove();
  const rendered = Markdown.render(State.output);
  el.markdownOutput.innerHTML = rendered;
  el.actionBar.style.display = '';
}

// ─────────────────────────────────────────────────────────────────
// INTENT BADGE
// ─────────────────────────────────────────────────────────────────
function showIntentBadge(intObj) {
  if (!intObj || !intObj.primary_intent) return;
  el.intentRow.style.display = '';
  el.intentBadge.setAttribute('data-intent', intObj.primary_intent);
  el.intentIcon.textContent = getIntentIcon(intObj.primary_intent);
  el.intentName.textContent = getIntentLabel(intObj.primary_intent);
  const pct = Math.round((intObj.confidence || 0) * 100);
  el.intentConfidence.textContent = `${pct}%`;

  if (intObj.fallback || (intObj.confidence || 0) < 0.7) {
    el.intentBadge.classList.add('low-confidence');
    // Show top-3 suggestions
    if (intObj.top3?.length > 1) {
      el.intentSuggestions.style.display = 'flex';
      el.intentSuggestions.querySelectorAll('.suggestion-pill').forEach(p => p.remove());
      for (const intent of intObj.top3.slice(1, 4)) {
        const pill = document.createElement('button');
        pill.className = 'suggestion-pill';
        pill.textContent = getIntentLabel(intent);
        pill.dataset.intent = intent;
        pill.onclick = () => overrideIntent(intent);
        el.intentSuggestions.appendChild(pill);
      }
    }
  } else {
    el.intentBadge.classList.remove('low-confidence');
    el.intentSuggestions.style.display = 'none';
  }
}

function overrideIntent(intent) {
  // Re-process with forced intent
  chrome.runtime.sendMessage({ type: 'PROCESS_TEXT', text: State.transcript, intent });
  setMode('generating');
  el.markdownOutput.innerHTML = '';
  showOutputSection(true);
}

function getIntentIcon(intent) {
  const icons = { summarize: '📝', prompt_generation: '✨', task_extraction: '✅', documentation: '📚', testing: '🧪', code_review: '🔍', user_story: '📖', explain: '💡', translate_intent: '🌐', email_draft: '✉️', compare: '⚖️', custom: '🔮' };
  return icons[intent] || '🔮';
}
function getIntentLabel(intent) {
  const labels = { summarize: 'Summarize', prompt_generation: 'Prompt Gen', task_extraction: 'Task Extract', documentation: 'Documentation', testing: 'Testing', code_review: 'Code Review', user_story: 'User Story', explain: 'Explain', translate_intent: 'Translate', email_draft: 'Email Draft', compare: 'Compare', custom: 'Custom' };
  return labels[intent] || 'Custom';
}

// ─────────────────────────────────────────────────────────────────
// WAVEFORM
// ─────────────────────────────────────────────────────────────────
function drawWaveform(dataArray) {
  const canvas = el.waveformCanvas;
  const W = canvas.width, H = canvas.height;
  wctx.clearRect(0, 0, W, H);

  const gradient = wctx.createLinearGradient(0, 0, W, 0);
  gradient.addColorStop(0, '#6C5CE7');
  gradient.addColorStop(1, '#00D2FF');
  wctx.strokeStyle = gradient;
  wctx.lineWidth = 2;
  wctx.beginPath();

  const sliceWidth = W / dataArray.length;
  let x = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = dataArray[i] / 128.0;
    const y = (v * H) / 2;
    if (i === 0) wctx.moveTo(x, y);
    else wctx.lineTo(x, y);
    x += sliceWidth;
  }
  wctx.lineTo(W, H / 2);
  wctx.stroke();
}

// ─────────────────────────────────────────────────────────────────
// HISTORY
// ─────────────────────────────────────────────────────────────────
function renderHistoryList(filter = '') {
  const list = el.historyList;
  const fullList = el.historyListFull;
  const items = filter 
    ? State.history.filter(h => h.transcript?.toLowerCase().includes(filter.toLowerCase()) || h.output?.toLowerCase().includes(filter.toLowerCase()))
    : State.history;

  el.historyEmpty.style.display = items.length ? 'none' : '';
  el.historyCount.textContent = State.history.length;

  const renderItem = (h) => {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML = `
      <div class="history-item-icon">${getIntentIcon(h.intent)}</div>
      <div class="history-item-info">
        <div class="history-item-title">${escHtml(h.transcript?.slice(0, 60) || 'No transcript')}</div>
        <div class="history-item-meta">
          <span>${getIntentLabel(h.intent)}</span>
          <span>${I18n.relativeTime(h.timestamp)}</span>
        </div>
      </div>
      <button class="history-item-delete" data-id="${h.id}" title="Delete" aria-label="Delete">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a1,1,0,0,1,1-1h4a1,1,0,0,1,1,1v2"/></svg>
      </button>
    `;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.history-item-delete')) {
        deleteHistory(h.id);
      } else {
        restoreHistory(h);
      }
    });
    return li;
  };

  list.innerHTML = '';
  if (el.historyListFull) el.historyListFull.innerHTML = '';
  items.slice(0, 5).forEach(h => list.appendChild(renderItem(h)));
  if (el.historyListFull) items.forEach(h => el.historyListFull.appendChild(renderItem(h)));

  // Show/hide the clear button in main view
  const clearBtn = $('btn-clear-all-history');
  if (clearBtn && State.currentView === 'main') {
    clearBtn.style.display = State.history.length > 0 ? '' : 'none';
  }
}

async function deleteHistory(id) {
  State.history = State.history.filter(h => h.id !== id);
  const { history = [] } = await chrome.storage.local.get('history');
  await chrome.storage.local.set({ history: history.filter(h => h.id !== id) });
  renderHistoryList();
  showToast('Deleted from history');
}

function restoreHistory(entry) {
  State.transcript = entry.transcript || '';
  State.output = entry.output || '';
  State.intent = entry.intent || null;
  showTranscript(State.transcript);
  showIntentBadge({ primary_intent: entry.intent, confidence: 1 });
  showOutputSection(false);
  const rendered = Markdown.render(State.output);
  el.markdownOutput.innerHTML = rendered;
  el.actionBar.style.display = '';
  setMode('done');
  if (State.currentView !== 'main') navigateTo('main');
}

// ─────────────────────────────────────────────────────────────────
// PROMPT LIBRARY
// ─────────────────────────────────────────────────────────────────
function renderLibraryList(filter = '', tag = 'all') {
  const items = State.library.filter(item => {
    const matchesFilter = !filter || item.title?.toLowerCase().includes(filter.toLowerCase()) || item.output?.toLowerCase().includes(filter.toLowerCase());
    const matchesTag = tag === 'all' || item.tags?.includes(tag);
    return matchesFilter && matchesTag;
  });

  el.libraryEmpty.style.display = items.length ? 'none' : '';
  el.libraryList.innerHTML = '';

  // Update tag filter pills
  const tagRow = $('tag-filter-row');
  const allTags = [...new Set(State.library.flatMap(i => i.tags || []))];
  tagRow.innerHTML = `<button class="tag-pill ${tag === 'all' ? 'active' : ''}" data-tag="all">All</button>`;
  allTags.forEach(t => {
    const btn = document.createElement('button');
    btn.className = `tag-pill ${tag === t ? 'active' : ''}`;
    btn.dataset.tag = t;
    btn.textContent = t;
    btn.onclick = () => renderLibraryList(filter, t);
    tagRow.appendChild(btn);
  });

  items.forEach(item => {
    const li = document.createElement('li');
    li.className = 'library-item';
    li.innerHTML = `
      <div class="library-item-title">${escHtml(item.title || item.transcript?.slice(0, 60) || 'Untitled')}</div>
      <div class="library-item-tags">${(item.tags || []).map(t => `<span class="library-tag">${escHtml(t)}</span>`).join('')}</div>
    `;
    li.onclick = () => restoreHistory(item);
    el.libraryList.appendChild(li);
  });
}

async function saveToLibrary() {
  if (!State.output) return;
  const { library = [] } = await chrome.storage.local.get('library');
  const newItem = {
    id: Date.now().toString(36),
    timestamp: Date.now(),
    title: State.transcript?.slice(0, 60) || 'Saved Prompt',
    transcript: State.transcript,
    output: State.output,
    intent: State.intent?.primary_intent || 'custom',
    tags: [State.intent?.primary_intent || 'custom'],
    starred: true
  };
  await chrome.storage.local.set({ library: [newItem, ...library] });
  State.library = [newItem, ...library];
  renderLibraryList();
  showToast('⭐ Saved to library!', 'success');
  el.btnStar.classList.add('starred');
}

// ─────────────────────────────────────────────────────────────────
// COPY & EXPORT
// ─────────────────────────────────────────────────────────────────
async function copyOutput() {
  if (!State.output) return;
  try {
    await navigator.clipboard.writeText(State.output);
    el.btnCopy.classList.add('copied');
    el.btnCopy.querySelector('span').textContent = 'Copied!';
    showToast('📋 Copied!', 'success');
    setTimeout(() => {
      el.btnCopy.classList.remove('copied');
      el.btnCopy.querySelector('span').textContent = 'Copy';
    }, 2000);
  } catch {
    showToast('Failed to copy', 'error');
  }
}

function exportAs(format) {
  if (!State.output) return;
  let content = State.output;
  let mimeType = 'text/plain';
  let ext = 'txt';

  if (format === 'md') {
    ext = 'md';
    mimeType = 'text/markdown';
  } else if (format === 'json') {
    ext = 'json';
    mimeType = 'application/json';
    content = JSON.stringify({
      transcript: State.transcript,
      output: State.output,
      intent: State.intent,
      timestamp: Date.now()
    }, null, 2);
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `productify-output.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
  closeModal('modal-export');
  showToast(`💾 Exported as .${ext}`);
}

// ─────────────────────────────────────────────────────────────────
// ERROR HANDLING
// ─────────────────────────────────────────────────────────────────
function handleError(errorType, message) {
  setMode('error');
  State.lastErrorType = errorType;

  // Normalise message so objects don't render as "[object Object]"
  let normalizedMessage = message;
  if (message && typeof message === 'object') {
    normalizedMessage =
      message.error ||
      message.message ||
      JSON.stringify(message, null, 2);
  }

  const errorConfigs = {
    mic_denied: {
      icon: '🎙️❌',
      title: 'Microphone Access Denied',
      message: 'Productify needs microphone access. Click "Open Settings" to allow mic access in Chrome.'
    },
    empty_transcript: {
      icon: '🤔',
      title: "Didn't catch that",
      message: 'Try speaking more clearly, or type your command below.'
    },
    api_error: {
      icon: '⚠️',
      title: 'Processing Failed',
      message: normalizedMessage || 'Something went wrong generating your output.'
    },
    integration_error: {
      icon: '🔗',
      title: 'Integration Failed',
      message: normalizedMessage || 'Could not send to the integration. Check your settings.'
    },
    network: {
      icon: '📡',
      title: "You're offline",
      message: "Can't connect to Productify backend. Check your connection."
    }
  };
  const config =
    errorConfigs[errorType] || {
      icon: '⚠️',
      title: 'Error',
      message: normalizedMessage || 'Something went wrong.'
    };
  el.errorIcon.textContent = config.icon;
  el.errorTitle.textContent = config.title;
  el.errorMessage.textContent = config.message;

  // Update primary button label based on error type
  const primaryBtn = document.getElementById('btn-error-primary');
  if (primaryBtn) {
    primaryBtn.textContent = errorType === 'mic_denied' ? 'Open Settings' : 'Retry';
  }

  el.errorOverlay.style.display = 'flex';
}

// ─────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────
async function saveSettings() {
  const settings = {
    sttProvider: document.getElementById('stt-provider').value,
    language: document.getElementById('stt-language').value,
    tone: document.getElementById('output-tone').value,
    outputFormat: document.getElementById('output-format').value
  };
  await chrome.storage.local.set({ settings: { ...State.settings, ...settings } });
  State.settings = { ...State.settings, ...settings };

  // Collect and encrypt API keys
  const keyFields = {
    openai: document.getElementById('key-openai').value.trim(),
    googleStt: document.getElementById('key-google-stt').value.trim(),
    elevenStt: document.getElementById('key-eleven-stt').value.trim(),
    notion: document.getElementById('key-notion').value.trim(),
    github: document.getElementById('key-github').value.trim(),
    jira: document.getElementById('key-jira').value.trim(),
    linear: document.getElementById('key-linear').value.trim(),
    slack: document.getElementById('key-slack').value.trim(),
    webhook: document.getElementById('key-webhook').value.trim()
  };

  const nonEmptyKeys = Object.fromEntries(Object.entries(keyFields).filter(([, v]) => v));
  if (Object.keys(nonEmptyKeys).length > 0) {
    await chrome.runtime.sendMessage({ type: 'STORE_KEYS', keys: nonEmptyKeys });
  }

  updateSttBadge(settings.sttProvider);
  showToast('✅ Settings saved!', 'success');
  navigateTo('main');
}

// ─────────────────────────────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────────────────────────────
function navigateTo(view) {
  const views = { main: 'view-main', history: 'view-history', library: 'view-library', settings: 'view-settings' };
  Object.entries(views).forEach(([name, id]) => {
    const v = document.getElementById(id);
    if (!v) return;
    if (name === view) {
      v.classList.remove('slide-out-left');
      v.classList.add('active');
    } else {
      v.classList.remove('active');
      if (name === 'main') v.classList.add('slide-out-left');
    }
  });
  State.currentView = view;
}

// ─────────────────────────────────────────────────────────────────
// THEME
// ─────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const moon = el.btnTheme.querySelector('.icon-moon');
  const sun = el.btnTheme.querySelector('.icon-sun');
  if (theme === 'light') { moon.style.display = 'none'; sun.style.display = ''; }
  else { moon.style.display = ''; sun.style.display = 'none'; }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  State.settings.theme = next;
  chrome.storage.local.set({ settings: State.settings });
}

// ─────────────────────────────────────────────────────────────────
// TOASTS
// ─────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  el.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, 2500);
}

// ─────────────────────────────────────────────────────────────────
// MODALS
// ─────────────────────────────────────────────────────────────────
function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.style.display = 'flex';
}
function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────
function updateSttBadge(provider) {
  if (provider === 'google') {
    el.sttLabel.textContent = 'Google STT';
  } else if (provider === 'elevenlabs') {
    el.sttLabel.textContent = 'ElevenLabs STT';
  } else {
    el.sttLabel.textContent = 'Whisper';
  }
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

// ─────────────────────────────────────────────────────────────────
// EVENT BINDINGS
// ─────────────────────────────────────────────────────────────────
function bindEvents() {
  // Mic button
  el.micBtn.addEventListener('click', toggleRecording);

  // Push-to-talk with Space
  document.addEventListener('keydown', async e => {
    if (e.code === 'Space' && e.target === document.body) {
      e.preventDefault();
      if (!State.pushToTalkActive && (State.mode === 'idle' || State.mode === 'done' || State.mode === 'error')) {
        State.pushToTalkActive = true;
        await startRecording();
      }
    }
    if (e.code === 'Escape') {
      if (State.mode === 'recording') {
        chrome.runtime.sendMessage({ type: 'CANCEL_RECORDING' });
        setMode('idle');
      }
      closeModal('modal-export');
      closeModal('modal-integrate');
      el.errorOverlay.style.display = 'none';
    }
  });
  document.addEventListener('keyup', async e => {
    if (e.code === 'Space' && State.pushToTalkActive) {
      State.pushToTalkActive = false;
      await stopRecording();
    }
  });

  // Action bar
  el.btnCopy.addEventListener('click', copyOutput);
  el.btnExport.addEventListener('click', () => openModal('modal-export'));
  el.btnIntegrate.addEventListener('click', () => openModal('modal-integrate'));
  el.btnRefine.addEventListener('click', () => {
    el.refineSection.style.display = el.refineSection.style.display === 'none' ? '' : 'none';
    if (el.refineSection.style.display !== 'none') el.refineInput.focus();
  });
  el.btnRefineSubmit.addEventListener('click', submitRefine);
  el.refineInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitRefine(); });

  // Star button
  el.btnStar.addEventListener('click', saveToLibrary);

  // Header buttons
  el.btnTheme.addEventListener('click', toggleTheme);
  el.btnSettings.addEventListener('click', () => navigateTo('settings'));
  el.btnHistory.addEventListener('click', () => navigateTo('history'));
  el.btnLibrary.addEventListener('click', () => navigateTo('library'));

  // Back buttons
  document.querySelectorAll('[id^="btn-back-from"]').forEach(btn => {
    btn.addEventListener('click', () => navigateTo('main'));
  });

  // Settings save
  $('btn-save-settings').addEventListener('click', saveSettings);

  // Library: new prompt button (just navigates to main to use mic)
  const btnNewPrompt = $('btn-new-prompt');
  if (btnNewPrompt) btnNewPrompt.addEventListener('click', () => { navigateTo('main'); showToast('Speak your prompt!'); });

  // Clear data
  $('btn-clear-data').addEventListener('click', async () => {
    if (confirm('Clear all Productify data? This cannot be undone.')) {
      await chrome.storage.local.clear();
      State.history = [];
      State.library = [];
      renderHistoryList();
      renderLibraryList();
      showToast('All data cleared');
    }
  });

  // Help / Docs
  const helpBtn = $('btn-open-help');
  if (helpBtn) {
    helpBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('help.html') });
    });
  }

  // Privacy policy
  const privacyBtn = $('btn-open-privacy');
  if (privacyBtn) {
    privacyBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('privacypolicy.html') });
    });
  }

  // History toggle
  $('history-toggle').addEventListener('click', () => {
    const body = $('history-body');
    const btn = $('history-toggle').querySelector('.collapse-btn');
    body.style.display = body.style.display === 'none' ? '' : 'none';
    btn.classList.toggle('collapsed');
  });

  // Transcript toggle
  $('transcript-toggle').addEventListener('click', () => {
    const body = $('transcript-body');
    const btn = $('transcript-toggle').querySelector('.collapse-btn');
    body.style.display = body.style.display === 'none' ? '' : 'none';
    btn.classList.toggle('collapsed');
  });

  // Clear history (main view inline button)
  const clearHistoryMainBtn = $('btn-clear-all-history');
  if (clearHistoryMainBtn) {
    clearHistoryMainBtn.addEventListener('click', async () => {
      if (confirm('Clear all history?')) {
        await chrome.storage.local.set({ history: [] });
        State.history = [];
        renderHistoryList();
        showToast('History cleared');
      }
    });
  }
  // Clear history (history full-view button)
  const clearHistoryViewBtn = $('btn-clear-history-view');
  if (clearHistoryViewBtn) {
    clearHistoryViewBtn.addEventListener('click', async () => {
      if (confirm('Clear all history?')) {
        await chrome.storage.local.set({ history: [] });
        State.history = [];
        renderHistoryList();
        showToast('History cleared');
      }
    });
  }

  // History search
  el.historySearch.addEventListener('input', e => renderHistoryList(e.target.value));

  // Library search
  el.librarySearch.addEventListener('input', e => renderLibraryList(e.target.value));

  // Export modal buttons
  document.getElementById('export-md').addEventListener('click', () => exportAs('md'));
  document.getElementById('export-txt').addEventListener('click', () => exportAs('txt'));
  document.getElementById('export-json').addEventListener('click', () => exportAs('json'));
  document.getElementById('btn-close-export').addEventListener('click', () => closeModal('modal-export'));

  // Integration modal
  document.querySelectorAll('.integration-option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'ROUTE_OUTPUT', target: btn.dataset.target });
      closeModal('modal-integrate');
      showToast(`Sending to ${capitalize(btn.dataset.target)}…`);
    });
  });
  document.getElementById('btn-close-integrate').addEventListener('click', () => closeModal('modal-integrate'));

  // Error overlay buttons
  document.getElementById('btn-error-primary').addEventListener('click', () => {
    if (State.lastErrorType === 'mic_denied') {
      // Open Chrome mic settings so user can grant permission
      chrome.tabs.create({ url: 'chrome://settings/content/microphone' });
    } else {
      retryLast();
    }
  });
  document.getElementById('btn-error-dismiss').addEventListener('click', () => {
    el.errorOverlay.style.display = 'none';
    setMode('idle');
  });

  // Connect buttons in settings
  document.querySelectorAll('.btn-connect').forEach(btn => {
    btn.addEventListener('click', async () => {
      const integration = btn.dataset.integration;
      const input = document.getElementById(`key-${integration}`);
      const val = input?.value?.trim();
      if (!val) { showToast('Enter a value first', 'error'); return; }
      showToast(`Connecting to ${capitalize(integration)}…`);
      btn.textContent = 'Saved!';
      btn.classList.add('connected');
    });
  });

  // Toggle visibility for API key inputs
  document.querySelectorAll('.toggle-visibility-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  // Refine voice button
  document.getElementById('btn-refine-voice').addEventListener('click', async () => {
    await startRecording();
  });

  // Edit transcript inline
  document.getElementById('btn-edit-transcript').addEventListener('click', () => {
    el.transcriptText.contentEditable = 'true';
    el.transcriptText.focus();
    document.getElementById('btn-edit-transcript').textContent = 'Done';
    document.getElementById('btn-edit-transcript').onclick = () => {
      State.transcript = el.transcriptText.textContent;
      el.transcriptText.contentEditable = 'false';
      document.getElementById('btn-edit-transcript').textContent = 'Edit';
      document.getElementById('btn-edit-transcript').onclick = null;
    };
  });

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.style.display = 'none';
    });
  });
}

function submitRefine() {
  const text = el.refineInput.value.trim();
  if (!text && !State.transcript) return;
  el.refineInput.value = '';
  el.refineSection.style.display = 'none';
  setMode('generating');
  el.markdownOutput.innerHTML = '';
  showOutputSection(true);
  State.isStreaming = false;
  chrome.runtime.sendMessage({ type: 'REFINE_OUTPUT', refinement: text });
}

// ─────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
