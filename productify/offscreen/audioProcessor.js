/**
 * Productify — audioProcessor.js (Offscreen Document)
 * Web Audio API capture, waveform data streaming, and audio blob creation.
 * Runs in the MV3 offscreen document for getUserMedia() access.
 */

(function () {
  'use strict';

  let mediaRecorder = null;
  let audioStream = null;
  let audioContext = null;
  let analyserNode = null;
  let audioChunks = [];
  let waveformInterval = null;

  function notifyBackground(message) {
    // Offscreen events are fire-and-forget; avoid surfacing noise if the
    // service worker is restarting while we emit telemetry-like updates.
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  // ──────────────────────────────────────────────────────
  // Message listener from service worker
  // ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'START_RECORDING':
        await startRecording(msg.config || {});
        sendResponse({ success: true });
        break;

      case 'STOP_RECORDING':
        const audioBlob = await stopRecording();
        sendResponse({ success: true, hasAudio: audioBlob !== null });
        break;

      case 'CANCEL_RECORDING':
        cancelRecording();
        sendResponse({ success: true });
        break;
    }
    return true;
  });

  async function startRecording(config = {}) {
    try {
      // Request mic access
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      // Set up Web Audio API for waveform visualization
      audioContext = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(audioStream);
      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 256;
      analyserNode.smoothingTimeConstant = 0.7;
      source.connect(analyserNode);

      // Determine MIME type
      const mimeType = getSupportedMimeType();
      audioChunks = [];

      mediaRecorder = new MediaRecorder(audioStream, { mimeType });
      mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        await processAndSendAudio(mimeType);
      };

      mediaRecorder.start(250); // Collect chunks every 250ms

      // Stream waveform data to side panel via service worker
      streamWaveform();

      // Notify service worker that recording started
      notifyBackground({ type: 'RECORDING_STARTED' });
    } catch (err) {
      notifyBackground({
        type: 'RECORDING_ERROR',
        error: err.name === 'NotAllowedError' ? 'mic_denied' : 'mic_error',
        message: err.message
      });
    }
  }

  async function stopRecording() {
    stopWaveform();
    return new Promise(resolve => {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        cleanupAudio();
        resolve(null);
        return;
      }
      mediaRecorder.onstop = async () => {
        const blob = await processAndSendAudio();
        cleanupAudio();
        resolve(blob);
      };
      mediaRecorder.stop();
    });
  }

  function cancelRecording() {
    stopWaveform();
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    audioChunks = [];
    cleanupAudio();
    notifyBackground({ type: 'RECORDING_CANCELLED' });
  }

  async function processAndSendAudio(mimeType) {
    if (audioChunks.length === 0) return null;

    const blob = new Blob(audioChunks, { type: mimeType || 'audio/webm' });
    audioChunks = [];

    if (blob.size < 1000) {
      // Too small — likely silence
      notifyBackground({ type: 'AUDIO_TOO_SHORT' });
      return null;
    }

    // Convert to base64 for messaging
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    reader.onloadend = () => {
      notifyBackground({
        type: 'AUDIO_READY',
        audioData: reader.result,
        mimeType: blob.type,
        size: blob.size
      });
    };
    return blob;
  }

  function streamWaveform() {
    if (!analyserNode) return;
    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    waveformInterval = setInterval(() => {
      // If recording has been cleaned up, stop streaming to avoid null access
      if (!analyserNode) {
        stopWaveform();
        return;
      }
      analyserNode.getByteTimeDomainData(dataArray);
      // Send compact waveform sample (every 4th point)
      const sample = Array.from(dataArray.filter((_, i) => i % 4 === 0));
      notifyBackground({
        type: 'WAVEFORM_DATA',
        data: sample
      });
    }, 50); // 20fps waveform updates
  }

  function stopWaveform() {
    if (waveformInterval) {
      clearInterval(waveformInterval);
      waveformInterval = null;
    }
  }

  function cleanupAudio() {
    if (audioStream) {
      audioStream.getTracks().forEach(t => t.stop());
      audioStream = null;
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    analyserNode = null;
  }

  function getSupportedMimeType() {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }
})();
