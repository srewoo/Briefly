/**
 * Briefly — intentClassifier.js (background)
 * Enhanced intent classifier with n-gram matching, TF-IDF scoring,
 * context-aware boosting, and learning from user corrections.
 */

const INTENT_PATTERNS = {
  summarize: {
    keywords: ['summarize', 'summary', 'key points', 'tldr', 'overview', 'give me a summary', 'main points', 'recap', 'brief', 'condense', 'digest', 'highlights', 'takeaways', 'wrap up', 'boil down'],
    weight: 1.0,
    contextBoost: { pageTypes: ['article', 'documentation', 'research-paper', 'confluence-doc'], boost: 0.15 }
  },
  prompt_generation: {
    keywords: ['create a prompt', 'generate a prompt', 'write a prompt', 'make a prompt', 'reusable prompt', 'prompt for', 'draft a prompt', 'prompt template', 'system prompt', 'instruction set'],
    weight: 1.0,
    contextBoost: { pageTypes: [], boost: 0 }
  },
  task_extraction: {
    keywords: ['action items', 'todo', 'to-do', 'tasks', 'extract tasks', 'list tasks', 'what needs to be done', 'next steps', 'deliverables', 'action points', 'follow ups', 'work items', 'backlog'],
    weight: 1.0,
    contextBoost: { pageTypes: ['jira-ticket', 'linear-issue', 'slack'], boost: 0.15 }
  },
  documentation: {
    keywords: ['document', 'documentation', 'write docs', 'api docs', 'readme', 'doc this', 'document this', 'write up', 'spec', 'technical doc', 'api reference', 'guide', 'how-to'],
    weight: 1.0,
    contextBoost: { pageTypes: ['github-code', 'documentation'], boost: 0.1 }
  },
  testing: {
    keywords: ['test cases', 'test', 'testing', 'generate tests', 'unit test', 'what to test', 'coverage', 'test scenarios', 'qa', 'quality assurance', 'test suite', 'test plan', 'edge cases', 'regression'],
    weight: 1.0,
    contextBoost: { pageTypes: ['github-pr', 'github-code'], boost: 0.12 }
  },
  code_review: {
    keywords: ['review', 'code review', 'review this', 'feedback on code', 'pr review', 'pull request', 'audit', 'check the code', 'issues with', 'bugs in', 'security review', 'review changes', 'diff review'],
    weight: 1.0,
    contextBoost: { pageTypes: ['github-pr', 'github-code'], boost: 0.2 }
  },
  user_story: {
    keywords: ['user story', 'as a user', 'acceptance criteria', 'agile', 'epic', 'feature story', 'write a story', 'user requirement', 'product requirement', 'use case'],
    weight: 1.0,
    contextBoost: { pageTypes: ['jira-ticket', 'linear-issue'], boost: 0.1 }
  },
  explain: {
    keywords: ['explain', 'what is', 'how does', 'break down', 'clarify', 'help me understand', 'what does this mean', 'describe', 'eli5', 'elaborate', "i don't understand", 'walk me through', 'what happens when'],
    weight: 1.0,
    contextBoost: { pageTypes: ['github-code', 'documentation', 'technical'], boost: 0.08 }
  },
  translate_intent: {
    keywords: ['translate', 'in english', 'in spanish', 'in french', 'in german', 'in japanese', 'in chinese', 'convert to', 'language', 'from english', 'into french', 'localize', 'in portuguese'],
    weight: 1.0,
    contextBoost: { pageTypes: [], boost: 0 }
  },
  email_draft: {
    keywords: ['email', 'draft email', 'write an email', 'compose', 'reply to', 'follow up', 'email draft', 'write a message', 'email template', 'send a message', 'draft a reply', 'respond to'],
    weight: 1.0,
    contextBoost: { pageTypes: ['slack'], boost: 0.15 }
  },
  compare: {
    keywords: ['compare', 'difference', 'versus', 'vs', 'contrast', "what's different", 'compare these', 'pros and cons', 'similarities', 'which is better', 'trade offs', 'tradeoffs'],
    weight: 1.0,
    contextBoost: { pageTypes: [], boost: 0 }
  }
};

const INTENT_ICONS = {
  summarize: 'S',
  prompt_generation: 'P',
  task_extraction: 'T',
  documentation: 'D',
  testing: 'Q',
  code_review: 'R',
  user_story: 'U',
  explain: 'E',
  translate_intent: 'L',
  email_draft: 'M',
  compare: 'C',
  custom: 'A'
};

/**
 * Generate n-grams from text for better phrase matching
 */
function generateNGrams(text, maxN = 4) {
  const words = text.split(/\s+/).filter(Boolean);
  const grams = new Set();
  for (let n = 1; n <= Math.min(maxN, words.length); n++) {
    for (let i = 0; i <= words.length - n; i++) {
      grams.add(words.slice(i, i + n).join(' '));
    }
  }
  return grams;
}

/**
 * Calculate IDF-like weight: rarer keywords across intents score higher
 */
function buildKeywordIDF() {
  const allKeywords = {};
  const intentCount = Object.keys(INTENT_PATTERNS).length;

  for (const { keywords } of Object.values(INTENT_PATTERNS)) {
    const unique = new Set(keywords);
    for (const kw of unique) {
      allKeywords[kw] = (allKeywords[kw] || 0) + 1;
    }
  }

  const idf = {};
  for (const [kw, count] of Object.entries(allKeywords)) {
    idf[kw] = Math.log(intentCount / count) + 1;
  }
  return idf;
}

const KEYWORD_IDF = buildKeywordIDF();

const IntentClassifier = {
  /**
   * Enhanced classify with n-gram matching, IDF scoring, context boost, and learning.
   */
  classify(transcript, context = {}) {
    if (!transcript || transcript.trim().length < 2) {
      return { primary_intent: 'custom', secondary_intent: null, confidence: 0, fallback: true };
    }

    const text = transcript.toLowerCase().trim();
    const ngrams = generateNGrams(text);
    const scores = {};

    // Score each intent with TF-IDF weighted matching
    for (const [intent, { keywords, weight, contextBoost }] of Object.entries(INTENT_PATTERNS)) {
      let score = 0;
      let matchCount = 0;

      for (const kw of keywords) {
        // Exact substring match
        if (text.includes(kw)) {
          const idf = KEYWORD_IDF[kw] || 1;
          score += (kw.split(/\s+/).length * 1.5) * weight * idf;
          matchCount++;
        }
        // N-gram match for multi-word keywords
        else if (kw.includes(' ') && ngrams.has(kw)) {
          const idf = KEYWORD_IDF[kw] || 1;
          score += (kw.split(/\s+/).length * 1.2) * weight * idf;
          matchCount++;
        }
      }

      // Diversity bonus: matching multiple different keywords is stronger signal
      if (matchCount > 1) {
        score *= 1 + (matchCount - 1) * 0.15;
      }

      // Context-aware boosting: boost score when page type matches
      if (contextBoost && context.pageType && contextBoost.pageTypes.includes(context.pageType)) {
        score *= 1 + contextBoost.boost;
      }

      if (score > 0) scores[intent] = score;
    }

    // Apply learned corrections
    const correctionBoost = this._getCorrectionBoost(text);
    for (const [intent, boost] of Object.entries(correctionBoost)) {
      scores[intent] = (scores[intent] || 0) + boost;
    }

    const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);

    if (sorted.length === 0) {
      return { primary_intent: 'custom', secondary_intent: null, confidence: 0.5, fallback: true };
    }

    const topScore = sorted[0][1];
    const secondScore = sorted[1]?.[1] || 0;
    // Confidence based on gap between top and second score
    const gap = secondScore > 0 ? (topScore - secondScore) / topScore : 0.5;
    const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
    const dominance = topScore / totalScore;
    const confidence = Math.min(0.99, (dominance * 0.6 + gap * 0.4));

    return {
      primary_intent: sorted[0][0],
      secondary_intent: sorted[1]?.[0] || null,
      confidence: Math.round(confidence * 100) / 100,
      fallback: confidence < 0.6,
      top3: sorted.slice(0, 3).map(([intent, score]) => ({ intent, score: Math.round(score * 100) / 100 })),
      matchDetails: {
        totalScore: Math.round(totalScore * 100) / 100,
        topScore: Math.round(topScore * 100) / 100,
        gap: Math.round(gap * 100) / 100
      }
    };
  },

  /**
   * Record a user correction to improve future classifications
   */
  async recordCorrection(transcript, predictedIntent, correctedIntent) {
    if (!transcript || predictedIntent === correctedIntent) return;

    try {
      const { intentCorrections = [] } = await chrome.storage.local.get('intentCorrections');
      const words = transcript.toLowerCase().trim().split(/\s+/).slice(0, 10);

      intentCorrections.push({
        words,
        predicted: predictedIntent,
        corrected: correctedIntent,
        timestamp: Date.now()
      });

      // Keep last 200 corrections
      const trimmed = intentCorrections.slice(-200);
      await chrome.storage.local.set({ intentCorrections: trimmed });
    } catch { /* non-critical */ }
  },

  /**
   * Get correction-based boosts for scoring
   */
  _getCorrectionBoost(text) {
    const boost = {};
    // This is synchronous — corrections are loaded async and cached
    if (!this._corrections) return boost;

    const words = new Set(text.split(/\s+/));
    for (const correction of this._corrections) {
      const overlap = correction.words.filter(w => words.has(w)).length;
      if (overlap >= 2) {
        const strength = overlap / correction.words.length;
        boost[correction.corrected] = (boost[correction.corrected] || 0) + strength * 2;
        boost[correction.predicted] = (boost[correction.predicted] || 0) - strength * 0.5;
      }
    }
    return boost;
  },

  /**
   * Load corrections from storage (call on startup)
   */
  async loadCorrections() {
    try {
      const { intentCorrections = [] } = await chrome.storage.local.get('intentCorrections');
      this._corrections = intentCorrections;
    } catch {
      this._corrections = [];
    }
  },

  getIcon(intent) {
    return INTENT_ICONS[intent] || INTENT_ICONS.custom;
  },

  getLabel(intent) {
    const labels = {
      summarize: 'Summarize',
      prompt_generation: 'Prompt Gen',
      task_extraction: 'Task Extract',
      documentation: 'Documentation',
      testing: 'Testing',
      code_review: 'Code Review',
      user_story: 'User Story',
      explain: 'Explain',
      translate_intent: 'Translate',
      email_draft: 'Email Draft',
      compare: 'Compare',
      custom: 'Custom'
    };
    return labels[intent] || 'Custom';
  }
};

// Load corrections on startup
if (typeof chrome !== 'undefined' && chrome.storage) {
  IntentClassifier.loadCorrections().catch(() => {});
}

if (typeof module !== 'undefined') module.exports = IntentClassifier;
if (typeof self !== 'undefined') self.IntentClassifier = IntentClassifier;
