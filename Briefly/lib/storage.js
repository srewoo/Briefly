// Settings + API key storage + simple history log.

const DEFAULTS = {
  sttProvider: 'webspeech',
  ttsProvider: 'webspeech',
  sttLang: 'en-US',
  ttsVoiceURI: '',
  // ElevenLabs
  elevenVoiceId: 'EXAVITQu4vr4xnSDxMaL',
  elevenModelId: 'eleven_multilingual_v2',
  elevenStability: 0.5,
  elevenSimilarity: 0.75,
  // OpenAI
  openaiTtsVoice: 'alloy',
  openaiTtsModel: 'tts-1',
  openaiSttModel: 'whisper-1',
  // Groq
  groqSttModel: 'whisper-large-v3-turbo',
  // Deepgram
  deepgramModel: 'nova-3',
  // StreamElements
  streamElementsVoice: 'Brian',
  // Google Translate TTS
  gtranslateLang: 'en',
  // UI
  theme: 'dark',
  // Translate target language for the Translate button (BCP-47 short code)
  translateTargetLang: 'en',
  // Web Speech TTS prosody
  ttsRate: 1.0,
  ttsPitch: 1.0,
  ttsVolume: 1.0,
  // Silence auto-stop (ms; 0 = disabled)
  silenceTimeoutMs: 2500,
  autoCopyTranscript: true,
  historyLimit: 50
};

const KEY_FIELDS = [
  'assemblyaiKey',
  'elevenlabsKey',
  'openaiKey',
  'deepgramKey',
  'groqKey'
];

export const Storage = {
  async getSettings() {
    const { settings = {} } = await chrome.storage.local.get('settings');
    return { ...DEFAULTS, ...settings };
  },
  async setSettings(patch) {
    const current = await this.getSettings();
    const next = { ...current, ...patch };
    await chrome.storage.local.set({ settings: next });
    return next;
  },
  async resetAll() {
    await chrome.storage.local.clear();
  },
  async getKeys() {
    const { apiKeys = {} } = await chrome.storage.local.get('apiKeys');
    const out = {};
    for (const f of KEY_FIELDS) out[f] = apiKeys[f] || '';
    return out;
  },
  async setKeys(patch) {
    const current = await this.getKeys();
    const next = { ...current, ...patch };
    await chrome.storage.local.set({ apiKeys: next });
    return next;
  },
  async getHistory() {
    const { history = [] } = await chrome.storage.local.get('history');
    return history;
  },
  async addHistory(entry) {
    const { historyLimit } = await this.getSettings();
    const history = await this.getHistory();
    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: Date.now(),
      ...entry
    };
    const next = [item, ...history].slice(0, historyLimit);
    await chrome.storage.local.set({ history: next });
    return item;
  },
  async deleteHistory(id) {
    const history = await this.getHistory();
    await chrome.storage.local.set({ history: history.filter(h => h.id !== id) });
  },
  async clearHistory() {
    await chrome.storage.local.set({ history: [] });
  }
};
