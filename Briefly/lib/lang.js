// Spoken-language helpers for STT, including the "Auto-detect" option.
//
// Provider support for auto-detect varies:
//  - Whisper (OpenAI / Groq): auto-detects when NO language is sent — we simply
//    omit the language param, which is already the default.
//  - Deepgram (batch): supports detect_language=true.
//  - AssemblyAI (batch): supports language_detection=true.
//  - Speechmatics / Web Speech: no reliable auto — we fall back to a concrete
//    language (navigator UI language for Web Speech, English for Speechmatics).

export const AUTO = 'auto';

// The languages offered in the STT language picker (Web Speech BCP-47 tags).
export const STT_LANGS = [
  { code: AUTO,   label: 'Auto-detect' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'es-ES', label: 'Spanish' },
  { code: 'fr-FR', label: 'French' },
  { code: 'de-DE', label: 'German' },
  { code: 'hi-IN', label: 'Hindi' },
  { code: 'ja-JP', label: 'Japanese' },
  { code: 'zh-CN', label: 'Chinese (Mandarin)' },
  { code: 'pt-BR', label: 'Portuguese (BR)' },
  { code: 'it-IT', label: 'Italian' }
];

export function isAuto(lang) {
  return !lang || lang === AUTO;
}

// Web Speech requires a concrete language tag. For "auto" we use the browser's
// UI language as the best available guess.
export function webSpeechLang(lang, navLang) {
  if (!isAuto(lang)) return lang;
  return navLang || 'en-US';
}
