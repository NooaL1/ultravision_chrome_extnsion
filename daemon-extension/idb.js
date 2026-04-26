// Shared IndexedDB helpers for Daemon lecture sessions.

const DB_NAME = 'daemon';
const DB_VER  = 1;
const STORE   = 'sessions';

export function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('startedAt', 'startedAt');
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

export async function saveSession(rec) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    const r = tx.objectStore(STORE).add(rec);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

export async function listSessions() {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).getAll();
    r.onsuccess = () => res((r.result || []).sort((a,b) => b.startedAt - a.startedAt));
    r.onerror   = () => rej(r.error);
  });
}

export async function getSession(id) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).get(Number(id));
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

export async function deleteSession(id) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    const r = tx.objectStore(STORE).delete(Number(id));
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error);
  });
}

export async function updateSession(id, patch) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const r1 = store.get(Number(id));
    r1.onsuccess = () => {
      const cur = r1.result; if (!cur) return rej(new Error('not found'));
      Object.assign(cur, patch);
      const r2 = store.put(cur);
      r2.onsuccess = () => res();
      r2.onerror   = () => rej(r2.error);
    };
    r1.onerror = () => rej(r1.error);
  });
}
