// Briefly — page reader content script.
// Injected on demand via chrome.scripting. Extracts readable paragraphs from
// the live DOM (so we can highlight them during playback) and listens for
// highlight commands from the side panel.
(() => {
  if (window.__brieflyReader) return;
  window.__brieflyReader = true;

  const BLOCK_SEL = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, dd, figcaption';
  const SKIP_SEL = [
    'nav', 'header', 'footer', 'aside', 'form', 'noscript',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[role="complementary"]', '[aria-hidden="true"]',
    '.nav', '.navbar', '.menu', '.sidebar', '.footer', '.breadcrumb',
    '.cookie', '.consent', '.ad', '.ads', '.advert', '.share', '.related'
  ].join(',');
  const MIN_CHARS = 25;
  const ATTR = 'data-briefly-idx';
  const HL_CLASS = 'briefly-highlight';

  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== 'BODY') {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed') return false;
    }
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Mini-readability: pick the container with the highest paragraph text
  // density so we keep live nodes for highlight sync (Readability.js works on
  // a detached clone and loses the node mapping).
  function findRoot() {
    const candidates = [
      ...document.querySelectorAll('article, main, [role="main"], #content, .post, .article-body')
    ];
    let best = null;
    let bestScore = 0;
    for (const c of candidates) {
      let score = 0;
      for (const p of c.querySelectorAll('p')) score += p.innerText.trim().length;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return bestScore > 250 ? best : document.body;
  }

  function clearMarks() {
    for (const el of document.querySelectorAll(`[${ATTR}]`)) {
      el.removeAttribute(ATTR);
      el.classList.remove(HL_CLASS);
    }
  }

  function extract() {
    clearMarks();
    const root = findRoot();
    const paragraphs = [];
    for (const el of root.querySelectorAll(BLOCK_SEL)) {
      if (el.closest(SKIP_SEL)) continue;
      if (!isVisible(el)) continue;
      // Skip wrappers whose text comes from a nested block (e.g. <li><p>…)
      const nested = el.querySelector(BLOCK_SEL);
      if (nested && nested.innerText.trim().length >= MIN_CHARS) continue;
      const text = el.innerText.replace(/\s+/g, ' ').trim();
      if (text.length < MIN_CHARS && !/^H[1-6]$/.test(el.tagName)) continue;
      if (!text) continue;
      const idx = paragraphs.length;
      el.setAttribute(ATTR, String(idx));
      paragraphs.push({ idx, text });
    }
    return {
      ok: paragraphs.length > 0,
      title: document.title || '',
      siteName: location.hostname,
      url: location.href,
      paragraphs,
      wordCount: paragraphs.reduce((n, p) => n + p.text.split(/\s+/).length, 0)
    };
  }

  function ensureStyle() {
    if (document.getElementById('briefly-hl-style')) return;
    const s = document.createElement('style');
    s.id = 'briefly-hl-style';
    s.textContent = `
      .${HL_CLASS} {
        background: rgba(99, 102, 241, 0.18) !important;
        outline: 2px solid rgba(99, 102, 241, 0.45);
        border-radius: 4px;
        transition: background 0.2s ease;
      }`;
    document.head.appendChild(s);
  }

  function highlight(idx) {
    ensureStyle();
    for (const el of document.querySelectorAll(`.${HL_CLASS}`)) el.classList.remove(HL_CLASS);
    if (idx == null || idx < 0) return;
    const el = document.querySelector(`[${ATTR}="${idx}"]`);
    if (!el) return;
    el.classList.add(HL_CLASS);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === 'BRIEFLY_EXTRACT') {
      sendResponse(extract());
      return false;
    }
    if (msg.type === 'BRIEFLY_HIGHLIGHT') {
      highlight(msg.idx);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'BRIEFLY_CLEAR_HIGHLIGHT') {
      highlight(-1);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
