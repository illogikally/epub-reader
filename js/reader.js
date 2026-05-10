// ============================================================
// Book opening / rendition / page navigation / chrome controls.
//
// Chrome toggle:
//   * Mobile: #chrome-dot (always-visible dot in bottom-right) toggles chrome.
//   * Desktop: tap inside iframe toggles chrome (deferred 230ms to allow
//     double-click word selection without false chrome toggles).
// ============================================================

import { settings, runtime, $, dbGet } from './state.js';
import { applyBookTheme } from './theme.js';
import {
  hidePopup, isPopupVisible,
  attachSelectionHandler, attachOutsideClickToFrame,
  stopBubble,
  buildToc,
} from './translate.js';
import { renderLibrary } from './library.js';

const library = $('library');
const reader = $('reader');
const viewer = $('viewer');
const pageIndicator = $('page-indicator');
const loading = $('loading');

// ============================================================
// Chrome controls (bottom-right floating buttons)
// ============================================================
export function showChrome() {
  document.body.classList.add('chrome-visible');
}
export function hideChrome() {
  document.body.classList.remove('chrome-visible');
}
export function toggleChrome() {
  if (document.body.classList.contains('chrome-visible')) hideChrome();
  else showChrome();
}

// ============================================================
// Open / close book
// ============================================================
export async function openBookFromDb(id) {
  const record = await dbGet(id);
  if (!record) { alert('Book not found.'); return; }
  loading.classList.add('visible');
  try {
    if (runtime.rendition) { try { runtime.rendition.destroy(); } catch {} runtime.rendition = null; }
    if (runtime.book) { try { runtime.book.destroy(); } catch {} runtime.book = null; }
    viewer.innerHTML = '';

    // Make the reader visible BEFORE creating the rendition. epub.js measures
    // the viewer's dimensions during renderTo(); if the parent is display:none
    // those are zero and the chapter renders into an offscreen column.
    library.hidden = true;
    reader.hidden = false;
    await new Promise(r => requestAnimationFrame(r));

    runtime.book = window.ePub(record.data);
    await runtime.book.ready;
    runtime.book.loaded.metadata.then(metadata => {
      document.title = metadata.title;
    });
    $('book-title').textContent = record.title;
    runtime.currentBookKey = record.id;

    createRendition();

    const savedCfi = localStorage.getItem(`reader-progress-${runtime.currentBookKey}`);
    await runtime.rendition.display(savedCfi || undefined);
    requestAnimationFrame(() => { try { runtime.rendition.resize(); } catch {} });
    setTimeout(() => { try { runtime.rendition && runtime.rendition.resize(); } catch {} }, 80);

    const nav = await runtime.book.loaded.navigation;
    buildToc(nav.toc || []);

    // Build a book-wide location map in the background so the page indicator
    // can show "page N / total" across the whole book instead of per-chapter.
    // ~1024 chars/page is epub.js's standard. Refresh the indicator when ready.
    const bookForLocations = runtime.book;
    bookForLocations.locations.generate(1024).then(() => {
      if (runtime.book !== bookForLocations || !runtime.rendition) return;
      try { updatePageIndicator(runtime.rendition.currentLocation()); } catch {}
    }).catch(() => {});
  } catch (err) {
    console.error(err);
    alert('Could not open this EPUB:\n' + err.message);
    library.hidden = false;
    reader.hidden = true;
  } finally {
    loading.classList.remove('visible');
  }
}

export async function closeBook() {
  stopBubble();
  if (runtime.rendition) { try { runtime.rendition.destroy(); } catch {} runtime.rendition = null; }
  if (runtime.book) { try { runtime.book.destroy(); } catch {} runtime.book = null; }
  viewer.innerHTML = '';
  pageIndicator.textContent = '';
  // Reset chrome / drawers / settings modal so reopening a book doesn't carry
  // over the previous session's open panels.
  hideChrome();
  document.dispatchEvent(new CustomEvent('reader:hideAllDrawers'));
  reader.hidden = true;
  library.hidden = false;
  hidePopup();
  await renderLibrary();
  document.title = 'Xulgon'
}

// Book-wide page indicator. We deliberately don't fall back to the
// per-chapter count from loc.start.displayed — showing 3/12 then jumping to
// 412/3000 is more confusing than just waiting. Stays blank until
// book.locations.generate() finishes (a few seconds), then renders.
function updatePageIndicator(loc) {
  const cfi = loc?.start?.cfi;
  const total = runtime.book?.locations?.length?.();
  if (cfi && total) {
    try {
      const idx = runtime.book.locations.locationFromCfi(cfi);
      if (idx >= 0) {
        pageIndicator.textContent = `${idx + 1} / ${total}`;
        return;
      }
    } catch {}
  }
  pageIndicator.textContent = '';
}

export function createRendition() {
  runtime.rendition = runtime.book.renderTo(viewer, {
    flow: 'paginated',
    width: '100%', height: '100%',
    spread: settings.layout === 'dual' ? 'always' : 'none',
    allowScriptedContent: false,
    manager: 'default',
  });
  applyBookTheme();
  runtime.rendition.on('relocated', loc => {
    if (loc?.start?.cfi && runtime.currentBookKey) {
      localStorage.setItem(`reader-progress-${runtime.currentBookKey}`, loc.start.cfi);
    }
    updatePageIndicator(loc);
  });
  runtime.rendition.on('rendered', (section, view) => {
    const doc = view?.document;
    if (!doc) return;
    attachInputHandlers(doc);
    attachSelectionHandler(doc);
    attachOutsideClickToFrame(doc);
  });
}

// ============================================================
// Page flipping
// ============================================================
let lastFlip = 0;
export function flipPage(direction) {
  if (!runtime.rendition) return;
  const now = Date.now();
  if (now - lastFlip < 50) return;
  lastFlip = now;
  if (direction > 0) runtime.rendition.next(); else runtime.rendition.prev();
}

// ============================================================
// Per-iframe input handlers (the new center-tap fix lives here)
// ============================================================

// Module-level timestamp: set by whichever tap handler fires first
// (top-level or in-iframe) so the other one skips the same tap.
let lastToggleTapTime = 0;

function shouldToggleChrome(doc) {
  // Don't toggle while the user has an active selection (translation flow)
  const sel = doc.getSelection();
  if (sel && !sel.isCollapsed) return false;
  // If the popup is open, a tap on the page should dismiss it instead of
  // toggling chrome — handled here so the user gets one-tap dismissal even
  // when chrome happens to be off.
  if (isPopupVisible()) {
    hidePopup();
    return false;
  }
  return true;
}

function attachInputHandlers(doc) {
  // Wheel — desktop only path; flips a page per scroll burst.
  doc.addEventListener('wheel', e => {
    if (Math.abs(e.deltaY) < 4 && Math.abs(e.deltaX) < 4) return;
    e.preventDefault();
    const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    flipPage(delta);
  }, { passive: false });

  doc.addEventListener('keydown', handleKey);

  // ============================================================
  // Tap-to-toggle-chrome — touch path (mobile)
  // ============================================================
  let touchStart = null;     // { x, y, t } for the current touch

  doc.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { touchStart = null; return; }
    touchStart = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
      t: Date.now(),
    };
  }, { passive: true });

  doc.addEventListener('touchend', e => {
    if (!touchStart) return;
    const c = e.changedTouches[0];
    const dx = Math.abs(c.clientX - touchStart.x);
    const dy = Math.abs(c.clientY - touchStart.y);
    const dt = Date.now() - touchStart.t;
    touchStart = null;
    // Filter out drags / long presses / non-tap gestures
    if (dt > 350 || dx > 10 || dy > 10) return;
    // Dedup: skip if the top-level viewer handler already toggled this tap
    const now2 = Date.now();
    if (now2 - lastToggleTapTime < 400) return;
    if (!shouldToggleChrome(doc)) return;
    lastToggleTapTime = now2;
    toggleChrome();
  }, { passive: true });
}

function handleKey(e) {
  if (isPopupVisible() && e.key === 'Escape') {
    hidePopup();
    return;
  }
  // Don't hijack arrows / page nav while the user is typing in a form field
  // (settings inputs, custom-CSS textarea, popup input, etc.).
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
    return;
  }
  if (!runtime.rendition) return;
  if (['ArrowRight', 'PageDown'].includes(e.key)) {
    e.preventDefault();
    runtime.rendition.next();
  } else if (['ArrowLeft', 'PageUp'].includes(e.key)) {
    e.preventDefault();
    runtime.rendition.prev();
  } else if (e.key === 'Escape') {
    // Closing drawers is a UI concern — defer to ui.js's exposed handler
    // by dispatching a custom event here.
    document.dispatchEvent(new CustomEvent('reader:hideAllDrawers'));
  }
}

// ============================================================
// Check for active text selection inside any epub.js iframe
// ============================================================
function hasSelectionInAnyIframe() {
  const iframes = viewer.querySelectorAll('iframe');
  for (const ifr of iframes) {
    try {
      const win = ifr.contentWindow;
      const doc = ifr.contentDocument || (win && win.document);
      if (!doc) continue;
      const sel = (win || doc).getSelection();
      if (sel && !sel.isCollapsed) return true;
    } catch { /* cross-origin — skip */ }
  }
  return false;
}

// ============================================================
// Top-level (non-iframe) wiring: keyboard, viewer wheel, edge zones
// ============================================================
export function initReaderEvents() {
  document.addEventListener('keydown', handleKey);

  viewer.addEventListener('wheel', e => {
    e.preventDefault();
    flipPage(e.deltaY);
  }, { passive: false });

  const zoneLeft = $('zone-left');
  const zoneRight = $('zone-right');
  zoneLeft.addEventListener('click', () => { if (runtime.rendition) runtime.rendition.prev(); });
  zoneRight.addEventListener('click', () => { if (runtime.rendition) runtime.rendition.next(); });
  [zoneLeft, zoneRight].forEach(z => {
    z.addEventListener('wheel', e => {
      e.preventDefault();
      flipPage(e.deltaY);
    }, { passive: false });
  });

  // Chrome-dot — persistent small button in bottom-right, always visible.
  // Tapping it toggles the floating chrome controls (reliable: lives in the
  // top document, not inside the epub.js iframe).
  $('chrome-dot').addEventListener('click', () => {
    if (isPopupVisible()) { hidePopup(); return; }
    toggleChrome();
  });

  // Wrapper catches taps on the dimmed background; clicks on the buttons inside
  // bubble up but are filtered out by the target === currentTarget check.
  $('chrome-wrap').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) hideChrome();
  });

  // Window resize → relayout (debounced)
  let resizeTimer;
  window.addEventListener('resize', () => {
    if (!runtime.rendition) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      try { runtime.rendition.resize(); } catch {}
    }, 150);
  });
}
