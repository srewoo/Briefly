import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVocab, applyVocab } from '../Briefly/lib/vocab.js';

test('parseVocab splits on commas and newlines, trims, drops blanks', () => {
  assert.deepEqual(parseVocab('Kubernetes, Anthropic\n Rewoo ,,\n'), ['Kubernetes', 'Anthropic', 'Rewoo']);
  assert.deepEqual(parseVocab(''), []);
  assert.deepEqual(parseVocab(undefined), []);
});

test('applyVocab canonicalizes casing of exact word matches', () => {
  assert.equal(applyVocab('i love kubernetes and ANTHROPIC', ['Kubernetes', 'Anthropic']),
    'i love Kubernetes and Anthropic');
});

test('applyVocab only replaces whole words', () => {
  assert.equal(applyVocab('kubernetese is not kubernetes', ['Kubernetes']),
    'kubernetese is not Kubernetes');
});

test('applyVocab is a no-op with no terms', () => {
  assert.equal(applyVocab('hello world', []), 'hello world');
  assert.equal(applyVocab('', ['X']), '');
});

test('applyVocab does not throw on regex-metachar terms', () => {
  assert.doesNotThrow(() => applyVocab('use c++ and c# and .net', ['C++', 'C#', '.NET']));
});
