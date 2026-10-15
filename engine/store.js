// On-device library (IndexedDB): original + recipe + developed JPEG + thumbnail per shot.
// Nothing leaves the phone.
const DB = 'emulsa', STORE = 'shots';

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

export const put = (shot) => tx('readwrite', (s) => s.put(shot));
export const del = (id) => tx('readwrite', (s) => s.delete(id));
export const get = (id) => tx('readonly', (s) => s.get(id));
export async function list() {
  const all = await tx('readonly', (s) => s.getAll());
  return all.sort((a, b) => b.created - a.created);
}
