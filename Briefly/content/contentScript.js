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

  // ──────────────────────────────────────────────────────
  // Performance budget: abort extraction if it takes too long
  // ──────────────────────────────────────────────────────
  const EXTRACTION_BUDGET_MS = 2000;
  const HEAVY_PAGE_THRESHOLD = 50000; // DOM nodes
  let lastExtractionDuration = 0;

  function isHeavyPage() {
    // Quick heuristic: count top-level + major container nodes
    const nodeCount = document.querySelectorAll('*').length;
    return nodeCount > HEAVY_PAGE_THRESHOLD;
  }

  function withBudget(fn, fallback) {
    const start = performance.now();
    try {
      const remaining = EXTRACTION_BUDGET_MS - (performance.now() - extractionStartTime);
      if (remaining <= 0) return fallback;
      return fn();
    } catch {
      return fallback;
    }
  }

  let extractionStartTime = 0;

  /**
   * Extract all 10 context signals from the current page with performance budgeting.
   * Returns a structured context object.
   */
  function extractPageContext() {
    extractionStartTime = performance.now();
    const heavy = isHeavyPage();

    const pageType = detectPageType();
    const visibleTextLimit = heavy ? Math.min(getVisibleTextLimit(pageType), 800) : getVisibleTextLimit(pageType);

    const ctx = {
      pageTitle: document.title || '',
      url: window.location.href,
      domain: window.location.hostname,
      pageType,
      selectedText: getSelectedText(),
      visibleText: withBudget(() => getVisibleText(pageType, visibleTextLimit), ''),
      visibleTextLimit,
      codeBlocks: withBudget(() => heavy ? getCodeBlocks(pageType).slice(0, 3) : getCodeBlocks(pageType), []),
      headings: withBudget(() => getHeadings(), []),
      structuredData: withBudget(() => getStructuredData(), {}),
      formFields: withBudget(() => getFormContext(), []),
      imageAltTexts: withBudget(() => getImageAlts(), []),
      domainArtifacts: withBudget(() => getDomainArtifacts(pageType), {}),
      domainContext: getDomainContext(),
      extractedAt: Date.now()
    };

    lastExtractionDuration = performance.now() - extractionStartTime;
    ctx._extractionMs = Math.round(lastExtractionDuration);
    ctx._isHeavyPage = heavy;

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

  function getDomainArtifacts(pageType) {
    switch (pageType) {
      case 'github-pr':
        return extractGitHubPrArtifacts();
      case 'github-code':
        return extractGitHubCodeArtifacts();
      case 'github-issue':
        return extractGitHubIssueArtifacts();
      case 'jira-ticket':
        return extractJiraArtifacts();
      case 'confluence-doc':
        return extractConfluenceArtifacts();
      case 'notion-page':
        return extractNotionArtifacts();
      case 'slack':
        return extractSlackArtifacts();
      case 'linear-issue':
        return extractLinearArtifacts();
      default:
        return {};
    }
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

  function extractGitHubPrArtifacts() {
    const pathParts = window.location.pathname.split('/').filter(Boolean);
    const pullIndex = pathParts.indexOf('pull');
    return compactObject({
      repository: getGitHubRepoFromPath(),
      pullNumber: pullIndex >= 0 ? pathParts[pullIndex + 1] || '' : '',
      pullRequestTitle: firstText([
        '[data-testid="issue-title"]',
        '.js-issue-title',
        '.gh-header-title .js-issue-title',
        '.markdown-title'
      ]),
      state: firstText(['[data-testid="issue-state"]', '.State']),
      baseBranch: firstText(['.base-ref', '[data-testid="base-ref"]']),
      headBranch: firstText(['.head-ref', '[data-testid="head-ref"]']),
      changedFiles: uniqueTexts([
        '[data-path]',
        '.file-header [title]',
        '.file-info a',
        '[data-testid="changed-file-header"]'
      ], { max: 20, attr: 'data-path' }),
      labels: uniqueTexts(['[data-testid="issue-labels"] a', '.IssueLabel', '.js-issue-labels a'], { max: 10 }),
      reviewers: uniqueTexts(['[aria-label*="Reviewers"] img[alt]', '[data-testid="reviewers"] img[alt]'], { max: 8, attr: 'alt' }),
      checks: uniqueTexts(['[data-testid="mergebox"] [title]', '[data-testid="status-check-rollup"]'], { max: 8, maxLength: 180 }),
      reviewComments: uniqueTexts([
        '.review-comment .comment-body',
        '.js-comment-body',
        '[data-testid="comment-body"]',
        '.comment-body.markdown-body'
      ], { max: 8 }),
      reviewThreads: document.querySelectorAll('.js-resolvable-thread-container, [data-testid="review-thread"]').length || 0
    });
  }

  function extractGitHubCodeArtifacts() {
    const pathParts = window.location.pathname.split('/').filter(Boolean);
    const filePathIndex = pathParts.indexOf('blob');

    return compactObject({
      repository: getGitHubRepoFromPath(),
      branch: filePathIndex >= 0 ? pathParts[filePathIndex + 1] || '' : '',
      filePath: filePathIndex >= 0 ? pathParts.slice(filePathIndex + 2).join('/') : '',
      fileName: filePathIndex >= 0 ? pathParts[pathParts.length - 1] || '' : '',
      codeSymbolCount: document.querySelectorAll('.react-code-text, .blob-code-inner, td.blob-code').length || 0
    });
  }

  function extractGitHubIssueArtifacts() {
    return compactObject({
      repository: getGitHubRepoFromPath(),
      issueTitle: firstText(['[data-testid="issue-title"]', '.js-issue-title']),
      state: firstText(['[data-testid="issue-state"]', '.State']),
      comments: uniqueTexts(['.js-comment-body', '[data-testid="comment-body"]'], { max: 8 })
    });
  }

  function extractJiraArtifacts() {
    return compactObject({
      issueKey: firstText([
        '[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]',
        '[data-testid="issue.views.issue-base.foundation.key-val"]',
        '[data-testid="issue-key"]'
      ]) || matchIssueKeyFromUrl(),
      summary: firstText(['[data-testid="issue.views.issue-base.foundation.summary.heading"]', 'h1']),
      status: firstText([
        '[data-testid="issue.views.issue-base.foundation.status.status-field-wrapper"]',
        '[data-testid="issue-status-field"]'
      ]),
      priority: firstText([
        '[data-testid="issue.views.issue-base.foundation.priority.priority-field-wrapper"]',
        '[data-testid="issue-priority-field"]'
      ]),
      assignee: firstText([
        '[data-testid="issue.views.issue-base.foundation.people.assignee"]',
        '[data-testid="issue-field-assignee"]'
      ]),
      reporter: firstText([
        '[data-testid="issue.views.issue-base.foundation.people.reporter"]',
        '[data-testid="issue-field-reporter"]'
      ]),
      labels: uniqueTexts([
        '[data-testid="issue.views.issue-base.foundation.labels.labels-field-wrapper"] span',
        '[data-testid="issue-field-labels"] span'
      ], { max: 10 }),
      description: firstText([
        '[data-testid="issue.views.field.rich-text.description"]',
        '[data-testid="issue.views.issue-base.foundation.description.description-field"]'
      ], 500),
      comments: uniqueTexts([
        '[data-testid="issue.activity.comment"]',
        '[data-testid="comment-body"]'
      ], { max: 6, maxLength: 240 }),
      commentCount: document.querySelectorAll('[data-testid="issue.activity.comment"], [data-testid="comment-body"]').length || 0
    });
  }

  function extractSlackArtifacts() {
    return compactObject({
      workspace: firstText(['[data-qa="workspace_name"]', '[data-testid="team-name"]']),
      channel: firstText(['[data-qa="channel_name"]', '[data-qa="channel_header_title"]', 'h1']),
      threadTitle: firstText(['[data-qa="thread_title"]', '[data-qa="message_input_label"]']),
      composerPlaceholder: firstText(['[data-qa="message_input"]', '[data-qa="message_input_label"]']),
      recentMessages: uniqueTexts([
        '[data-qa="message-text"]',
        '.p-rich_text_section',
        '[data-qa="virtual-list-item"]'
      ], { max: 8, maxLength: 220 }),
      participantNames: uniqueTexts([
        '[data-qa="message_sender_name"]',
        '[data-qa="virtual-list-item"] [data-qa="message_sender_name"]'
      ], { max: 8, maxLength: 80 })
    });
  }

  function extractLinearArtifacts() {
    return compactObject({
      issueId: matchIssueKeyFromUrl(),
      title: firstText(['h1', '[data-testid="issue-title"]']),
      status: firstText(['[data-testid="issue-status"]', '[aria-label="Status"]']),
      assignee: firstText(['[data-testid="issue-assignee"]', '[aria-label="Assignee"]']),
      priority: firstText(['[data-testid="issue-priority"]', '[aria-label="Priority"]']),
      project: firstText(['[data-testid="issue-project"]', '[aria-label="Project"]']),
      comments: uniqueTexts(['[data-testid="comment-body"]', 'article'], { max: 5, maxLength: 220 })
    });
  }

  function extractConfluenceArtifacts() {
    return compactObject({
      space: firstText(['[data-testid="space-page-title"]', '.aui-page-panel-content h1']),
      breadcrumbTrail: uniqueTexts(['nav[aria-label="Breadcrumb"] a', '.ia-secondary-container a'], { max: 8, maxLength: 120 }),
      sectionHeadings: uniqueTexts(['#main-content h1', '#main-content h2', '#main-content h3'], { max: 12, maxLength: 120 }),
      calloutTitles: uniqueTexts(['.confluence-information-macro .title', '.aui-message-title'], { max: 6 }),
      tableCount: document.querySelectorAll('#main-content table').length || 0
    });
  }

  function extractNotionArtifacts() {
    return compactObject({
      workspace: firstText(['[data-testid="workspace-title"]', '[data-testid="breadcrumbs"]']),
      pageTitle: firstText(['main h1', '[data-content-editable-leaf="true"] h1', '[placeholder="Untitled"]']),
      breadcrumbs: uniqueTexts(['nav[aria-label="Breadcrumb"] a', '[data-testid="breadcrumbs"] a'], { max: 8, maxLength: 120 }),
      toggleHeadings: uniqueTexts(['main h1', 'main h2', 'main h3'], { max: 12, maxLength: 120 }),
      todoItems: uniqueTexts(['[role="checkbox"] + div', '[data-testid="checkbox"] + div'], { max: 8, maxLength: 160 }),
      databasePropertyCount: document.querySelectorAll('[data-testid="property-row"], [data-block-id]').length || 0
    });
  }

  function getGitHubRepoFromPath() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : '';
  }

  function matchIssueKeyFromUrl() {
    const match = window.location.href.match(/([A-Z][A-Z0-9]+-\d+)/);
    return match ? match[1] : '';
  }

  function firstText(selectors, maxLength = 160) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = normalizeSnippet(node?.innerText || node?.textContent || '');
      if (text) return text.slice(0, maxLength);
    }
    return '';
  }

  function uniqueTexts(selectors, options = {}) {
    const {
      max = 10,
      maxLength = 160,
      attr = ''
    } = options;
    const seen = new Set();
    const values = [];

    selectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(node => {
        if (values.length >= max) return;
        const raw = attr ? node.getAttribute(attr) : (node.innerText || node.textContent || '');
        const text = normalizeSnippet(raw);
        if (!text || seen.has(text)) return;
        seen.add(text);
        values.push(text.slice(0, maxLength));
      });
    });

    return values;
  }

  function normalizeSnippet(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function compactObject(value) {
    return Object.fromEntries(
      Object.entries(value || {}).filter(([, current]) => {
        if (Array.isArray(current)) return current.length > 0;
        return current !== null && current !== undefined && current !== '';
      })
    );
  }

  function getPageActionTargets() {
    const selector = [
      'textarea',
      'input[type="text"]',
      'input[type="search"]',
      'input[type="email"]',
      'input[type="url"]',
      'input:not([type])',
      '[contenteditable="true"]',
      '[role="textbox"]'
    ].join(', ');

    const activeElement = document.activeElement;
    const targets = Array.from(document.querySelectorAll(selector))
      .filter(node => isEditableNode(node) && isVisibleNode(node))
      .map((node, index) => {
        const actionId = getOrAssignActionId(node, index);
        const value = getEditableValue(node);
        const submitActions = getSubmitActionsForNode(node);
        return {
          actionId,
          label: describeEditableNode(node),
          tagName: node.tagName.toLowerCase(),
          hasValue: Boolean(value.trim()),
          valuePreview: normalizeSnippet(value).slice(0, 140),
          active: node === activeElement,
          submitActions
        };
      });

    targets.sort((left, right) => Number(right.active) - Number(left.active));
    return targets.slice(0, 6);
  }

  function applyOutputToPage({ actionId, text, mode = 'auto', submitActionId = '' }) {
    const node = document.querySelector(`[data-briefly-action-id="${CSS.escape(actionId)}"]`);
    if (!node || !isEditableNode(node)) {
      throw new Error('The selected page field is no longer available.');
    }

    const currentValue = getEditableValue(node);
    const nextValue = resolveAppliedValue(currentValue, text, mode);

    node.focus();
    if (isTextInput(node)) {
      node.value = nextValue;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      node.textContent = nextValue;
      node.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }

    let triggeredActionLabel = '';
    if (submitActionId) {
      const actionNode = document.querySelector(`[data-briefly-submit-id="${CSS.escape(submitActionId)}"]`);
      if (!actionNode || !isVisibleNode(actionNode)) {
        throw new Error('The selected submit action is no longer available.');
      }
      triggeredActionLabel = describeSubmitAction(actionNode);
      actionNode.click();
    }

    return {
      actionId,
      label: describeEditableNode(node),
      appliedMode: currentValue.trim() ? (mode === 'replace' ? 'replace' : 'append') : 'replace',
      triggeredActionLabel
    };
  }

  function resolveAppliedValue(currentValue, text, mode) {
    const safeCurrent = currentValue || '';
    const safeText = text || '';
    if (mode === 'replace') return safeText;
    if (mode === 'append') {
      return safeCurrent.trim() ? `${safeCurrent.replace(/\s+$/g, '')}\n\n${safeText}` : safeText;
    }
    return safeCurrent.trim() ? `${safeCurrent.replace(/\s+$/g, '')}\n\n${safeText}` : safeText;
  }

  function getOrAssignActionId(node, index) {
    if (!node.dataset.brieflyActionId) {
      node.dataset.brieflyActionId = `briefly_${Date.now().toString(36)}_${index}`;
    }
    return node.dataset.brieflyActionId;
  }

  function getOrAssignSubmitActionId(node, index) {
    if (!node.dataset.brieflySubmitId) {
      node.dataset.brieflySubmitId = `briefly_submit_${Date.now().toString(36)}_${index}`;
    }
    return node.dataset.brieflySubmitId;
  }

  function describeEditableNode(node) {
    const explicitLabel = node.labels?.[0]?.innerText
      || node.getAttribute('aria-label')
      || node.getAttribute('placeholder')
      || node.getAttribute('name')
      || node.getAttribute('id');
    const label = normalizeSnippet(explicitLabel);
    if (label) return label.slice(0, 100);
    if (node.matches('[contenteditable], [role="textbox"]')) return 'Editable page region';
    return `${node.tagName.toLowerCase()} field`;
  }

  function getEditableValue(node) {
    if (isTextInput(node)) {
      return node.value || '';
    }
    return node.innerText || node.textContent || '';
  }

  function isTextInput(node) {
    return node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement;
  }

  function isEditableNode(node) {
    if (!(node instanceof HTMLElement)) return false;
    if (node instanceof HTMLInputElement && ['hidden', 'password', 'checkbox', 'radio', 'file'].includes(node.type)) {
      return false;
    }
    return isTextInput(node) || node.isContentEditable || node.getAttribute('role') === 'textbox';
  }

  function isVisibleNode(node) {
    if (!(node instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  }

  function getSubmitActionsForNode(node) {
    const form = node.closest('form');
    const buttons = form
      ? Array.from(form.querySelectorAll('button, input[type="submit"], [role="button"]'))
      : getNearbyButtons(node);

    return buttons
      .filter(button => isSubmitAction(button))
      .slice(0, 3)
      .map((button, index) => ({
        submitActionId: getOrAssignSubmitActionId(button, index),
        label: describeSubmitAction(button)
      }));
  }

  function getNearbyButtons(node) {
    const container = node.closest('section, article, div, main') || document.body;
    return Array.from(container.querySelectorAll('button, input[type="submit"], [role="button"]'))
      .filter(button => isVisibleNode(button))
      .sort((left, right) => distanceBetween(node, left) - distanceBetween(node, right));
  }

  function isSubmitAction(node) {
    if (!(node instanceof HTMLElement)) return false;
    if (!isVisibleNode(node)) return false;
    if (node instanceof HTMLInputElement && node.type === 'submit') return true;
    const text = describeSubmitAction(node).toLowerCase();
    return ['submit', 'send', 'save', 'comment', 'reply', 'post', 'create', 'update'].some(token => text.includes(token));
  }

  function describeSubmitAction(node) {
    return normalizeSnippet(
      node.innerText
        || node.textContent
        || node.getAttribute('aria-label')
        || node.getAttribute('value')
        || node.getAttribute('name')
    ).slice(0, 80) || 'Submit action';
  }

  function distanceBetween(a, b) {
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    return Math.abs(aRect.top - bRect.top) + Math.abs(aRect.left - bRect.left);
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

    if (msg.type === 'GET_PAGE_ACTIONS') {
      try {
        sendResponse({ success: true, actions: getPageActionTargets() });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
      return true;
    }

    if (msg.type === 'APPLY_OUTPUT_TO_PAGE') {
      try {
        const result = applyOutputToPage(msg);
        sendResponse({ success: true, result });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
      return true;
    }
  });
})();
