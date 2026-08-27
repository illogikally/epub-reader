// ============================================================
// Settings, models, persistence, IndexedDB, color utilities,
// and shared mutable runtime state.
// ============================================================

export const MODELS = [
  {
    name: 'groq · openai/gpt-oss-120b',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'openai/gpt-oss-120b',
    format: 'openai',
    keyRef: 'GROQ_API_KEY',
  },
  {
    name: 'groq · qwen3.8-27b',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'qwen/qwen3.8-27b',
    format: 'openai',
    keyRef: 'GROQ_API_KEY',
  },
];
export const DEFAULT_MODEL_INDEX = 1;
export const MAX_TOKENS = 1024;
// Sentences of surrounding text sent with a lookup. Fixed — no longer a setting.
export const CONTEXT_SENTENCES = 1;

const defaultSettings = {
  fontFamily: "'Seravek', ui-sans-serif, system-ui, sans-serif",
  fontSize: 18,
  lineHeight: 1.5,
  letterSpacing: 0,
  wordSpacing: 0,
  textAlign: 'default',   // 'default' | 'left' | 'justify'
  padTop: 44,
  padBottom: 44,
  padLeft: 24,
  padRight: 24,
  bg: '#faf6ef',
  fg: '#2a2520',
  dark: false,
  layout: 'single',
  selectedModelIdx: DEFAULT_MODEL_INDEX,
  apiKeys: { GROQ_API_KEY: '' },
  debug: false,       // on-screen debug log — see js/debug.js
};

// Load synchronously at module-eval time.
const _loaded = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('reader-settings') || '{}');
    // Only keys we still know about survive, so dropped settings (custom CSS,
    // saved presets, context length) don't linger in localStorage forever.
    const merged = { ...defaultSettings };
    for (const k of Object.keys(defaultSettings)) {
      if (saved[k] !== undefined) merged[k] = saved[k];
    }
    merged.apiKeys = { ...defaultSettings.apiKeys, ...(saved.apiKeys || {}) };
    return merged;
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

// Touch device? Drives the custom selection layer (js/touchselect.js) and the
// mobile translate bubble. Feature detection only — no UA sniffing.
export const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;

export function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Pull-down-to-dismiss for mobile bottom sheets. Listeners attach to the sheet
// so any touch on the bottom-sheet area is observed. When the inner scrollEl
// is at scrollTop 0 and the user drags down past `threshold`, the sheet slides
// out and `onDismiss` runs. Below threshold, snap back. Mobile-only.
//
// opts.grab is a selector for a title-bar-ish region that is always draggable:
// a touch starting there dismisses regardless of how far the list is scrolled,
// so a long TOC can still be closed without scrolling back to the top first.
export function attachPullToDismiss(sheet, getScrollEl, onDismiss, opts = {}) {
  const { threshold = 100, grab = null } = typeof opts === 'number' ? { threshold: opts } : opts;
  let startY = null;
  let dragging = false;
  let onGrab = false;
  let dy = 0;
  const startedOnGrab = (target) =>
    !!grab && target instanceof Element && !!target.closest(grab);
  const isMobile = () =>
    window.matchMedia('(max-width: 599px), (pointer: coarse)').matches;

  // If text is currently selected (e.g. inside the popup), the user is most
  // likely trying to extend that selection — not dismiss the sheet. Bail so
  // their drag goes to the OS selection-handle recognizer instead.
  const hasActiveSelection = () => {
    try {
      const s = window.getSelection();
      return !!(s && !s.isCollapsed && s.toString().trim());
    } catch { return false; }
  };

  sheet.addEventListener('touchstart', (e) => {
    if (!isMobile() || e.touches.length !== 1) { startY = null; return; }
    if (hasActiveSelection()) { startY = null; return; }
    onGrab = startedOnGrab(e.target);
    const sc = getScrollEl();
    if (!onGrab && sc && sc.scrollTop > 0) { startY = null; return; }
    startY = e.touches[0].clientY;
    dragging = false;
    dy = 0;
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    // Selection started mid-touch (long-press) — back off before we steal it.
    if (!dragging && hasActiveSelection()) { startY = null; return; }
    dy = e.touches[0].clientY - startY;
    if (dy <= 0) {
      if (dragging) { sheet.style.transform = ''; dragging = false; }
      return;
    }
    const sc = getScrollEl();
    if (!dragging && !onGrab && sc && sc.scrollTop > 0) { startY = null; return; }
    dragging = true;
    sheet.style.transition = 'none';
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });

  const finish = () => {
    if (startY === null) return;
    if (dragging) {
      if (dy > threshold) {
        sheet.style.transition = 'transform 0.2s ease';
        sheet.style.transform = 'translateY(100%)';
        const onEnd = (ev) => {
          if (ev.propertyName !== 'transform') return;
          sheet.removeEventListener('transitionend', onEnd);
          onDismiss();
          sheet.style.transition = '';
          sheet.style.transform = '';
        };
        sheet.addEventListener('transitionend', onEnd);
      } else {
        sheet.style.transition = 'transform 0.15s ease';
        sheet.style.transform = '';
        setTimeout(() => { sheet.style.transition = ''; }, 200);
      }
    }
    startY = null; dragging = false; onGrab = false; dy = 0;
  };
  sheet.addEventListener('touchend', finish, { passive: true });
  sheet.addEventListener('touchcancel', () => {
    if (dragging) { sheet.style.transition = ''; sheet.style.transform = ''; }
    startY = null; dragging = false; onGrab = false; dy = 0;
  }, { passive: true });
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
