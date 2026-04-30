// ============================================================
// Book opening / rendition / page navigation / chrome controls.
//
// Fix #1 — center-tap chrome toggle:
//   * On phones, click events synthesized from taps inside epub.js iframes
//     are unreliable on iOS Safari. We track touchstart/touchend ourselves
//     to detect a true tap (no movement, short duration) and fire instantly.
//   * On desktop we still listen to `click`, but defer the toggle by ~230ms
//     and cancel it if `dblclick` follows — this avoids a clash with text
//     selection (double-click selects a word and triggers the lookup popup).
// ============================================================

import { settings, runtime, $, dbGet } from './state.js';
import { applyBookTheme } from './theme.js';
import {
  hidePopup, isPopupVisible,
  attachSelectionHandler, attachOutsideClickToFrame,
  startSelectionPolling, stopSelectionPolling,
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
const CHROME_AUTO_HIDE_MS = 4000;
let chromeHideTimer;

export function showChrome(autoHide) {
  document.body.classList.add('chrome-visible');
  clearTimeout(chromeHideTimer);
  if (autoHide) {
    chromeHideTimer = setTimeout(() => {
      document.body.classList.remove('chrome-visible');
    }, CHROME_AUTO_HIDE_MS);
  }
}
export function hideChrome() {
  document.body.classList.remove('chrome-visible');
  clearTimeout(chromeHideTimer);
}
export function toggleChrome() {
  if (document.body.classList.contains('chrome-visible')) hideChrome();
  else showChrome(true);
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

    $('book-title').textContent = record.title;
    runtime.currentBookKey = record.id;

    createRendition();

    const savedCfi = localStorage.getItem(`reader-progress-${runtime.currentBookKey}`);
    await runtime.rendition.display(savedCfi || undefined);
    requestAnimationFrame(() => { try { runtime.rendition.resize(); } catch {} });
    setTimeout(() => { try { runtime.rendition && runtime.rendition.resize(); } catch {} }, 80);

    const nav = await runtime.book.loaded.navigation;
    buildToc(nav.toc || []);
    startSelectionPolling();
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
  stopSelectionPolling();
  if (runtime.rendition) { try { runtime.rendition.destroy(); } catch {} runtime.rendition = null; }
  if (runtime.book) { try { runtime.book.destroy(); } catch {} runtime.book = null; }
  viewer.innerHTML = '';
  pageIndicator.textContent = '';
  reader.hidden = true;
  library.hidden = false;
  hidePopup();
  await renderLibrary();
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
    if (loc?.start?.displayed) {
      const { page, total } = loc.start.displayed;
      if (page && total) pageIndicator.textContent = `${page} / ${total}`;
    }
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
  if (now - lastFlip < 220) return;
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
  let recentTouchTime = 0;   // when our touch handler last fired

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
    recentTouchTime = Date.now();
    // Filter out drags / long presses / non-tap gestures
    if (dt > 350 || dx > 10 || dy > 10) return;
    // Dedup: skip if the top-level viewer handler already toggled this tap
    const now2 = Date.now();
    if (now2 - lastToggleTapTime < 400) return;
    if (!shouldToggleChrome(doc)) return;
    lastToggleTapTime = now2;
    // Cancel any pending desktop-style deferred toggle that may have been
    // queued by a late synthetic click, then fire immediately. There's no
    // dblclick gesture on touch, so no need to wait.
    if (pendingToggle) { clearTimeout(pendingToggle); pendingToggle = null; }
    toggleChrome();
  }, { passive: true });

  // ============================================================
  // Tap-to-toggle-chrome — desktop click path
  // ============================================================
  let pendingToggle = null;

  doc.addEventListener('click', () => {
    // Skip the click if it was synthesized from a touchend we already handled.
    // Mobile browsers fire click ~300ms after touchend; the 700ms window is
    // generous to cover slow synthesis on older iOS.
    if (Date.now() - recentTouchTime < 700) return;
    if (!shouldToggleChrome(doc)) return;
    // Defer so a dblclick (word-select for translation) can cancel us.
    if (pendingToggle) clearTimeout(pendingToggle);
    pendingToggle = setTimeout(() => {
      pendingToggle = null;
      toggleChrome();
    }, 230);
  });

  doc.addEventListener('dblclick', () => {
    if (pendingToggle) {
      clearTimeout(pendingToggle);
      pendingToggle = null;
    }
  });
}

function handleKey(e) {
  if (isPopupVisible() && e.key === 'Escape') {
    hidePopup();
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

  // ============================================================
  // Center-tap overlay — iOS Safari fallback
  //
  // Touch events inside epub.js iframes don't fire reliably on iOS
  // Safari. #zone-center sits ON TOP of the iframe (like zone-left
  // and zone-right) so it receives taps directly in the parent
  // document, which is reliable across all browsers.
  //
  // Short taps (< 350ms, < 10px movement) toggle chrome.
  // Long presses disable the overlay for 2s so the iframe
  // underneath can handle text selection for translation.
  // ============================================================
  const zoneCenter = $('zone-center');
  let centerTouchStart = null;
  let longPressTimer = null;

  zoneCenter.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { centerTouchStart = null; return; }
    centerTouchStart = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
      t: Date.now(),
    };
    // After 350ms, assume long press → hide overlay so the iframe
    // can handle text selection for translation.
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      zoneCenter.style.pointerEvents = 'none';
      // Re-arm after 2s
      setTimeout(() => { zoneCenter.style.pointerEvents = ''; }, 2000);
    }, 350);
  }, { passive: true });

  zoneCenter.addEventListener('touchend', e => {
    clearTimeout(longPressTimer);
    if (!centerTouchStart) return;
    const c = e.changedTouches[0];
    const dx = Math.abs(c.clientX - centerTouchStart.x);
    const dy = Math.abs(c.clientY - centerTouchStart.y);
    const dt = Date.now() - centerTouchStart.t;
    centerTouchStart = null;
    // Filter out drags / long presses
    if (dt > 350 || dx > 10 || dy > 10) return;
    // Dedup with in-iframe handler
    const now = Date.now();
    if (now - lastToggleTapTime < 400) return;
    // Don't toggle while user has an active text selection
    if (hasSelectionInAnyIframe()) return;
    // Dismiss popup instead of toggling chrome
    if (isPopupVisible()) { hidePopup(); return; }
    lastToggleTapTime = now;
    toggleChrome();
  }, { passive: true });

  // Also handle click for non-touch scenarios on this zone
  zoneCenter.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastToggleTapTime < 700) return;
    if (hasSelectionInAnyIframe()) return;
    if (isPopupVisible()) { hidePopup(); return; }
    lastToggleTapTime = now;
    toggleChrome();
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
