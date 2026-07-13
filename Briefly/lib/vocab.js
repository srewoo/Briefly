// Custom dictation vocabulary. The user lists names/jargon they use; we (a)
// pass them to the AI cleanup pass so it spells them correctly, and (b) as a
// no-LLM fallback, canonicalize the casing of exact matches in the transcript.
// True mishearing correction ("Kubernetes" ← "cooper netties") needs the AI
// pass — the literal fallback only fixes capitalization of words that matched.

export function parseVocab(str) {
  if (!str) return [];
  return str.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyVocab(text, terms) {
  if (!text || !terms || !terms.length) return text || '';
  let out = text;
  for (const term of terms) {
    out = out.replace(new RegExp(`\\b${escapeRe(term)}\\b`, 'gi'), term);
  }
  return out;
}
