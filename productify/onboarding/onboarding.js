/**
 * Productify — onboarding.js
 * 6-step interactive first-run tutorial controller
 */
'use strict';

const TOTAL_STEPS = 6;
let currentStep = 0;
let micGranted = false;
let keyValid = false;

const $ = id => document.getElementById(id);

// ──────────────────────────────────────────────
// STEP NAV
// ──────────────────────────────────────────────
function goToStep(n) {
  const prev = $(`step-${currentStep}`);
  prev.classList.add('exit');
  setTimeout(() => prev.classList.remove('active', 'exit'), 350);

  currentStep = n;

  const next = $(`step-${currentStep}`);
  next.classList.add('active');

  // Update progress
  $('progress-fill').style.width = `${((currentStep + 1) / TOTAL_STEPS) * 100}%`;

  // Update dots
  document.querySelectorAll('.step-dot').forEach((dot, i) => {
    dot.classList.toggle('done', i < currentStep);
    dot.classList.toggle('active', i === currentStep);
  });

  // Update button labels
  const btnNext = $('btn-next');
  const btnSkip = $('btn-skip');

  if (currentStep === TOTAL_STEPS - 1) {
    btnNext.textContent = '🎉 Open Productify';
    btnNext.classList.add('finish');
    btnSkip.style.display = 'none';
  } else {
    btnNext.textContent = 'Continue →';
    btnNext.classList.remove('finish');
    btnSkip.style.display = '';
  }

  // Step-specific logic
  if (currentStep === 1) {
    btnNext.disabled = !micGranted;
  } else if (currentStep === 2) {
    btnNext.disabled = false; // Key is optional to proceed (can skip)
  } else {
    btnNext.disabled = false;
  }
}

function nextStep() {
  if (currentStep === 0) { goToStep(1); return; }
  if (currentStep === 1 && !micGranted) { requestMic(); return; }
  if (currentStep === TOTAL_STEPS - 1) { finish(); return; }
  goToStep(currentStep + 1);
}

async function finish() {
  await chrome.storage.local.set({ firstRunDone: true });
  // Best effort: onboarding usually lives in its own tab, so just close it.
  window.close();
}

// ──────────────────────────────────────────────
// MIC PERMISSION
// ──────────────────────────────────────────────
async function requestMic() {
  const status = $('mic-status');
  const micBtn = $('mic-demo-btn');
  status.textContent = '⏳ Requesting...';
  status.className = 'key-status validating';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    micGranted = true;
    micBtn.textContent = '✅';
    micBtn.classList.add('granted');
    status.textContent = '✅ Microphone access granted!';
    status.className = 'key-status valid';
    $('btn-next').disabled = false;
    $('btn-next').textContent = 'Continue →';
    setTimeout(() => goToStep(2), 800);
  } catch (err) {
    status.textContent = '❌ Permission denied. Please allow mic access in Chrome settings.';
    status.className = 'key-status invalid';
  }
}

// ──────────────────────────────────────────────
// API KEY VALIDATION
// ──────────────────────────────────────────────
async function validateKey() {
  const key = $('ob-openai-key').value.trim();
  const status = $('key-status');
  const btn = $('btn-validate-key');

  if (!key.startsWith('sk-')) {
    status.textContent = '❌ OpenAI keys start with "sk-"';
    status.className = 'key-status invalid';
    return;
  }

  btn.textContent = 'Checking...';
  btn.disabled = true;
  status.textContent = '⏳ Validating with OpenAI...';
  status.className = 'key-status validating';

  try {
    // Validate key by making a minimal request to OpenAI directly.
    const testRes = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${key}` }
    });
    if (testRes.status === 401) {
      status.textContent = '❌ Invalid key — OpenAI rejected it.';
      status.className = 'key-status invalid';
    } else {
      keyValid = true;
      status.textContent = '✅ Valid key! Saving securely...';
      status.className = 'key-status valid';
      // Store via service worker
      await chrome.runtime.sendMessage({ type: 'STORE_KEYS', keys: { openai: key } });
    }
  } catch (err) {
    status.textContent = `⚠️ Couldn't validate the key (${err.message}). Key saved anyway.`;
    status.className = 'key-status invalid';
    // Still try to save the key
    if (key.startsWith('sk-')) {
      await chrome.runtime.sendMessage({ type: 'STORE_KEYS', keys: { openai: key } });
    }
  } finally {
    btn.textContent = 'Validate';
    btn.disabled = false;
  }
}

// ──────────────────────────────────────────────
// EVENT BINDINGS
// ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  $('btn-next').addEventListener('click', nextStep);
  $('btn-skip').addEventListener('click', () => {
    if (currentStep < TOTAL_STEPS - 1) goToStep(currentStep + 1);
    else finish();
  });

  $('mic-demo-btn').addEventListener('click', requestMic);
  $('btn-validate-key').addEventListener('click', validateKey);
  $('ob-openai-key').addEventListener('keydown', e => {
    if (e.key === 'Enter') validateKey();
  });

  // Dot navigation
  document.querySelectorAll('.step-dot').forEach((dot, i) => {
    dot.addEventListener('click', () => {
      if (i <= currentStep || i === currentStep + 1) goToStep(i);
    });
  });
});
