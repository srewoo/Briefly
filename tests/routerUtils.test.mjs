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
