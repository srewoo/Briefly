import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, floatTo16BitPCM, episodeFormat, isMp3Type } from '../Briefly/lib/wav.js';

const str = (view, off, len) => {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
  return s;
};

test('encodeWav writes a valid RIFF/WAVE header', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const buf = encodeWav(samples, 16000);
  const view = new DataView(buf);
  assert.equal(str(view, 0, 4), 'RIFF');
  assert.equal(str(view, 8, 4), 'WAVE');
  assert.equal(str(view, 36, 4), 'data');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 16000, 'sample rate');
  assert.equal(view.getUint16(34, true), 16, 'bits per sample');
});

test('encodeWav sizes the buffer and data chunk correctly', () => {
  const samples = new Float32Array(100);
  const buf = encodeWav(samples, 44100);
  assert.equal(buf.byteLength, 44 + 100 * 2);
  const view = new DataView(buf);
  assert.equal(view.getUint32(40, true), 200, 'data chunk = samples*2');
  assert.equal(view.getUint32(4, true), 36 + 200, 'RIFF size = 36 + data');
});

test('episodeFormat picks mp3 only when every segment is mp3', () => {
  assert.equal(isMp3Type('audio/mpeg'), true);
  assert.equal(isMp3Type('audio/wav'), false);
  assert.equal(episodeFormat(['audio/mpeg', 'audio/mpeg']), 'mp3');
  assert.equal(episodeFormat(['audio/mpeg', 'audio/wav']), 'wav', 'mixed → wav (the bug fix)');
  assert.equal(episodeFormat(['audio/wav']), 'wav');
  assert.equal(episodeFormat([]), 'wav', 'empty is safe');
});

test('floatTo16BitPCM clamps and scales', () => {
  const pcm = floatTo16BitPCM(new Float32Array([0, 1, -1, 2, -2]));
  assert.equal(pcm[0], 0);
  assert.equal(pcm[1], 0x7fff);
  assert.equal(pcm[2], -0x8000);
  assert.equal(pcm[3], 0x7fff, 'clamped above 1');
  assert.equal(pcm[4], -0x8000, 'clamped below -1');
});
