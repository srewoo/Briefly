// LLM helpers for the Listen tab — explain-while-reading rewrites, spoken
// summaries, and technical briefs. Groq preferred (fast/cheap), OpenAI fallback.
import { rfetch } from './providers.js';

const WORDS_PER_MIN = 150; // spoken pace used to size summaries

async function chatComplete({ system, user, keys, temperature = 0.3, maxTokens = 2048 }) {
  const useGroq = !!keys.groqKey;
  const apiKey = useGroq ? keys.groqKey : keys.openaiKey;
  if (!apiKey) throw new Error('Add a Groq (free) or OpenAI API key in Settings for AI modes.');
  const endpoint = useGroq
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';
  const model = useGroq ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini';
  const res = await rfetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  }, { label: 'LLM' });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LLM request failed: ${res.status} ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  const out = (j?.choices?.[0]?.message?.content || '').trim();
  if (!out) throw new Error('LLM returned an empty response.');
  return out;
}

// Split LLM prose into speakable segments (paragraph-ish chunks).
export function toSegments(text, srcIdx = -1) {
  return text
    .split(/\n{2,}|\n(?=[-*#•])/)
    .map(s => s.replace(/^[#*\-•\s]+/, '').replace(/\s+/g, ' ').trim())
    .filter(s => s.length > 2)
    .map(s => ({ text: s, srcIdx }));
}

// ─── Explain while reading ─────────────────────────────────
// Rewrites one batch of source paragraphs into plain spoken teaching language.
export async function explainBatch({ text, keys }) {
  return chatComplete({
    keys,
    temperature: 0.3,
    system:
      'You rewrite technical or formal text into clear spoken-word explanation, ' +
      'as if teaching a colleague. Plain language, short sentences, keep every ' +
      'technical fact accurate. Use analogies sparingly when they genuinely help. ' +
      'Never mention that you are rewriting. Output ONLY the rewritten prose — ' +
      'no headers, no markdown, no preamble.',
    user: text
  });
}

// ─── Spoken summary ────────────────────────────────────────
export async function generateSummary({ text, minutes, keys }) {
  const words = minutes * WORDS_PER_MIN;
  return chatComplete({
    keys,
    temperature: 0.3,
    maxTokens: Math.min(4096, Math.round(words * 2)),
    system:
      `You produce a spoken summary script of roughly ${words} words ` +
      `(~${minutes} minutes read aloud). Cover the key points, main arguments and ` +
      'important facts. Plain conversational language, no markdown, no headers, ' +
      'no "this article" meta-framing beyond one opening sentence. Output only the script.',
    user: text.slice(0, 24000)
  });
}

// ─── Technical brief ───────────────────────────────────────
// Structured engineer/SDET-oriented audio brief for Jira / Confluence /
// MR / API-doc pages.
export async function generateTechBrief({ text, pageType, keys }) {
  return chatComplete({
    keys,
    temperature: 0.2,
    maxTokens: 3072,
    system:
      `You brief a senior engineer/SDET about a ${pageType} they have not read. ` +
      'Produce a spoken script covering, in order: what this is, what changed or ' +
      'is proposed, why, risks and edge cases, impacted systems or components, ' +
      'and suggested tests. Introduce each part with a short spoken transition ' +
      '(e.g. "Now, the risks."). Be specific — pull real names, endpoints, and ' +
      'values from the document. Plain prose, no markdown. Output only the script.',
    user: text.slice(0, 24000)
  });
}

// ─── Two-host podcast ──────────────────────────────────────
// Returns validated [{ host: 'A'|'B', text }]. LLM output is never trusted:
// parse + validate strictly, retry once, then fail loudly.
export async function generatePodcastScript({ text, minutes, keys }) {
  const words = minutes * WORDS_PER_MIN;
  const ask = () => chatComplete({
    keys,
    temperature: 0.6,
    maxTokens: Math.min(4096, Math.round(words * 2.2)),
    system:
      'You convert an article into a two-host conversational podcast script. ' +
      'Host A explains; Host B asks sharp questions and reacts. Natural spoken ' +
      `dialogue, total ~${words} words (~${minutes} minutes). Stay faithful to ` +
      'the source facts. Respond with ONLY a JSON array, no markdown fences: ' +
      '[{"host":"A","text":"..."},{"host":"B","text":"..."}]',
    user: text.slice(0, 24000)
  });

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await ask();
    try {
      return parsePodcastScript(raw);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Podcast script generation failed: ${lastErr?.message || 'invalid output'}`);
}

export function parsePodcastScript(raw) {
  const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = jsonText.indexOf('[');
  const end = jsonText.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('no JSON array in output');
  const arr = JSON.parse(jsonText.slice(start, end + 1));
  if (!Array.isArray(arr) || arr.length < 2) throw new Error('script too short');
  const turns = arr.map((t) => {
    const host = String(t.host || '').trim().toUpperCase();
    const txt = String(t.text || '').replace(/\s+/g, ' ').trim();
    if (host !== 'A' && host !== 'B') throw new Error(`invalid host "${t.host}"`);
    if (!txt) throw new Error('empty turn');
    return { host, text: txt, srcIdx: -1 };
  });
  if (!turns.some(t => t.host === 'B')) throw new Error('single-host output');
  return turns;
}

// ─── Dictation cleanup ─────────────────────────────────────
// Turn a raw speech transcript into polished written text: punctuation,
// capitalization, filler removal, obvious-error fixes — without changing the
// meaning or wording. Honors the user's custom vocabulary spellings. Groq
// (free) is preferred; throws if no key (caller decides whether to skip).
export async function cleanupTranscript({ text, keys, vocabulary = [] }) {
  if (!text || !text.trim()) return text || '';
  const vocabLine = vocabulary.length
    ? ` The user often uses these names/terms — spell them exactly like this when they occur: ${vocabulary.join(', ')}.`
    : '';
  return chatComplete({
    keys,
    temperature: 0,
    maxTokens: 1024,
    system:
      'You clean up dictated speech into polished written text. Add correct ' +
      'punctuation and capitalization, remove filler words (um, uh, "like", ' +
      '"you know") and false starts/repetitions, and fix obvious transcription ' +
      'errors. Do NOT summarize, translate, answer, or change the meaning or ' +
      'the speaker\'s wording.' + vocabLine +
      ' Output ONLY the cleaned text, nothing else.',
    user: text
  });
}

// Rough cost note for the UI. Groq is effectively free; OpenAI mini is ~cents.
export function llmCostNote(keys) {
  return keys.groqKey ? '' : ' + ~$0.01 LLM';
}
