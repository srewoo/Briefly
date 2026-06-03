// Persistent TTS audio cache (IndexedDB). Re-listening to the same text with
// the same provider/voice must not cost twice.
const DB_NAME = 'briefly-audio';
const STORE = 'clips';
const MAX_ENTRIES = 300;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('ts', 'ts');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function cacheKey(parts) {
  const data = new TextEncoder().encode(parts.join('|'));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function cacheGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = tx(db, 'readonly').get(key);
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror = () => resolve(null);
    });
  } catch (_) {
    return null; // cache is best-effort; never block playback on it
  }
}

export async function cachePut(key, blob) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const req = tx(db, 'readwrite').put({ key, blob, ts: Date.now() });
      req.onsuccess = resolve;
      req.onerror = resolve;
    });
    evictOldest(db).catch(() => {});
  } catch (_) { /* best-effort */ }
}

async function evictOldest(db) {
  const store = tx(db, 'readwrite');
  const count = await new Promise((res) => {
    const r = store.count();
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(0);
  });
  if (count <= MAX_ENTRIES) return;
  let toDelete = count - MAX_ENTRIES;
  await new Promise((resolve) => {
    const cur = store.index('ts').openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c || toDelete <= 0) return resolve();
      c.delete();
      toDelete--;
      c.continue();
    };
    cur.onerror = () => resolve();
  });
}
