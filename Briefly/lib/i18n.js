// Tiny helper to localize static markup with chrome.i18n. Elements opt in via
// data-i18n (textContent), data-i18n-title (title attr) and
// data-i18n-ph (placeholder attr). Missing messages fall back to whatever the
// markup already contains, so untranslated strings degrade gracefully.

export function t(key, subs) {
  try {
    return (chrome?.i18n?.getMessage(key, subs)) || '';
  } catch (_) {
    return '';
  }
}

export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const msg = t(el.dataset.i18n);
    if (msg) el.textContent = msg;
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const msg = t(el.dataset.i18nTitle);
    if (msg) el.title = msg;
  }
  for (const el of root.querySelectorAll('[data-i18n-ph]')) {
    const msg = t(el.dataset.i18nPh);
    if (msg) el.placeholder = msg;
  }
  const title = t('appName');
  if (title) document.title = title;
}
