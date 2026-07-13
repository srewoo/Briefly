// Shared test helpers: an in-memory chrome.storage.local mock and a fake
// fetch Response builder. No third-party deps — everything runs on node:test.

export function installChromeMock(initial = {}) {
  const store = { ...initial };
  global.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return { ...store };
          if (typeof keys === 'string') return { [keys]: store[keys] };
          if (Array.isArray(keys)) {
            const o = {};
            for (const k of keys) o[k] = store[k];
            return o;
          }
          const o = {};
          for (const k of Object.keys(keys)) o[k] = k in store ? store[k] : keys[k];
          return o;
        },
        async set(obj) { Object.assign(store, obj); },
        async clear() { for (const k of Object.keys(store)) delete store[k]; }
      }
    }
  };
  return store;
}

// Minimal Response-like object for stubbing global.fetch.
export function fakeResponse({ ok = true, status = 200, statusText = 'OK', json, text, blob, headers = {} } = {}) {
  return {
    ok,
    status,
    statusText,
    headers: { get: (k) => headers[k.toLowerCase()] ?? headers[k] ?? null },
    async json() { return typeof json === 'function' ? json() : json; },
    async text() { return typeof text === 'function' ? text() : (text ?? (json ? JSON.stringify(json) : '')); },
    async blob() { return typeof blob === 'function' ? blob() : blob; }
  };
}

// Replace global.fetch with a queue of responses (or a single function).
export function stubFetch(sequence) {
  const calls = [];
  const queue = Array.isArray(sequence) ? [...sequence] : null;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (queue) {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return typeof next === 'function' ? next(url, init) : next;
    }
    return sequence(url, init);
  };
  return calls;
}
