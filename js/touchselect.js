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
import { dbg } from './debug.js';

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
  let painted = 0;
  for (const r of rects) {
    if (r.width <= 0 || r.height <= 0) continue;
    painted++;
    const d = document.createElement('div');
    d.className = 'sel-rect';
    d.style.left   = (r.left + off.left) + 'px';
    d.style.top    = (r.top  + off.top)  + 'px';
    d.style.width  = r.width  + 'px';
    d.style.height = r.height + 'px';
    el.appendChild(d);
  }
  dbg('paint:', painted + ' rects', 'ifrOff=' + Math.round(off.left) + ',' + Math.round(off.top));
}

export function clearTouchSelection() {
  const had = !!current;
  current = null;
  if (overlay) overlay.textContent = '';
  if (had) clearedCbs.forEach(cb => { try { cb(); } catch {} });
}

// ============================================================
// Hit testing
//
// This resolves the touch point to a text node + offset using layout geometry
// (Range rects), NOT document.caretRangeFromPoint. That matters: the book
// iframe has user-select:none (the whole point — it's what suppresses iOS's
// callout bar), and in WebKit an unselectable text node is not a valid
// selection candidate, so caretRangeFromPoint returns null or a position
// clamped outside the subtree. Geometry is unaffected by user-select.
//
// It also handles epub.js's paginated flow correctly: that's one long CSS
// multi-column run, so a single <p> extends across columns scrolled off
// screen. Comparing real rects picks the character actually under the finger.
// ============================================================
const BLOCK_TAGS = new Set(
  ['P','DIV','LI','BLOCKQUOTE','SECTION','ARTICLE','BODY','TD','PRE','H1','H2','H3','H4','H5','H6']);

// Nearest block-level ancestor — bounds how much text we scan.
function blockAncestor(node) {
  let el = node && node.nodeType === 3 ? node.parentNode : node;
  while (el && el.tagName && !BLOCK_TAGS.has(el.tagName) && el.parentNode) el = el.parentNode;
  return el || node;
}

// Distance² from (x, y) to a rect, 0 when inside.
function distToRect(r, x, y) {
  const dx = x < r.left ? r.left - x : (x > r.right  ? x - r.right  : 0);
  const dy = y < r.top  ? r.top  - y : (y > r.bottom ? y - r.bottom : 0);
  return dx * dx + dy * dy;
}

// Cheapest rejection: a text node's line boxes. Returns distance² to the
// closest one, so nodes nowhere near the finger never get scanned per-character.
function nodeDistance(probe, node, x, y) {
  try { probe.selectNodeContents(node); } catch { return Infinity; }
  let best = Infinity;
  for (const r of probe.getClientRects()) {
    if (!r.width && !r.height) continue;
    const d = distToRect(r, x, y);
    if (d < best) best = d;
    if (best === 0) break;
  }
  return best;
}

const NEAR_PX = 40;   // line boxes further than this are not under the finger

// -> { node, offset } | null
function textPositionAt(doc, x, y) {
  let hit;
  try { hit = doc.elementFromPoint(x, y); } catch { hit = null; }
  const root = blockAncestor(hit) || doc.body;
  if (!root) { dbg('hit: no root'); return null; }

  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const probe = doc.createRange();

  // Pass 1 — line-box pre-filter. Usually leaves one or two nodes.
  const near = [];
  let n;
  while ((n = walker.nextNode())) {
    if (!n.data || !n.data.trim()) continue;
    const d = nodeDistance(probe, n, x, y);
    if (d <= NEAR_PX * NEAR_PX) near.push([d, n]);
  }
  if (!near.length) { dbg('hit: no text near', '<' + (root.tagName || '?') + '>'); return null; }
  near.sort((a, b) => a[0] - b[0]);

  // Pass 2 — per-character scan of the closest nodes only.
  let best = null, bestD = Infinity;
  for (const [, node] of near.slice(0, 4)) {
    const len = node.data.length;
    for (let i = 0; i < len; i++) {
      try { probe.setStart(node, i); probe.setEnd(node, i + 1); } catch { continue; }
      const r = probe.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const d = distToRect(r, x, y);
      // Bias toward the character's leading half so a press lands on the
      // glyph you're actually over rather than its neighbour.
      if (d < bestD) { bestD = d; best = { node, offset: x > r.left + r.width / 2 ? i + 1 : i }; }
      if (bestD === 0 && d === 0) break;
    }
    if (bestD === 0) break;
  }
  if (best) { dbg('hit: geom', JSON.stringify(best.node.data.substr(Math.max(0, best.offset - 6), 12)), '@' + best.offset); return best; }

  // Last resort — the caret APIs. Only trusted when they land on a text node
  // inside the block we hit; on iOS with user-select:none they usually don't.
  try {
    let cr = null;
    if (doc.caretRangeFromPoint) cr = doc.caretRangeFromPoint(x, y);
    else if (doc.caretPositionFromPoint) {
      const pp = doc.caretPositionFromPoint(x, y);
      if (pp && pp.offsetNode) cr = { startContainer: pp.offsetNode, startOffset: pp.offset };
    }
    if (cr && cr.startContainer && cr.startContainer.nodeType === 3 && root.contains(cr.startContainer)) {
      dbg('hit: caretAPI');
      return { node: cr.startContainer, offset: cr.startOffset };
    }
    dbg('hit: caretAPI rejected', cr ? 'off-root' : 'null');
  } catch { dbg('hit: caretAPI threw'); }
  return null;
}

// ============================================================
// Word boundaries
// ============================================================
// Apostrophes stay inside the word (isn’t), hyphens don't — UAX#29 splits
// brown-fox into two words and so does iOS's own word selection, so the
// Segmenter path and this fallback agree.
const WORD_RE = /[\p{L}\p{N}\p{M}'’]+/gu;

let segmenter;   // undefined = not probed, false = unavailable
function getSegmenter() {
  if (segmenter !== undefined) return segmenter;
  try { segmenter = new Intl.Segmenter(undefined, { granularity: 'word' }); }
  catch { segmenter = false; }
  return segmenter;
}

// Every word span in `text`, in order. Intl.Segmenter handles CJK and other
// scripts a regex can't; the regex is the fallback for engines without it.
function wordSpans(text) {
  const seg = getSegmenter();
  const out = [];
  if (seg) {
    for (const s of seg.segment(text)) {
      if (s.isWordLike) out.push([s.index, s.index + s.segment.length]);
    }
    return out;
  }
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(text))) out.push([m.index, m.index + m[0].length]);
  return out;
}

// [start, end) of the word containing `offset`, or null.
function wordBoundsAt(text, offset) {
  for (const [a, b] of wordSpans(text)) {
    if (offset >= a && offset <= b) return [a, b];
  }
  return null;
}

// The word containing `offset`, or — when the press landed on whitespace or
// punctuation — the nearest word in the same text node. Returning null here
// is what made a long-press on the gap between two words do nothing at all.
function wordBoundsNear(text, offset) {
  const spans = wordSpans(text);
  if (!spans.length) return null;
  let best = null, bestD = Infinity;
  for (const [a, b] of spans) {
    if (offset >= a && offset <= b) return [a, b];
    const d = offset < a ? a - offset : offset - b;
    if (d < bestD) { bestD = d; best = [a, b]; }
  }
  return best;
}

// Range covering the whole word under (x, y), or null.
// Boundaries are resolved inside a single text node — a word split across
// inline tags (<em>) yields the node-local fragment.
function wordRangeAt(doc, x, y) {
  const pos = textPositionAt(doc, x, y);
  if (!pos) return null;
  const text = pos.node.data || '';
  const b = wordBoundsNear(text, Math.min(pos.offset, text.length));
  if (!b) { dbg('word: none in node'); return null; }
  const r = doc.createRange();
  try { r.setStart(pos.node, b[0]); r.setEnd(pos.node, b[1]); } catch { return null; }
  if (r.collapsed) return null;
  dbg('word:', JSON.stringify(r.toString()));
  return r;
}

// ============================================================
// Gesture recognizer — one per chapter iframe
// ============================================================
export function attachTouchSelection(doc, ifr) {
  if (!isCoarsePointer) { dbg('attach skipped: pointer is fine'); return; }
  if (!doc || doc.__touchSelAttached) return;
  doc.__touchSelAttached = true;
  dbg('attached to chapter', ifr ? 'iframe ok' : 'NO IFRAME (rects will be offset)');

  let touchId = null;  // identifier of the touch we're following, or null
  let start = null;    // { x, y } of the touch that may become a long press
  let timer = null;
  let anchor = null;   // word range under the initial press
  let active = false;  // long press fired — we own the gesture

  const cancelTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const reset = () => {
    cancelTimer();
    touchId = null; start = null; anchor = null; active = false;
  };

  // Our touch out of a multi-touch event, or null if it isn't in this event.
  const ours = (list) => {
    for (const t of list) if (t.identifier === touchId) return t;
    return null;
  };

  const setCurrent = (range) => {
    const text = range ? range.toString().trim() : '';
    current = text ? { text, range: range.cloneRange(), doc, ifr } : null;
    paint(current ? range : null, ifr);
  };

  // Not preventDefault'd — a plain tap must still reach reader.js's chrome
  // toggle and the edge page-flip zones. A second finger landing mid-gesture
  // is ignored rather than cancelling the drag.
  doc.addEventListener('touchstart', e => {
    if (touchId !== null) return;
    const t = e.changedTouches[0];
    if (!t) return;
    touchId = t.identifier;
    start = { x: t.clientX, y: t.clientY };
    dbg('touchstart', Math.round(t.clientX) + ',' + Math.round(t.clientY));
    timer = setTimeout(() => {
      timer = null;
      if (!start) return;
      dbg('longpress fired');
      const r = wordRangeAt(doc, start.x, start.y);
      if (!r) { dbg('-> no word, aborting'); return; }
      anchor = r;
      active = true;
      setCurrent(r);
    }, LONG_PRESS_MS);
  }, { passive: true });

  // Non-passive so it can preventDefault once the long press has fired.
  doc.addEventListener('touchmove', e => {
    const t = ours(e.touches);
    if (!t || !start) return;
    if (!active) {
      // Drifted before the timer → it's a scroll/swipe, not a press.
      if (Math.abs(t.clientX - start.x) > MOVE_TOLERANCE ||
          Math.abs(t.clientY - start.y) > MOVE_TOLERANCE) { dbg('drift -> cancelled'); reset(); }
      return;
    }
    e.preventDefault();   // we own the gesture — no scrolling mid-drag
    const focus = wordRangeAt(doc, t.clientX, t.clientY);
    if (!focus) return;
    setCurrent(unionRange(anchor, focus));
  }, { passive: false });

  doc.addEventListener('touchend', e => {
    if (!ours(e.changedTouches)) return;
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
    dbg('settled:', JSON.stringify(sel.text));
    settledCbs.forEach(cb => { try { cb(sel); } catch (err) { dbg('cb error:', String(err)); } });
  }, { passive: false });

  doc.addEventListener('touchcancel', e => {
    if (ours(e.changedTouches)) reset();
  }, { passive: true });
}
