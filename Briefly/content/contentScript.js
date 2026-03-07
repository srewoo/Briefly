/**
 * Briefly — contentScript.js
 * Runs on every page. Extracts rich context from the active tab.
 * Listens for messages from the service worker requesting context.
 */

(function () {
  'use strict';

  const VISIBLE_TEXT_LIMITS = {
    'github-code': 1400,
    'github-pr': 2200,
    'github-issue': 1800,
    'jira-ticket': 1800,
    'confluence-doc': 2200,
    'notion-page': 2200,
    'linear-issue': 1800,
    'research-paper': 2400,
    documentation: 2200,
    article: 2200,
    technical: 1800,
    general: 1600
  };

  const CODE_BLOCK_SELECTORS = [
    'pre',
    'pre code',
    'code[class*="language-"]',
    '[class*="language-"] code',
    '.highlight pre',
    '.codehilite pre',
    '.prism-code',
    '.blob-code-inner',
    '.react-code-text',
    '.react-code-cell'
  ];

  /**
   * Extract all 10 context signals from the current page.
   * Returns a structured context object.
   */
  function extractPageContext() {
    const pageType = detectPageType();
    const visibleTextLimit = getVisibleTextLimit(pageType);
    const ctx = {
      pageTitle: document.title || '',
      url: window.location.href,
      domain: window.location.hostname,
      pageType,
      selectedText: getSelectedText(),
      visibleText: getVisibleText(pageType, visibleTextLimit),
      visibleTextLimit,
      codeBlocks: getCodeBlocks(pageType),
      headings: getHeadings(),
      structuredData: getStructuredData(),
      formFields: getFormContext(),
      imageAltTexts: getImageAlts(),
      domainContext: getDomainContext(),
      extractedAt: Date.now()
    };
    return ctx;
  }

  /** P0: Get user's text selection */
  function getSelectedText() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return '';
    return selection.toString().trim().slice(0, 2000);
  }

  function getVisibleTextLimit(pageType) {
    return VISIBLE_TEXT_LIMITS[pageType] || VISIBLE_TEXT_LIMITS.general;
  }

  /** P0: Get visible page text from the primary content region */
  function getVisibleText(pageType, limit) {
    const root = getPrimaryContentRoot(pageType);
    if (!root) return '';

    const cloned = root.cloneNode(true);
    [
      'script',
      'style',
      'noscript',
      'head',
      'nav',
      'footer',
      'header',
      'aside',
      '[aria-hidden="true"]',
      '[hidden]',
      '.sr-only',
      '.visually-hidden',
      '.blob-code',
      '.blob-code-inner',
      '.react-code-text',
      '.react-code-cell',
      'pre',
      'code'
    ].forEach(sel => {
      cloned.querySelectorAll(sel).forEach(el => el.remove());
    });

    const text = (cloned.innerText || cloned.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();

    return text.slice(0, limit);
  }

  /** P0: Collect code blocks with language detection */
  function getCodeBlocks(pageType) {
    if (pageType === 'github-code') {
      return getGitHubBlobCodeBlocks();
    }

    const blocks = [];
    const seen = new Set();

    document.querySelectorAll(CODE_BLOCK_SELECTORS.join(', ')).forEach(el => {
      const codeRoot = el.matches('pre') ? el : el.closest('pre') || el;
      if (!codeRoot || seen.has(codeRoot)) return;
      seen.add(codeRoot);

      const text = codeRoot.innerText || codeRoot.textContent || '';
      const normalized = normalizeCodeText(text);
      if (!looksLikeCode(normalized)) return;
      const lang = detectCodeLanguage(codeRoot);
      blocks.push({ lang, code: normalized.slice(0, 1600) });
    });

    return dedupeCodeBlocks(blocks).slice(0, 6);
  }

  /** P0: Get heading hierarchy */
  function getHeadings() {
    return Array.from(document.querySelectorAll('h1, h2, h3'))
      .map(h => ({ level: parseInt(h.tagName[1]), text: h.innerText?.trim() || '' }))
      .filter(h => h.text.length > 0)
      .slice(0, 15);
  }

  /** P0: Detect page type from domain + URL patterns */
  function detectPageType() {
    const url = window.location.href;
    const host = window.location.hostname;
    if (host.includes('github.com')) {
      if (url.includes('/pull/')) return 'github-pr';
      if (url.includes('/issues/')) return 'github-issue';
      if (url.includes('/blob/')) return 'github-code';
      return 'github';
    }
    if (host.includes('jira') || host.includes('atlassian.net')) return 'jira-ticket';
    if (host.includes('confluence') || url.includes('/wiki/')) return 'confluence-doc';
    if (host.includes('notion.so') || host.includes('notion.site')) return 'notion-page';
    if (host.includes('linear.app')) return 'linear-issue';
    if (host.includes('slack.com')) return 'slack';
    if (host.includes('arxiv.org')) return 'research-paper';
    if (url.includes('docs.') || url.split('/').some(p => p === 'docs')) return 'documentation';
    if (document.querySelector('article, .article, .post, .blog-post')) return 'article';
    if (document.querySelector('pre, code')) return 'technical';
    return 'general';
  }

  /** P1: Extract JSON-LD, Open Graph, and table structured data */
  function getStructuredData() {
    const result = {};
    // JSON-LD
    try {
      const jsonLd = document.querySelector('script[type="application/ld+json"]');
      if (jsonLd) result.jsonLd = JSON.parse(jsonLd.textContent);
    } catch (_) {}
    // Open Graph
    const og = {};
    document.querySelectorAll('meta[property^="og:"]').forEach(m => {
      og[m.getAttribute('property')] = m.getAttribute('content');
    });
    if (Object.keys(og).length) result.openGraph = og;
    // Table data (first table only)
    const table = document.querySelector('table');
    if (table) {
      const headers = Array.from(table.querySelectorAll('th')).map(th => th.innerText?.trim());
      const rows = Array.from(table.querySelectorAll('tr')).slice(1, 6)
        .map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.innerText?.trim()));
      if (headers.length) result.table = { headers, rows };
    }
    return result;
  }

  /** P1: Collect form context for drafting/filling intents */
  function getFormContext() {
    const fields = [];
    document.querySelectorAll('form input, form textarea, form select, [contenteditable]').forEach(el => {
      const label = el.labels?.[0]?.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || '';
      const value = el.value || el.innerText || '';
      if (label || value) {
        fields.push({
          label: label.trim().slice(0, 80),
          value: value.trim().slice(0, 200),
          type: el.tagName.toLowerCase()
        });
      }
    });
    return fields.slice(0, 10);
  }

  /** P1: Get image alt texts */
  function getImageAlts() {
    return Array.from(document.querySelectorAll('img[alt]'))
      .map(img => img.getAttribute('alt').trim())
      .filter(alt => alt.length > 2)
      .slice(0, 10);
  }

  /** P1: Domain context — known tool detection */
  function getDomainContext() {
    const host = window.location.hostname;
    const KNOWN_TOOLS = {
      'github.com': 'GitHub',
      'jira.': 'Jira',
      'atlassian.net': 'Jira/Confluence',
      'notion.so': 'Notion',
      'notion.site': 'Notion',
      'linear.app': 'Linear',
      'slack.com': 'Slack',
      'confluence': 'Confluence',
      'figma.com': 'Figma',
      'docs.google.com': 'Google Docs',
      'stackoverflow.com': 'Stack Overflow',
      'mdn': 'MDN Docs'
    };
    for (const [domain, name] of Object.entries(KNOWN_TOOLS)) {
      if (host.includes(domain)) return { tool: name, domain: host };
    }
    return { tool: null, domain: host };
  }

  /** Naive code language detection from element classes */
  function detectCodeLanguage(el) {
    const cls = (el.className + ' ' + (el.querySelector('code')?.className || '')).toLowerCase();
    const pathLang = detectCodeLanguageFromPath(window.location.pathname);
    if (pathLang) return pathLang;
    const langs = ['javascript', 'python', 'java', 'typescript', 'rust', 'go', 'bash', 'shell',
      'sql', 'html', 'css', 'yaml', 'json', 'ruby', 'php', 'cpp', 'c', 'swift'];
    for (const lang of langs) {
      if (cls.includes(lang) || cls.includes('lang-' + lang) || cls.includes('language-' + lang)) {
        return lang;
      }
    }
    return 'unknown';
  }

  function detectCodeLanguageFromPath(pathname) {
    const extension = pathname.split('.').pop()?.toLowerCase();
    const byExtension = {
      js: 'javascript',
      jsx: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      py: 'python',
      java: 'java',
      rs: 'rust',
      go: 'go',
      sh: 'bash',
      bash: 'bash',
      zsh: 'bash',
      sql: 'sql',
      html: 'html',
      css: 'css',
      scss: 'css',
      json: 'json',
      yml: 'yaml',
      yaml: 'yaml',
      rb: 'ruby',
      php: 'php',
      cpp: 'cpp',
      cc: 'cpp',
      cxx: 'cpp',
      c: 'c',
      swift: 'swift',
      md: 'markdown'
    };
    return byExtension[extension] || '';
  }

  function getPrimaryContentRoot(pageType) {
    const candidatesByType = {
      'github-code': [
        '.repository-content',
        '.blob-wrapper',
        '.js-file-content',
        '.react-code-view',
        'main'
      ],
      'github-pr': [
        '[data-testid="pull-request-tab-content"]',
        '.pull-discussion-timeline',
        '.repository-content',
        'main'
      ],
      'github-issue': [
        '.gh-header-show',
        '.js-issue-title',
        '.Layout-main',
        'main'
      ],
      'jira-ticket': [
        '[data-testid="issue.views.issue-base.foundation.content"]',
        '[data-testid="issue.views.issue-base.foundation.summary"]',
        'main'
      ],
      'confluence-doc': [
        '#main-content',
        '.wiki-content',
        'main'
      ],
      article: ['article', 'main'],
      documentation: ['main', 'article'],
      technical: ['main', 'article'],
      general: ['main', 'article', '[role="main"]', 'body']
    };

    const selectors = candidatesByType[pageType] || candidatesByType.general;
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node && node.innerText?.trim()) return node;
    }

    return document.body;
  }

  function getGitHubBlobCodeBlocks() {
    const lines = Array.from(
      document.querySelectorAll(
        '.react-code-text, .react-code-cell, .blob-code-inner, td.blob-code, td.blob-code-inner'
      )
    )
      .map(node => normalizeCodeText(node.innerText || node.textContent || ''))
      .filter(Boolean);

    if (!lines.length) return [];

    const joined = lines.join('\n').slice(0, 5000);
    if (!looksLikeCode(joined)) return [];

    return [{
      lang: detectCodeLanguageFromPath(window.location.pathname) || 'unknown',
      code: joined
    }];
  }

  function normalizeCodeText(text) {
    return (text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\t/g, '  ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function dedupeCodeBlocks(blocks) {
    const seen = new Set();
    return blocks.filter(block => {
      const key = `${block.lang}:${block.code.slice(0, 220)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function looksLikeCode(text) {
    if (!text || text.length < 24) return false;
    const codeIndicators = [
      '{', '}', '=>', '();', 'const ', 'let ', 'function ', 'class ', 'import ',
      'export ', 'return ', '</', '/>', '#include', 'def ', 'SELECT ', 'FROM '
    ];
    const lineCount = text.split('\n').length;
    return lineCount >= 2 || codeIndicators.some(token => text.includes(token));
  }

  // ──────────────────────────────────────────────────────
  // Message listener — responds to service worker requests
  // ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_PAGE_CONTEXT') {
      try {
        const context = extractPageContext();
        sendResponse({ success: true, context });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
      return true; // Keep channel open for async
    }

    if (msg.type === 'GET_SELECTION') {
      sendResponse({ selectedText: getSelectedText() });
      return true;
    }
  });
})();
