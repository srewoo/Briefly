// Briefly — on-page dictation pill + recognizer.
// Injected into the active tab when the user starts headless dictation with the
// keyboard shortcut. It renders a floating "recording" pill (red pulsing dot)
// in a Shadow DOM AND runs the Web Speech recognition here in the page — the
// Web Speech API only works in a real document context (not the extension's
// offscreen document), so recognition lives with the pill. On stop it asks the
// service worker for an AI cleanup pass, then inserts the text at the caret and
// copies it to the clipboard.
(() => {
  if (window.__brieflyPill) return;
  window.__brieflyPill = true;

  const HOST_ID = 'briefly-pill-host';
  let hostEl = null, shadow = null, hideTimer = null;
  let rec = null, active = false, finalBuf = '';

  // ── pill UI ──────────────────────────────────────────────
  function ensurePill() {
    if (hostEl) return;
    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    hostEl.style.cssText = 'all:initial;position:fixed;z-index:2147483647;bottom:20px;left:50%;transform:translateX(-50%);';
    shadow = hostEl.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        @keyframes brf-pulse { 0%{transform:scale(1);opacity:1} 50%{transform:scale(1.5);opacity:.45} 100%{transform:scale(1);opacity:1} }
        .pill { display:flex; align-items:center; gap:10px;
          font:600 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
          color:#fff; background:#1b1e26; border:1px solid rgba(255,255,255,.12);
          padding:9px 14px; border-radius:999px; box-shadow:0 6px 24px rgba(0,0,0,.38);
          max-width:70vw; transition:opacity .25s ease, transform .25s ease; }
        .dot { width:10px; height:10px; border-radius:50%; background:#ff3b30; flex:0 0 auto; }
        .pill.rec .dot { animation:brf-pulse 1.1s infinite ease-in-out; }
        .pill.done { background:#12351f; border-color:rgba(52,199,89,.4); }
        .pill.done .dot { background:#34c759; animation:none; }
        .pill.err { background:#3a1518; border-color:rgba(255,59,48,.4); }
        .pill.err .dot { animation:none; }
        .label { white-space:nowrap; }
        .txt { color:#aeb6c2; font-weight:400; max-width:38vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .hidden { opacity:0; transform:translateY(8px); pointer-events:none; }
      </style>
      <div class="pill rec"><span class="dot"></span><span class="label">Listening…</span><span class="txt"></span></div>`;
    (document.body || document.documentElement).appendChild(hostEl);
  }

  const q = (sel) => shadow && shadow.querySelector(sel);

  function setState(cls, label, sub = '') {
    ensurePill();
    clearTimeout(hideTimer);
    q('.pill').className = `pill ${cls}`;
    q('.label').textContent = label;
    q('.txt').textContent = sub;
  }

  function fadeAndRemove(delay) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const pill = q('.pill');
      if (pill) pill.classList.add('hidden');
      setTimeout(() => { if (hostEl) { hostEl.remove(); hostEl = null; shadow = null; } }, 300);
    }, delay);
  }

  // ── delivery: insert at caret + clipboard ────────────────
  const INSERTABLE_INPUT = /^(text|search|url|email|tel|number|password|)$/i;
  function insertAtCursor(text) {
    if (!text) return false;
    const el = document.activeElement;
    if (!el) return false;
    try {
      const tag = el.tagName;
      if (tag === 'TEXTAREA' || (tag === 'INPUT' && INSERTABLE_INPUT.test(el.type || ''))) {
        const start = el.selectionStart, end = el.selectionEnd;
        if (typeof start === 'number' && typeof el.setRangeText === 'function') el.setRangeText(text, start, end, 'end');
        else el.value = (el.value || '') + text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      if (el.isContentEditable) return document.execCommand('insertText', false, text);
    } catch (_) { /* fall through */ }
    return false;
  }

  function copyFallback(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
      (document.body || document.documentElement).appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) { return false; }
  }
  async function copyClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (_) { return copyFallback(text); }
  }

  // ── recognition (Web Speech, in-page) ────────────────────
  function micMsg(err) {
    if (err === 'not-allowed' || err === 'service-not-allowed')
      return 'Microphone blocked for this site. Click the 🎤 / camera icon in the address bar → Allow, then try again.';
    if (err === 'no-speech') return 'No speech detected.';
    if (err === 'audio-capture') return 'No microphone found.';
    if (err === 'network') return 'Network error (speech recognition needs internet).';
    return `Dictation error: ${err}`;
  }

  function startRec(lang) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setState('err', 'Speech recognition isn’t available in this browser.'); fadeAndRemove(4200); return; }
    finalBuf = '';
    try {
      rec = new SR();
      rec.lang = lang || 'en-US';
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalBuf += r[0].transcript;
          else interim += r[0].transcript;
        }
        const t = (finalBuf + interim).trim();
        setState('rec', 'Listening…', t.length > 60 ? '…' + t.slice(-60) : t);
      };
      rec.onerror = (e) => { active = false; setState('err', micMsg(e.error)); fadeAndRemove(4200); };
      // Web Speech ends on pauses — keep it going until the user stops.
      rec.onend = () => { if (active) { try { rec.start(); } catch (_) {} } };
      active = true;
      rec.start();
      setState('rec', 'Listening…');
    } catch (e) {
      active = false;
      setState('err', e.message || 'Could not start dictation.');
      fadeAndRemove(4200);
    }
  }

  async function stopRec() {
    active = false;
    if (rec) { try { rec.stop(); } catch (_) {} }
    setState('rec', 'Transcribing…');
    // Let the engine flush the last final result (the ~1–2s settle).
    await new Promise(r => setTimeout(r, 1200));
    rec = null;
    const raw = finalBuf.trim();
    if (!raw) { setState('err', 'No speech detected.'); fadeAndRemove(3500); return; }
    // Ask the service worker for the AI-cleanup + vocabulary pass.
    let text = raw;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'DICTATE_CLEANUP', text: raw });
      if (res && res.text) text = res.text;
    } catch (_) { /* keep raw */ }
    const inserted = insertAtCursor(text);
    const copied = await copyClipboard(text);
    const chars = ` (${text.length} chars)`;
    setState('done', inserted ? `Inserted at cursor ✓${chars}` : (copied ? `Copied to clipboard ✓${chars}` : 'Done'));
    fadeAndRemove(2600);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'DICTATE_START') startRec(msg.lang);
    else if (msg.type === 'DICTATE_STOP') stopRec();
    else if (msg.type === 'DICTATE_HIDE') { active = false; if (rec) { try { rec.stop(); } catch (_) {} } fadeAndRemove(0); }
  });
})();
