// Ranking for Web Speech voices. The browser's "default" voice is often the
// worst available, so we score explicitly and surface the good ones. Pure
// functions over voice-like objects ({ name, lang, localService, voiceURI }).

export const HQ_RE = /premium|enhanced|neural|natural|siri|\bgoogle\b/i;
export const LQ_RE = /compact|eloquence|albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|kathy|fred|ralph/i;

export function voiceScore(v) {
  let s = 0;
  if (HQ_RE.test(v.name)) s += 100;          // neural / premium / Google network
  if (/online|natural/i.test(v.name)) s += 40;
  if (LQ_RE.test(v.name)) s -= 100;          // novelty / compact / robotic
  if (!v.localService) s += 10;              // network voices tend to be better
  if (/^en[-_]/i.test(v.lang)) s += 5;       // bias English first for this UI
  return s;
}

export function isHQ(v) {
  return HQ_RE.test(v.name) && !LQ_RE.test(v.name);
}

// Return a new array sorted best-first: current UI language, then quality score,
// then name.
export function rankVoices(voices, uiLang = 'en') {
  const lang = (uiLang || 'en').slice(0, 2).toLowerCase();
  return voices.slice().sort((a, b) => {
    const la = a.lang.toLowerCase().startsWith(lang) ? 1 : 0;
    const lb = b.lang.toLowerCase().startsWith(lang) ? 1 : 0;
    if (la !== lb) return lb - la;
    const d = voiceScore(b) - voiceScore(a);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
}
