/**
 * Briefly — storage.js
 * Abstraction layer over chrome.storage.local with enhanced history,
 * usage tracking, feedback, and team template features.
 */

const Storage = {
  // Session history — configurable limit (default 500)
  async getHistory() {
    const { history = [] } = await chrome.storage.local.get('history');
    return history;
  },
  async addHistory(entry) {
    const history = await this.getHistory();
    const settings = await this.getSettings();
    const limit = settings.historyLimit || 500;
    const newEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      timestamp: Date.now(),
      ...entry
    };
    const updated = [newEntry, ...history].slice(0, limit);
    await chrome.storage.local.set({ history: updated });
    return newEntry;
  },
  async deleteHistory(id) {
    const history = await this.getHistory();
    await chrome.storage.local.set({ history: history.filter(h => h.id !== id) });
  },
  async clearHistory() {
    await chrome.storage.local.set({ history: [] });
  },
  async exportHistory() {
    const history = await this.getHistory();
    return JSON.stringify(history, null, 2);
  },
  async importHistory(jsonString) {
    const imported = JSON.parse(jsonString);
    if (!Array.isArray(imported)) throw new Error('Invalid history format');
    const existing = await this.getHistory();
    const existingIds = new Set(existing.map(e => e.id));
    const merged = [...existing];
    for (const entry of imported) {
      if (entry.id && !existingIds.has(entry.id)) {
        merged.push(entry);
      }
    }
    merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const settings = await this.getSettings();
    const limit = settings.historyLimit || 500;
    await chrome.storage.local.set({ history: merged.slice(0, limit) });
    return merged.length;
  },
  async searchHistory({ query = '', intent = '', domain = '', dateFrom = 0, dateTo = Infinity } = {}) {
    const history = await this.getHistory();
    return history.filter(entry => {
      if (query && !(entry.transcript?.toLowerCase().includes(query.toLowerCase()) || entry.output?.toLowerCase().includes(query.toLowerCase()))) return false;
      if (intent && entry.intent !== intent) return false;
      if (domain && !entry.context?.domain?.includes(domain)) return false;
      if (dateFrom && entry.timestamp < dateFrom) return false;
      if (dateTo && entry.timestamp > dateTo) return false;
      return true;
    });
  },

  // Prompt Library
  async getLibrary() {
    const { library = [] } = await chrome.storage.local.get('library');
    return library;
  },
  async addToLibrary(item) {
    const library = await this.getLibrary();
    const newItem = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      timestamp: Date.now(),
      tags: [],
      starred: true,
      ...item
    };
    await chrome.storage.local.set({ library: [newItem, ...library] });
    return newItem;
  },
  async updateLibraryItem(id, updates) {
    const library = await this.getLibrary();
    const updated = library.map(item => item.id === id ? { ...item, ...updates } : item);
    await chrome.storage.local.set({ library: updated });
  },
  async deleteFromLibrary(id) {
    const library = await this.getLibrary();
    await chrome.storage.local.set({ library: library.filter(l => l.id !== id) });
  },

  // Settings (unencrypted non-sensitive)
  async getSettings() {
    const { settings = {} } = await chrome.storage.local.get('settings');
    return {
      sttProvider: 'whisper',
      language: 'auto',
      tone: 'auto',
      outputFormat: 'markdown',
      qualityMode: 'balanced',
      theme: 'dark',
      activeTemplate: 'general_assistant',
      usePageContext: true,
      autorefreshContext: true,
      selectionOnly: false,
      useVisionContext: false,
      threadMemory: true,
      redactSensitive: true,
      reviewBeforeSend: true,
      webhookUrl: '',
      customRecipes: [],
      contextSignalPrefs: {
        selectedText: true,
        visibleText: true,
        codeBlocks: true,
        headings: true,
        formFields: true,
        structuredData: true,
        domainArtifacts: true,
        screenshot: true
      },
      // Multi-LLM
      llmProvider: 'openai',
      ollamaEndpoint: 'http://localhost:11434',
      ollamaModel: 'llama3',
      // Cost tracking
      costTrackingEnabled: true,
      costBudgetMonthly: 0,
      // History
      historyLimit: 500,
      // Feedback
      feedbackEnabled: true,
      // Performance
      contextExtractionTimeout: 2000,
      skipHeavyPages: true,
      ...settings
    };
  },
  async saveSettings(settings) {
    const current = await this.getSettings();
    await chrome.storage.local.set({ settings: { ...current, ...settings } });
  },

  // Keys (encrypted — managed via crypto.js)
  async getEncryptedKeys() {
    const { encryptedKeys = {} } = await chrome.storage.local.get('encryptedKeys');
    return encryptedKeys;
  },
  async setEncryptedKeys(encryptedKeys) {
    await chrome.storage.local.set({ encryptedKeys });
  },

  // Integration connection status
  async getIntegrations() {
    const { integrations = {} } = await chrome.storage.local.get('integrations');
    return integrations;
  },
  async setIntegration(name, data) {
    const integrations = await this.getIntegrations();
    await chrome.storage.local.set({ integrations: { ...integrations, [name]: data } });
  },

  // Usage tracking
  async getUsageLog() {
    const { usageLog = [] } = await chrome.storage.local.get('usageLog');
    return usageLog;
  },
  async getUsageTotals() {
    const { usageTotals = {} } = await chrome.storage.local.get('usageTotals');
    return usageTotals;
  },
  async clearUsage() {
    await chrome.storage.local.set({ usageLog: [], usageTotals: {} });
  },

  // Feedback
  async getFeedbackLog() {
    const { feedbackLog = [] } = await chrome.storage.local.get('feedbackLog');
    return feedbackLog;
  },
  async addFeedback(entry) {
    const log = await this.getFeedbackLog();
    const newEntry = { id: Date.now().toString(36), timestamp: Date.now(), ...entry };
    await chrome.storage.local.set({ feedbackLog: [newEntry, ...log].slice(0, 500) });
    return newEntry;
  },

  // Team templates — import/export
  async exportTemplates() {
    const settings = await this.getSettings();
    return JSON.stringify(settings.customRecipes || [], null, 2);
  },
  async importTemplates(jsonString) {
    const imported = JSON.parse(jsonString);
    if (!Array.isArray(imported)) throw new Error('Invalid template format');
    const settings = await this.getSettings();
    const existing = settings.customRecipes || [];
    const existingIds = new Set(existing.map(t => t.id));
    const merged = [...existing];
    for (const template of imported) {
      if (!template.id || !template.label) continue;
      if (!existingIds.has(template.id)) {
        merged.push(template);
        existingIds.add(template.id);
      }
    }
    settings.customRecipes = merged;
    await this.saveSettings(settings);
    return merged.length;
  },

  // OAuth tokens
  async getOAuthTokens() {
    const { oauthTokens = {} } = await chrome.storage.local.get('oauthTokens');
    return oauthTokens;
  },
  async setOAuthToken(provider, tokenData) {
    const tokens = await this.getOAuthTokens();
    tokens[provider] = { ...tokenData, savedAt: Date.now() };
    await chrome.storage.local.set({ oauthTokens: tokens });
  },
  async removeOAuthToken(provider) {
    const tokens = await this.getOAuthTokens();
    delete tokens[provider];
    await chrome.storage.local.set({ oauthTokens: tokens });
  },

  // Metadata
  async isFirstRun() {
    const { firstRunDone } = await chrome.storage.local.get('firstRunDone');
    return !firstRunDone;
  },
  async markFirstRunDone() {
    await chrome.storage.local.set({ firstRunDone: true });
  },

  async clearAll() {
    await chrome.storage.local.clear();
  }
};

// Make available globally in side panel context
if (typeof window !== 'undefined') window.Storage = Storage;
