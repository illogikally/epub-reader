// ============================================================
// Custom touch text selection for book iframes.
//
// iOS gives web content no way to suppress the selection callout bar
// (Copy / Look Up / Translate). It appears whenever a *native* selection
// exists, and -webkit-touch-callout only ever suppressed the link/image
// preview sheet. So on touch devices we never create a native selection:
// theme.js forces user-select:none inside the book iframe and this module
// implements selection itself.
//
//   long-press (400ms, <10px drift) → select the word under the finger
//   drag while held                 → extend word-by-word
//   short tap with a selection live → clear it
//
// The highlight is painted as fixed-position rects in the PARENT document
// (#sel-overlay) rather than by wrapping nodes in the book DOM, which would
// invalidate epub.js CFIs. range.getClientRects() is iframe-viewport-relative,
// so each rect is offset by the iframe's own bounding rect.
//
// Desktop is untouched — everything here no-ops on a fine pointer.
// ============================================================

import { $, isCoarsePointer } from './state.js';

const LONG_PRESS_MS  = 400;
const MOVE_TOLERANCE = 10;

// The one live selection, or null. Shape matches what translate.js needs:
// { text, range, doc, ifr }.
let current = null;
let lastGesture = 0;
let overlay = null;

const settledCbs = [];
const clearedCbs = [];

export function onSelectionSettled(cb) { settledCbs.push(cb); }
export function onSelectionCleared(cb) { clearedCbs.push(cb); }

export function getTouchSelection() { return current; }
export function hasTouchSelection() { return !!(current && current.text); }
export function lastGestureAt()     { return lastGesture; }

// ============================================================
// Highlight overlay (parent document)
// ============================================================
function getOverlay() {
  if (overlay && overlay.isConnected) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'sel-overlay';
  ($('viewer') || document.body).appendChild(overlay);
  return overlay;
}

function paint(range, ifr) {
  const el = getOverlay();
  el.textContent = '';
  if (!range) return;
  let rects, off;
  try {
    rects = range.getClientRects();
    off = ifr ? ifr.getBoundingClientRect() : { left: 0, top: 0 };
  } catch { return; }
  for (const r of rects) {
    if (r.width <= 0 || r.height <= 0) continue;
    const d = document.createElement('div');
    d.className = 'sel-rect';
    d.style.left   = (r.left + off.left) + 'px';
    d.style.top    = (r.top  + off.top)  + 'px';
    d.style.width  = r.width  + 'px';
    d.style.height = r.height + 'px';
    el.appendChild(d);
  }
}

export function clearTouchSelection() {
  const had = !!current;
  current = null;
  if (overlay) overlay.textContent = '';
  if (had) clearedCbs.forEach(cb => { try { cb(); } catch {} });
}

// ============================================================
// Hit testing
// ============================================================
function firstTextNode(node) {
  if (!node) return null;
  if (node.nodeType === 3) return node;
  const w = node.ownerDocument.createTreeWalker(node, 4 /* SHOW_TEXT */);
  return w.nextNode();
}

// Last-resort caret hit test: walk the text under elementFromPoint and pick the
// character box nearest (x, y). O(chars in the hit element) — fine for a <p>.
function caretFallback(doc, x, y) {
  let el;
  try { el = doc.elementFromPoint(x, y); } catch { return null; }
  if (!el) return null;
  const walker = doc.createTreeWalker(el, 4 /* SHOW_TEXT */);
  const probe = doc.createRange();
  let best = null, bestD = Infinity, n;
  while ((n = walker.nextNode())) {
    const len = (n.data || '').length;
    for (let i = 0; i < len; i++) {
      probe.setStart(n, i);
      probe.setEnd(n, i + 1);
      const rc = probe.getBoundingClientRect();
      if (!rc.width && !rc.height) continue;
      const dx = x < rc.left ? rc.left - x : (x > rc.right  ? x - rc.right  : 0);
      const dy = y < rc.top  ? rc.top  - y : (y > rc.bottom ? y - rc.bottom : 0);
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = [n, i]; }
      if (bestD === 0) break;
    }
    if (bestD === 0) break;
  }
  if (!best) return null;
  const r = doc.createRange();
  r.setStart(best[0], best[1]);
  r.collapse(true);
  return r;
}

function caretRangeAt(doc, x, y) {
  try {
    if (doc.caretRangeFromPoint) {          // WebKit / Blink
      const r = doc.caretRangeFromPoint(x, y);
      if (r) return r;
    } else if (doc.caretPositionFromPoint) { // Gecko
      const p = doc.caretPositionFromPoint(x, y);
      if (p && p.offsetNode) {
        const r = doc.createRange();
        r.setStart(p.offsetNode, p.offset);
        r.collapse(true);
        return r;
      }
    }
  } catch {}
  return caretFallback(doc, x, y);
}

// ============================================================
// Word boundaries
// ============================================================
const WORD_RE = /[\p{L}\p{N}\p{M}'’-]+/gu;

let segmenter;   // undefined = not probed, false = unavailable
function getSegmenter() {
  if (segmenter !== undefined) return segmenter;
  try { segmenter = new Intl.Segmenter(undefined, { granularity: 'word' }); }
  catch { segmenter = false; }
  return segmenter;
}

// [start, end) of the word containing `offset`, or null when offset sits in
// whitespace / punctuation. Intl.Segmenter handles CJK and other scripts that
// a regex can't; the regex is the fallback for engines without it.
function wordBoundsAt(text, offset) {
  const seg = getSegmenter();
  if (seg) {
    for (const s of seg.segment(text)) {
      if (!s.isWordLike) continue;
      const end = s.index + s.segment.length;
      if (offset >= s.index && offset <= end) return [s.index, end];
    }
    return null;
  }
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(text))) {
    const end = m.index + m[0].length;
    if (offset >= m.index && offset <= end) return [m.index, end];
  }
  return null;
}

// Range covering the whole word under (x, y), or null.
// Boundaries are resolved inside a single text node — a word split across
// inline tags (<em>) yields the node-local fragment.
function wordRangeAt(doc, x, y) {
  const caret = caretRangeAt(doc, x, y);
  if (!caret) return null;
  let node = caret.startContainer;
  let offset = caret.startOffset;
  if (node.nodeType !== 3) {
    const kids = node.childNodes;
    const pick = kids.length ? kids[Math.min(offset, kids.length - 1)] : null;
    node = firstTextNode(pick) || firstTextNode(node);
    if (!node) return null;
    offset = 0;
  }
  const text = node.data || '';
  const b = wordBoundsAt(text, Math.min(offset, text.length));
  if (!b) return null;
  const r = doc.createRange();
  r.setStart(node, b[0]);
  r.setEnd(node, b[1]);
  return r.collapsed ? null : r;
}

// Smallest range covering both — this is what makes the drag extend by whole
// words in either direction from the anchor.
function unionRange(a, b) {
  if (!a) return b;
  if (!b) return a;
  const r = a.cloneRange();
  try {
    if (b.compareBoundaryPoints(Range.START_TO_START, r) < 0)
      r.setStart(b.startContainer, b.startOffset);
    if (b.compareBoundaryPoints(Range.END_TO_END, r) > 0)
      r.setEnd(b.endContainer, b.endOffset);
  } catch { return a; }
  return r;
}

// ============================================================
// Gesture recognizer — one per chapter iframe
// ============================================================
export function attachTouchSelection(doc, ifr) {
  if (!isCoarsePointer || !doc || doc.__touchSelAttached) return;
  doc.__touchSelAttached = true;

  let start = null;    // { x, y } of the touch that may become a long press
  let timer = null;
  let anchor = null;   // word range under the initial press
  let active = false;  // long press fired — we own the gesture

  const cancelTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const reset = () => { cancelTimer(); start = null; anchor = null; active = false; };

  const setCurrent = (range) => {
    const text = range ? range.toString().trim() : '';
    current = text ? { text, range: range.cloneRange(), doc, ifr } : null;
    paint(current ? range : null, ifr);
  };

  // Not preventDefault'd — a plain tap must still reach reader.js's
  // chrome toggle and the edge page-flip zones.
  doc.addEventListener('touchstart', e => {
    reset();
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
    timer = setTimeout(() => {
      timer = null;
      if (!start) return;
      const r = wordRangeAt(doc, start.x, start.y);
      if (!r) return;
      anchor = r;
      active = true;
      setCurrent(r);
    }, LONG_PRESS_MS);
  }, { passive: true });

  // Non-passive so it can preventDefault once the long press has fired.
  doc.addEventListener('touchmove', e => {
    if (!start) return;
    const t = e.touches[0];
    if (!t) return;
    if (!active) {
      // Drifted before the timer → it's a scroll/swipe, not a press.
      if (Math.abs(t.clientX - start.x) > MOVE_TOLERANCE ||
          Math.abs(t.clientY - start.y) > MOVE_TOLERANCE) reset();
      return;
    }
    e.preventDefault();   // we own the gesture — no scrolling mid-drag
    const focus = wordRangeAt(doc, t.clientX, t.clientY);
    if (!focus) return;
    setCurrent(unionRange(anchor, focus));
  }, { passive: false });

  doc.addEventListener('touchend', e => {
    const wasActive = active;
    reset();
    if (!wasActive) {
      // Plain tap. reader.js's touchend runs first and skips the chrome
      // toggle while hasTouchSelection() is true, so clearing here gives
      // "tap once to dismiss the selection".
      if (current) clearTouchSelection();
      return;
    }
    e.preventDefault();   // suppress the synthetic click
    lastGesture = Date.now();
    if (!current) { clearTouchSelection(); return; }
    const sel = current;
    settledCbs.forEach(cb => { try { cb(sel); } catch {} });
  }, { passive: false });

  doc.addEventListener('touchcancel', () => { reset(); }, { passive: true });
}
