/**
 * Productify — markdown.js
 * Markdown → HTML renderer using marked.js + highlight.js
 * Loaded from CDN via background service worker (not inline)
 */

const Markdown = {
  _markedLoaded: false,

  /** Render markdown string to safe HTML */
  render(markdown) {
    if (!markdown) return '';
    // Simple fallback renderer if marked.js not loaded
    if (typeof marked === 'undefined') {
      return this._simpleFallback(markdown);
    }
    try {
      // Configure marked with security options
      marked.setOptions({
        gfm: true,
        breaks: true,
        sanitize: false, // We sanitize manually below
        highlight: (code, lang) => {
          if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
            try {
              return hljs.highlight(code, { language: lang }).value;
            } catch (_) {}
          }
          return typeof hljs !== 'undefined' ? hljs.highlightAuto(code).value : code;
        }
      });

      const rawHtml = marked.parse(markdown);
      return this._sanitize(rawHtml);
    } catch (e) {
      console.warn('[Productify] Markdown render error:', e);
      return this._simpleFallback(markdown);
    }
  },

  /** Simple fallback renderer without marked.js */
  _simpleFallback(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/^#{1,6}\s+(.+)$/gm, (_, text) => `<strong>${text}</strong>`)
      .replace(/^[-*]\s+(.+)$/gm, '• $1')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/^(.+)$/, '<p>$1</p>');
  },

  /** Basic HTML sanitizer — remove scripts, event handlers */
  _sanitize(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    
    // Remove dangerous elements
    const dangerous = tmp.querySelectorAll('script, iframe, object, embed, form, input, button, style, link, meta');
    dangerous.forEach(el => el.remove());
    
    // Remove event handler attributes
    const allEls = tmp.querySelectorAll('*');
    allEls.forEach(el => {
      Array.from(el.attributes).forEach(attr => {
        if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
        if (attr.name === 'style') el.removeAttribute(attr.name);
        if (attr.name === 'href' && attr.value.startsWith('javascript:')) {
          el.setAttribute('href', '#');
        }
        if (attr.name === 'src') {
          const safeSrc = /^(https?:|data:image\/|chrome-extension:)/i.test(attr.value);
          if (!safeSrc) el.removeAttribute('src');
        }
      });
      // Open links in new tab safely
      if (el.tagName === 'A') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    });
    return tmp.innerHTML;
  },

  /** Load marked.js + highlight.js from local vendor files */
  async loadDependencies() {
    if (this._markedLoaded) return;
    return new Promise((resolve) => {
      const loadScript = (src, cb) => {
        const s = document.createElement('script');
        s.src = chrome.runtime.getURL(src);
        s.onload = cb;
        s.onerror = () => cb(); // Fail gracefully
        document.head.appendChild(s);
      };
      loadScript(
        'lib/vendor/marked.min.js',
        () => loadScript(
          'lib/vendor/highlight.min.js',
          () => {
            // Load a theme for highlight.js
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = chrome.runtime.getURL('lib/vendor/highlight-github-dark.min.css');
            document.head.appendChild(link);
            this._markedLoaded = true;
            resolve();
          }
        )
      );
    });
  }
};

if (typeof window !== 'undefined') window.Markdown = Markdown;
