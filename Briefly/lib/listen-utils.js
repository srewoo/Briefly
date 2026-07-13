// Pure helpers for the Listen tab, extracted from listen.js so they can be
// unit-tested without a DOM and reused by the service worker's headless
// read-page shortcut.

// Detect a known page type from URL + title, for the "Technical brief" mode.
export function detectPageType(url, title = '') {
  const u = (url || '').toLowerCase();
  if (/atlassian\.net\/browse\/|\/jira\/|jira\./.test(u)) return 'Jira issue';
  if (/atlassian\.net\/wiki|confluence/.test(u)) return 'Confluence page';
  if (/\/-\/merge_requests\/\d+/.test(u)) return 'GitLab merge request';
  if (/github\.com\/.+\/pull\/\d+/.test(u)) return 'GitHub pull request';
  if (/swagger|openapi|\/api-docs|\/reference\/|readme\.io/.test(u + ' ' + title.toLowerCase())) {
    return 'API documentation';
  }
  return null;
}

// Group source paragraphs into batches under a character budget, keeping
// paragraph boundaries intact.
export function batchParagraphs(paragraphs, maxChars) {
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
