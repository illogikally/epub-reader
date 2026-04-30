// ============================================================
// Settings, models, persistence, IndexedDB, color utilities,
// and shared mutable runtime state.
// ============================================================

export const MODELS = [
  {
    name: 'gemini-3-flash-preview',
    url: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3-flash-preview',
    format: 'google',
    keyRef: 'GEMINI_API_KEY',
  },
  {
    name: 'groq · openai/gpt-oss-120b',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'openai/gpt-oss-120b',
    format: 'openai',
    keyRef: 'GROQ_API_KEY',
  },
  {
    name: 'gemini-3.1-flash-lite-preview',
    url: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.1-flash-lite-preview',
    format: 'google',
    keyRef: 'GEMINI_API_KEY',
  },
  {
    name: 'groq · qwen3-32b',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'qwen/qwen3-32b',
    format: 'openai',
    keyRef: 'GROQ_API_KEY',
  },
];
export const DEFAULT_MODEL_INDEX = 1;
export const MAX_TOKENS = 1024;

const defaultSettings = {
  fontFamily: "'Seravek', ui-sans-serif, system-ui, sans-serif",
  fontSize: 18,
  lineHeight: 1.5,
  letterSpacing: 0,
  wordSpacing: 0,
  padTop: 44,
  padBottom: 44,
  padLeft: 24,
  padRight: 24,
  bg: '#faf6ef',
  fg: '#2a2520',
  dark: false,
  layout: 'single',
  contextSentences: 1,
  selectedModelIdx: DEFAULT_MODEL_INDEX,
  apiKeys: { GEMINI_API_KEY: '', GROQ_API_KEY: '' },
  customCss: '',
  customThemes: [],   // [{ name, bg, fg }]
};

// Load synchronously at module-eval time.
const _loaded = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('reader-settings') || '{}');
    return {
      ...defaultSettings,
      ...saved,
      apiKeys: { ...defaultSettings.apiKeys, ...(saved.apiKeys || {}) },
      customThemes: Array.isArray(saved.customThemes) ? saved.customThemes : [],
    };
  } catch {
    return { ...defaultSettings };
  }
})();

// Single shared object — modules mutate properties; the reference never changes.
export const settings = _loaded;

export function persistSettings() {
  localStorage.setItem('reader-settings', JSON.stringify(settings));
}

// ============================================================
// Shared runtime state (book / rendition / current key etc).
// One object so modules can read/write the same instance.
// ============================================================
export const runtime = {
  book: null,
  rendition: null,
  currentBookKey: null,
};

// ============================================================
// Tiny helpers
// ============================================================
export const $ = id => document.getElementById(id);

export function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// Color utilities
// ============================================================
export function parseHex(hex) {
  let h = (hex || '').replace('#', '').toLowerCase();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
export function blendHex(a, b, ratio) {
  const ca = parseHex(a) || [0, 0, 0];
  const cb = parseHex(b) || [255, 255, 255];
  return rgbToHex(
    ca[0] + (cb[0] - ca[0]) * ratio,
    ca[1] + (cb[1] - ca[1]) * ratio,
    ca[2] + (cb[2] - ca[2]) * ratio,
  );
}
export function relLuminance(hex) {
  const c = parseHex(hex);
  if (!c) return 1;
  return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
}

// ============================================================
// IndexedDB wrapper for storing book records
// ============================================================
const DB_NAME = 'reader-db', DB_VERSION = 1, STORE = 'books';
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
export async function dbPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function dbGet(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
export async function dbAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
export async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function makeBookId(name, size) {
  return `${name}-${size}`;
}
