// Minimal PCM→WAV encoder. Used by the Listen player to build a single valid
// audio file when concatenating segments whose source format is NOT MP3
// (e.g. WAV from Groq/Deepgram, or a mix). Naive blob concat only yields a
// valid file for MP3 frame streams — WAV needs a single re-written header.

// True for MP3 blob MIME types (the only container that survives naive
// frame-concatenation into one valid file).
export function isMp3Type(type) {
  return /mpeg|mp3/i.test(type || '');
}

// Decide how to assemble an episode from per-segment blob MIME types:
// 'mp3' → concat directly; 'wav' → decode + re-encode (WAV or mixed sources).
export function episodeFormat(types) {
  return types.length && types.every(isMp3Type) ? 'mp3' : 'wav';
}

// Convert a Float32 PCM channel (-1..1) to interleaved 16-bit little-endian.
export function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Encode mono Float32 samples to a WAV ArrayBuffer (16-bit PCM).
export function encodeWav(float32, sampleRate = 16000) {
  const pcm = floatTo16BitPCM(float32);
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);   // file size - 8
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);              // fmt chunk size
  view.setUint16(20, 1, true);               // PCM
  view.setUint16(22, 1, true);               // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);  // byte rate (sampleRate * blockAlign)
  view.setUint16(32, 2, true);               // block align (channels * bytesPerSample)
  view.setUint16(34, 16, true);              // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return buffer;
}
