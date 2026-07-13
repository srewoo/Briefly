import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPageType, batchParagraphs } from '../Briefly/lib/listen-utils.js';

test('detectPageType recognizes known dev surfaces', () => {
  assert.equal(detectPageType('https://acme.atlassian.net/browse/ABC-123'), 'Jira issue');
  assert.equal(detectPageType('https://acme.atlassian.net/wiki/spaces/X/pages/1'), 'Confluence page');
  assert.equal(detectPageType('https://gitlab.com/g/p/-/merge_requests/42'), 'GitLab merge request');
  assert.equal(detectPageType('https://github.com/o/r/pull/7'), 'GitHub pull request');
  assert.equal(detectPageType('https://x.com/reference/', 'API'), 'API documentation');
});

test('detectPageType returns null for ordinary pages', () => {
  assert.equal(detectPageType('https://example.com/blog/post'), null);
  assert.equal(detectPageType('', ''), null);
});

test('batchParagraphs groups under the char budget without splitting paragraphs', () => {
  const paras = [
    { text: 'a'.repeat(30) },
    { text: 'b'.repeat(30) },
    { text: 'c'.repeat(30) }
  ];
  const batches = batchParagraphs(paras, 50);
  assert.equal(batches.length, 3, 'each 30-char para exceeds a 50 budget when combined');
  assert.deepEqual(batches.map(b => b.length), [1, 1, 1]);
});

test('batchParagraphs packs multiple small paragraphs together', () => {
  const paras = [{ text: 'aa' }, { text: 'bb' }, { text: 'cc' }];
  const batches = batchParagraphs(paras, 100);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
});

test('batchParagraphs handles empty input', () => {
  assert.deepEqual(batchParagraphs([], 100), []);
});
