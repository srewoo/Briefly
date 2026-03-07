/**
 * Productify — storage.js
 * Abstraction layer over chrome.storage.local
 */

const Storage = {
  // Session history — max 50 entries
  async getHistory() {
    const { history = [] } = await chrome.storage.local.get('history');
    return history;
  },
  async addHistory(entry) {
    const history = await this.getHistory();
    const newEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      timestamp: Date.now(),
      ...entry
    };
    const updated = [newEntry, ...history].slice(0, 50);
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
      theme: 'dark',
      activeTemplate: 'general_assistant',
      usePageContext: true,
      selectionOnly: false,
      redactSensitive: true,
      reviewBeforeSend: true,
      webhookUrl: '',
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
