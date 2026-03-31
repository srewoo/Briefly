import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNotionBlocks,
  parseGitHubThread,
  buildAtlassianDoc,
  escapeHtml,
  resolveGitHubRouteMode,
  resolveJiraRouteMode
} from '../Briefly/background/routerUtils.mjs';

test('parseGitHubThread extracts repo, kind, and number', () => {
  const parsed = parseGitHubThread({ url: 'https://github.com/openai/briefly/pull/42' });
  assert.deepEqual(parsed, {
    repo: 'openai/briefly',
    kind: 'pull request',
    number: 42
  });
});

test('resolveGitHubRouteMode honors explicit create override', () => {
  const route = resolveGitHubRouteMode({ url: 'https://github.com/openai/briefly/issues/42' }, { mode: 'create' });
  assert.equal(route.mode, 'create');
  assert.equal(route.thread, null);
});

test('resolveJiraRouteMode picks current ticket in auto mode', () => {
  const route = resolveJiraRouteMode({
    pageType: 'jira-ticket',
    domainArtifacts: { issueKey: 'BRF-101' }
  }, { mode: 'auto' });

  assert.deepEqual(route, { mode: 'comment', issueKey: 'BRF-101' });
});

test('buildAtlassianDoc returns structured paragraphs', () => {
  const doc = buildAtlassianDoc('Line one\n\nLine two');
  assert.equal(doc.type, 'doc');
  assert.equal(doc.content.length, 2);
  assert.equal(doc.content[0].content[0].text, 'Line one');
});

test('buildNotionBlocks creates a heading and paragraphs', () => {
  const blocks = buildNotionBlocks('Alpha\n\nBeta', { intent: 'testing' });
  assert.equal(blocks[0].type, 'heading_2');
  assert.equal(blocks[1].paragraph.rich_text[0].text.content, 'Alpha');
});

test('escapeHtml encodes reserved characters', () => {
  assert.equal(escapeHtml('<tag attr="x">'), '&lt;tag attr=&quot;x&quot;&gt;');
});

// ─── Additional parseGitHubThread tests ───

test('parseGitHubThread returns null for non-GitHub URLs', () => {
  assert.equal(parseGitHubThread({ url: 'https://example.com' }), null);
  assert.equal(parseGitHubThread({ url: '' }), null);
  assert.equal(parseGitHubThread({}), null);
});

test('parseGitHubThread handles issue URLs', () => {
  const parsed = parseGitHubThread({ url: 'https://github.com/facebook/react/issues/123' });
  assert.deepEqual(parsed, { repo: 'facebook/react', kind: 'issue', number: 123 });
});

test('parseGitHubThread handles URL with extra path segments', () => {
  const parsed = parseGitHubThread({ url: 'https://github.com/owner/repo/pull/99/files' });
  assert.deepEqual(parsed, { repo: 'owner/repo', kind: 'pull request', number: 99 });
});

// ─── Additional resolveGitHubRouteMode tests ───

test('resolveGitHubRouteMode defaults to comment when on issue page', () => {
  const route = resolveGitHubRouteMode({ url: 'https://github.com/openai/briefly/issues/42' }, {});
  assert.equal(route.mode, 'comment');
  assert.ok(route.thread);
  assert.equal(route.thread.number, 42);
});

test('resolveGitHubRouteMode defaults to create when not on issue/PR page', () => {
  const route = resolveGitHubRouteMode({ url: 'https://github.com/openai/briefly' }, {});
  assert.equal(route.mode, 'create');
  assert.equal(route.thread, null);
});

test('resolveGitHubRouteMode honors explicit comment override', () => {
  const route = resolveGitHubRouteMode({ url: 'https://github.com/openai/briefly/pull/7' }, { mode: 'comment' });
  assert.equal(route.mode, 'comment');
});

// ─── Additional resolveJiraRouteMode tests ───

test('resolveJiraRouteMode defaults to create when no ticket detected', () => {
  const route = resolveJiraRouteMode({ pageType: 'general' }, {});
  assert.equal(route.mode, 'create');
  assert.equal(route.issueKey, '');
});

test('resolveJiraRouteMode honors explicit create override', () => {
  const route = resolveJiraRouteMode({ pageType: 'jira-ticket', domainArtifacts: { issueKey: 'BRF-99' } }, { mode: 'create' });
  assert.equal(route.mode, 'create');
  assert.equal(route.issueKey, '');
});

// ─── Additional buildNotionBlocks tests ───

test('buildNotionBlocks handles empty output', () => {
  const blocks = buildNotionBlocks('', {});
  assert.equal(blocks.length, 1); // Just the heading
  assert.equal(blocks[0].type, 'heading_2');
});

test('buildNotionBlocks limits paragraphs to 20', () => {
  const longOutput = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}`).join('\n\n');
  const blocks = buildNotionBlocks(longOutput, {});
  assert.ok(blocks.length <= 21); // 1 heading + max 20 paragraphs
});

test('buildNotionBlocks uses intent in heading', () => {
  const blocks = buildNotionBlocks('text', { intent: 'code_review' });
  assert.ok(blocks[0].heading_2.rich_text[0].text.content.includes('code_review'));
});

// ─── Additional buildAtlassianDoc tests ───

test('buildAtlassianDoc handles empty input', () => {
  const doc = buildAtlassianDoc('');
  assert.equal(doc.type, 'doc');
  assert.equal(doc.version, 1);
  assert.ok(doc.content.length >= 1);
});

test('buildAtlassianDoc truncates long paragraphs', () => {
  const longText = 'a'.repeat(10000);
  const doc = buildAtlassianDoc(longText);
  assert.ok(doc.content[0].content[0].text.length <= 5000);
});

// ─── escapeHtml edge cases ───

test('escapeHtml handles null/undefined', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(''), '');
});

test('escapeHtml handles single quotes', () => {
  assert.equal(escapeHtml("it's"), "it&#39;s");
});
