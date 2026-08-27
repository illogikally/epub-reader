// ============================================================
// Settings, models, persistence, IndexedDB, color utilities,
// and shared mutable runtime state.
// ============================================================

// Every model is a Groq model, so the endpoint and the key it is filed under
// are constants rather than per-model fields.
export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_KEY_REF = 'GROQ_API_KEY';

// Groq serves every model over the same OpenAI-compatible endpoint, but they do
// not all accept the same request. `reasoning_effort` is the one that varies:
// gpt-oss takes low/medium/high, qwen3 takes none, and llama/gemma/mixtral
// reject the parameter outright. Sending it to a model that doesn't support it
// fails the request, so it is a per-model setting rather than something guessed
// from the model's name.
export const REASONING_MODES = [
  { value: 'off',    label: 'off',  title: "Don't send reasoning_effort — llama, gemma, mixtral, kimi" },
  { value: 'none',   label: 'none', title: 'reasoning_effort: none — qwen3' },
  { value: 'low',    label: 'low',  title: 'reasoning_effort: low — gpt-oss' },
  { value: 'medium', label: 'med',  title: 'reasoning_effort: medium — gpt-oss' },
  { value: 'high',   label: 'high', title: 'reasoning_effort: high — gpt-oss' },
];
export const DEFAULT_REASONING = 'off';   // the only value every model accepts

// Seeded into settings.models on first run, and ordinary models from then on:
// nothing here is fixed, every one of them can be removed.
export const SEED_MODELS = [
  { id: 'groq-gpt-oss-120b', model: 'openai/gpt-oss-120b', reasoning: 'low' },
  { id: 'groq-qwen3-8-27b',  model: 'qwen/qwen3.8-27b',    reasoning: 'none' },
];
export const DEFAULT_MODEL_ID = 'groq-qwen3-8-27b';
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
  selectedModelId: DEFAULT_MODEL_ID,
  models: [],   // [{ id, model, reasoning }] — seeded on first run, then all user data
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
    // Models are one flat, fully editable list now. Earlier versions kept two
    // fixed built-ins plus a `customModels` array; fold that into `models`,
    // seeding the former built-ins so an upgrade doesn't arrive empty.
    const normalise = (list, fallbackReasoning) => (Array.isArray(list) ? list : [])
      .filter(m => m && typeof m.model === 'string' && m.model.trim())
      .map(m => ({
        id: m.id || 'model-' + Math.random().toString(36).slice(2, 9),
        model: m.model.trim(),
        reasoning: REASONING_MODES.some(r => r.value === m.reasoning)
          ? m.reasoning
          : fallbackReasoning(m.model.trim()),
      }));
    if (Array.isArray(saved.models)) {
      merged.models = normalise(saved.models, () => DEFAULT_REASONING);
    } else {
      // Carried-over customs never had a reasoning setting. Recognise the two
      // families the old name-prefix heuristic got right and fall back to 'off'
      // for the rest — that heuristic sent 'low' to everything it didn't
      // recognise, which is precisely the request those models reject.
      const guess = (id) => {
        const s = id.toLowerCase();
        if (s.startsWith('qwen') || s.includes('/qwen')) return 'none';
        if (s.includes('gpt-oss')) return 'low';
        return DEFAULT_REASONING;
      };
      merged.models = [
        ...SEED_MODELS.map(m => ({ ...m })),
        ...normalise(saved.customModels, guess),
      ];
    }
    // Models used to be picked by index into a fixed array. The list is now
    // user-editable, so the selection is an id — carry the old index over.
    if (saved.selectedModelId === undefined && typeof saved.selectedModelIdx === 'number') {
      merged.selectedModelId = SEED_MODELS[saved.selectedModelIdx]?.id || DEFAULT_MODEL_ID;
    }
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
// Model registry — built-ins plus whatever the user has added
// ============================================================
export function allModels() {
  return settings.models;
}

// Null when the list is empty — every model can be removed, so that is a state
// the reader has to cope with rather than an impossible one.
export function currentModel() {
  const list = settings.models;
  return list.find(m => m.id === settings.selectedModelId) || list[0] || null;
}

// Returns the new entry, or null if that model id is already in the list.
export function addModel(modelId, reasoning) {
  const model = String(modelId || '').trim();
  if (!model) return null;
  if (settings.models.some(m => m.model.toLowerCase() === model.toLowerCase())) return null;
  const entry = {
    id: 'model-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
    model,
    reasoning: REASONING_MODES.some(r => r.value === reasoning) ? reasoning : DEFAULT_REASONING,
  };
  settings.models.push(entry);
  persistSettings();
  return entry;
}

export function removeModel(id) {
  const idx = settings.models.findIndex(m => m.id === id);
  if (idx < 0) return false;
  settings.models.splice(idx, 1);
  // Don't leave the selection pointing at something that no longer exists.
  // With an empty list there is nothing to point at, which currentModel allows.
  if (settings.selectedModelId === id) {
    settings.selectedModelId = settings.models[0]?.id || null;
  }
  persistSettings();
  return true;
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
