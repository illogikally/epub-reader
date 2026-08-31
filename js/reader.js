// ============================================================
// Book opening / rendition / page navigation / chrome controls.
//
// Chrome toggle: tapping/clicking the middle of the book (not the edges,
// which flip pages) shows or hides the floating chrome controls — no
// persistent on-screen button. Touch uses onBookTap() (touchselect.js),
// which already only fires for a tap that lands away from the edges.
// Desktop has no such gesture natively, so attachInputHandlers() below adds
// a click listener deferred 250ms and cancelled by a following dblclick, so
// it never fires mid-double-click word selection.
// ============================================================

import {
  settings, runtime, $, dbGet, dbPut, getProgress, setProgress, isCoarsePointer,
} from './state.js?v=46';
import { applyBookTheme, injectBookStyle, alignToLineGrid } from './theme.js?v=46';
import {
  hidePopup, isPopupVisible,
  attachSelectionHandler, attachOutsideClickToFrame,
  stopBubble,
  buildToc, setTocPosition, markTocCurrent, readingProgress,
} from './translate.js?v=46';
import { renderLibrary } from './library.js?v=46';
import {
  initTouchSelection, clearTouchSelection, onBookSwipe, onBookTap,
} from './touchselect.js?v=46';
import { dbg } from './debug.js?v=46';

const library = $('library');
const reader = $('reader');
const viewer = $('viewer');
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
// A center tap/click's actual effect: dismiss a live lookup popup first (it
// sits over the same area a chrome toggle would), otherwise toggle chrome.
// Shared by the touch (onBookTap) and desktop (click, below) paths so the
// two can't drift.
function toggleChromeOrDismissPopup() {
  if (isPopupVisible()) hidePopup();
  else toggleChrome();
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

    const saved = getProgress(runtime.currentBookKey);
    await runtime.rendition.display(saved?.cfi || undefined);
    localStorage.setItem('reader-last-book', id);
    requestAnimationFrame(relayoutViewer);
    setTimeout(relayoutViewer, 80);

    const nav = await runtime.book.loaded.navigation;
    buildToc(nav.toc || [], { title: record.title, cover: record.cover });
    // Progress is already on screen from the byte-size estimate. This loads the
    // cached locations, or generates them off the critical path, and swaps in
    // the exact figure when it lands.
    primeLocations(record);
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
  // Leaving a book is the natural moment to get its position off this device.
  document.dispatchEvent(new CustomEvent('reader:syncRequest'));
  document.title = 'Xulgon'
}

// How far into the book we are. readingProgress() prefers epubjs's own exact
// figure once book.locations exists and falls back to a byte-size estimate
// until then — see the note on it in translate.js.
//
// The figure is shown on the Contents row of the floating chrome (which also
// fills as a progress bar) and in the TOC drawer header; setTocPosition drives
// both. There used to be a third readout floating at the bottom of the screen —
// it was removed, and this is all that is left of it.
function updateProgress(loc) {
  const pct = readingProgress(loc);
  setTocPosition(typeof pct === 'number' && pct >= 0 && pct <= 1 ? pct : null);
  markTocCurrent(loc?.start?.index);
}

// Re-run the progress readout against wherever we currently are. Called when
// locations arrive, so the number sharpens in place without waiting for the
// reader to turn a page.
function refreshProgress() {
  try {
    const loc = runtime.rendition?.currentLocation();
    if (loc?.start) updateProgress(loc);
  } catch {}
}

const whenIdle = (fn) => (typeof requestIdleCallback === 'function')
  ? requestIdleCallback(fn, { timeout: 3000 })
  : setTimeout(fn, 1200);

// book.locations turns the progress readout from an estimate into epubjs's own
// exact figure. Generating it parses every section's text, which is why it does
// not block opening the book: the estimate is already on screen and correct
// enough, and this swaps in the precise number a few seconds later.
//
// Locations depend on the book's text alone — not on layout — so font size,
// margins and single/dual page never invalidate them. Generate once, cache on
// the book record, load instantly from then on.
async function primeLocations(record) {
  const book = runtime.book;
  if (!book?.locations) return;

  if (record.locations) {
    try {
      book.locations.load(record.locations);
      dbg('locations: loaded', book.locations.length(), 'from cache');
      refreshProgress();
      return;
    } catch (err) {
      dbg('locations: cache unusable —', err.message);
    }
  }

  whenIdle(async () => {
    // The reader may have gone back to the library, or opened another book,
    // while we waited for an idle slot.
    if (runtime.book !== book || runtime.currentBookKey !== record.id) return;
    try {
      dbg('locations: generating…');
      // 1600 chars per location: ~1.2k entries for a novel instead of the ~12k
      // the default 150 would produce, at precision far finer than the 1% shown.
      await book.locations.generate(1600);
      if (runtime.book !== book || runtime.currentBookKey !== record.id) return;
      dbg('locations: generated', book.locations.length());
      refreshProgress();

      // Re-read rather than re-putting the record we were handed: its `data`
      // buffer has already been through window.ePub().
      const fresh = await dbGet(record.id);
      if (!fresh) return;
      fresh.locations = book.locations.save();
      await dbPut(fresh);
      dbg('locations: cached');
    } catch (err) {
      dbg('locations: failed —', err.message);   // estimate stays in place
    }
  });
}

// rendition.resize() alone changes the Stage/iframe box but not what's
// actually laid out inside it: epub.js's Contents.columns() bakes the box
// height into an inline `height` px on the book's <body>, written once when a
// section is displayed, and resize() never rewrites it — the column just
// keeps whatever height it had. So after any change to #viewer's own box
// (a margin/font/line-height slider, or the window/visualViewport actually
// resizing) the book's content can be shorter than the new box, and the
// difference shows up as dead space at the foot of the page. Re-displaying
// the current location forces Contents.columns() to run again against the
// current size, which is the only thing that has been found to reliably
// clear it.
export function relayoutViewer() {
  const r = runtime.rendition;
  if (!r) return;
  try {
    const cfi = r.currentLocation()?.start?.cfi;
    r.resize();
    if (cfi) r.display(cfi);
  } catch {}
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
      setProgress(runtime.currentBookKey, loc.start.cfi);
    }
    updateProgress(loc);
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
// Per-iframe input handlers
// ============================================================

// Shared across every chapter document a book renders — a click in chapter
// A followed fast enough by a dblclick's second click landing in freshly
// rendered chapter B (a page turn mid double-click) should still cancel.
let chromeClickTimer = null;

function attachInputHandlers(doc) {
  // Wheel — desktop only path; flips a page per scroll burst.
  doc.addEventListener('wheel', e => {
    if (Math.abs(e.deltaY) < 4 && Math.abs(e.deltaX) < 4) return;
    e.preventDefault();
    const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    flipPage(delta);
  }, { passive: false });

  doc.addEventListener('keydown', handleKey);

  // Desktop center-tap-to-toggle-chrome. Touch never reaches here —
  // #touch-capture overlays the iframe and owns every touch gesture — but
  // the guard makes that on purpose rather than incidental. Deferred so a
  // double-click (word selection) doesn't also toggle chrome; the pending
  // toggle is cancelled if a dblclick follows.
  if (!isCoarsePointer) {
    doc.addEventListener('click', e => {
      if (e.target.closest('a')) return;         // let link taps navigate
      if (doc.getSelection().toString()) return;  // a selection, not a toggle
      clearTimeout(chromeClickTimer);
      chromeClickTimer = setTimeout(toggleChromeOrDismissPopup, 250);
    });
    doc.addEventListener('dblclick', () => clearTimeout(chromeClickTimer));
  }
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

  // Touch center-tap-to-toggle-chrome. onBookTap() (touchselect.js) already
  // only fires for a tap that lands away from the edges — #zone-left/right
  // are separate elements outside #touch-capture's inset box, so an edge tap
  // never reaches it.
  onBookTap(toggleChromeOrDismissPopup);

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

  // Wrapper catches taps on the dimmed background; clicks on the buttons inside
  // bubble up but are filtered out by the target === currentTarget check.
  $('chrome-wrap').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) hideChrome();
  });

  // Window resize → relayout (debounced)
  let resizeTimer;
  const relayout = () => {
    // Before the early return: the line-grid remainder depends on the window
    // height, and it has to be right by the time a book is opened even if the
    // resize happened back on the library screen.
    alignToLineGrid();
    if (!runtime.rendition) return;
    clearTimeout(resizeTimer);
    clearTouchSelection();
    resizeTimer = setTimeout(relayoutViewer, 150);
  };
  window.addEventListener('resize', relayout);
  // iOS Safari does not reliably fire `resize` on `window` when its address/tab
  // bar shows or hides — only visualViewport does. Without this, #viewer grows
  // once the chrome collapses but epub.js's iframe keeps its stale height, and
  // the difference shows up as dead space at the foot of the page, below the
  // last line of text and above the chrome dot.
  window.visualViewport?.addEventListener('resize', relayout);
}
