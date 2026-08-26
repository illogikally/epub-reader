// ============================================================
// Book opening / rendition / page navigation / chrome controls.
//
// Chrome toggle:
//   * Mobile: #chrome-dot (always-visible dot in bottom-right) toggles chrome.
//   * Desktop: tap inside iframe toggles chrome (deferred 230ms to allow
//     double-click word selection without false chrome toggles).
// ============================================================

import { settings, runtime, $, dbGet } from './state.js';
import { applyBookTheme, injectBookStyle } from './theme.js';
import {
  hidePopup, isPopupVisible,
  attachSelectionHandler, attachOutsideClickToFrame,
  stopBubble,
  buildToc, setTocPosition, markTocCurrent,
} from './translate.js';
import { renderLibrary } from './library.js';
import {
  initTouchSelection, clearTouchSelection, onBookSwipe,
} from './touchselect.js';
import { dbg } from './debug.js';

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
    localStorage.setItem('reader-last-book', id);
    requestAnimationFrame(() => { try { runtime.rendition.resize(); } catch {} });
    setTimeout(() => { try { runtime.rendition && runtime.rendition.resize(); } catch {} }, 80);

    const nav = await runtime.book.loaded.navigation;
    buildToc(nav.toc || [], { title: record.title, cover: record.cover });
    // Note: book.locations.generate() used to run here to power a "page N /
    // total" indicator, but in epubjs 0.3.x it parses every spine section on
    // the main thread (5–30s of bursty work for a novel) and starves iOS's
    // selection-handle drag handling, freezing the UI mid-gesture. We use
    // loc.start.percentage instead — free from epubjs on every relocate.
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
  // Going back to the library is an explicit choice — clear the
  // auto-resume marker so a refresh from here lands on the library.
  localStorage.removeItem('reader-last-book');
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

// Spine-position percentage from epubjs. Available on every relocated event
// without book.locations.generate() — that call is too expensive on iOS
// (see openBookFromDb).
function updatePageIndicator(loc) {
  const pct = loc?.start?.percentage;
  if (typeof pct === 'number' && pct >= 0 && pct <= 1) {
    pageIndicator.textContent = `${Math.round(pct * 100)}%`;
    setTocPosition(pct);
  } else {
    pageIndicator.textContent = '';
    setTocPosition(null);
  }
  markTocCurrent(loc?.start?.index);
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
    clearTouchSelection();
  });
  // Per-document wiring.
  //
  // hooks.content is epub.js's own extension point and runs against the live
  // content document. The 'rendered' event is NOT a safe anchor on Safari:
  // epub.js loads chapters via iframe.srcdoc there, and assigning srcdoc
  // navigates the iframe and builds a fresh document, discarding every
  // listener bound to the previous one. Both paths call the same function;
  // doc.__touchSelAttached makes the second call a no-op.
  // Style injection and the desktop mouse paths only. Touch selection is NOT
  // wired here — see initTouchSelection(): listeners inside the iframe never
  // receive touch events on iOS, so that runs off a parent-document layer.
  const wireDocument = (doc, via) => {
    if (!doc) return;
    dbg('wiring document via', via);
    attachInputHandlers(doc);
    attachSelectionHandler(doc);
    attachOutsideClickToFrame(doc);
    injectBookStyle(doc);
  };

  try {
    runtime.rendition.hooks.content.register((contents) => {
      wireDocument(contents?.document, 'hooks.content');
    });
  } catch (err) {
    dbg('hooks.content unavailable:', String(err));
  }

  runtime.rendition.on('rendered', (section, view) => {
    wireDocument(view?.document, 'rendered');
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

function attachInputHandlers(doc) {
  // Wheel — desktop only path; flips a page per scroll burst.
  doc.addEventListener('wheel', e => {
    if (Math.abs(e.deltaY) < 4 && Math.abs(e.deltaX) < 4) return;
    e.preventDefault();
    const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    flipPage(delta);
  }, { passive: false });

  doc.addEventListener('keydown', handleKey);

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
// Top-level (non-iframe) wiring: keyboard, viewer wheel, edge zones
// ============================================================
export function initReaderEvents() {
  document.addEventListener('keydown', handleKey);

  // Word selection runs off #touch-capture in this document, not the book
  // iframe — bound once here rather than per chapter.
  initTouchSelection();

  // Swipe to turn pages. The capture layer owns the gesture (touch-action:
  // none), so it reports the flick and flipPage does its usual debounce.
  onBookSwipe(dir => flipPage(dir));

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
    clearTouchSelection();
    resizeTimer = setTimeout(() => {
      try { runtime.rendition.resize(); } catch {}
    }, 150);
  });
}
