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

import { $, isCoarsePointer, runtime } from './state.js?v=33';
import { dbg, dbgStatus } from './debug.js?v=33';

const LONG_PRESS_MS  = 400;
// Drift allowed while waiting out the long press. Generous on purpose: a finger
// held still for 400ms on a phone routinely wanders more than 10px, and at 10px
// the timer was cancelled before any selection could form. Being loose is safe
// because touch-action:none means no scroll can be stolen from us — the only
// thing this guards against is a swipe, which travels far past 18px.
const HOLD_TOLERANCE = 18;
// Separate question, asked at touchend: was this a tap or a drag?
const MOVE_TOLERANCE = 10;
// Swipe-to-turn-page: a horizontal flick. Deliberately loose — a page turn is
// cheap to undo, and nothing else competes for the gesture: a selection drag
// clears `swipe` outright, and a tap can only travel MOVE_TOLERANCE (10px),
// well short of SWIPE_MIN_X.
const SWIPE_MS       = 900;   // slower, lazier flicks still count
const SWIPE_MIN_X    = 35;    // about a thumb-width of travel
const SWIPE_RATIO    = 1.2;   // |dx| must beat |dy| by this much

// The one live selection, or null. Shape matches what translate.js needs:
// { text, range, doc, ifr }.
let current = null;
let lastGesture = 0;
let overlay = null;

const settledCbs = [];
const clearedCbs = [];
const tapCbs     = [];
const swipeCbs   = [];

export function onSelectionSettled(cb) { settledCbs.push(cb); }
export function onSelectionCleared(cb) { clearedCbs.push(cb); }
// A short tap on the book that wasn't a link and didn't dismiss a selection.
// The capture layer swallows it, so anything that used to listen for a tap
// inside the iframe subscribes here instead.
export function onBookTap(cb) { tapCbs.push(cb); }
// A horizontal flick across the book. reader.js can't be imported here (it
// already imports this module), so page turning is reported the same way.
export function onBookSwipe(cb) { swipeCbs.push(cb); }

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
  // Indexed, not for...of — see ours() below: getClientRects() returns a
  // DOMRectList, a legacy array-like with no Symbol.iterator in WebKit.
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
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
  dbgStatus('sel', 'none');
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
  const rects = probe.getClientRects();   // DOMRectList — index it, don't iterate
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
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

// Smallest range covering both — this is what makes a drag extend by whole
// words in either direction from the anchor.
//
// compareBoundaryPoints(how, source) compares THIS range's point against the
// SOURCE range's point: START_TO_START is this.start vs source.start, and
// END_TO_END is this.end vs source.end.
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
// Gesture recognizer — bound to #touch-capture in the PARENT document.
//
// Listeners bound inside the epub.js iframe never receive touch events on iOS.
// Three targets (document / body / window) and two attach paths (the `rendered`
// event and rendition.hooks.content) were all silent, while plain divs in the
// parent (#zone-left / #zone-right) receive touches fine. So the gesture is
// driven from a transparent parent-document layer over the book, and the touch
// point is translated into iframe coordinates for hit testing. Reading the
// iframe's DOM from the parent works — that is how the book CSS is injected.
// ============================================================

// Drop any native selection in this document. The CSS should prevent one from
// starting, but a drag begun outside the layer (or a stale cached stylesheet)
// can still produce one, and iOS will happily select the whole reader shell.
// Form fields must keep native selection or they can't take a caret on iOS,
// so they are the one place the watchdog leaves alone.
function inFormField(node) {
  let el = node && node.nodeType === 3 ? node.parentNode : node;
  while (el) {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return true;
    el = el.parentNode;
  }
  return false;
}

function dropNativeSelection() {
  try {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) return;
    if (inFormField(sel.anchorNode)) return;
    sel.removeAllRanges();
  } catch {}
}

// Runtime backstop for the CSS. Getting user-select right by selector has been
// unreliable across several iOS builds, so anything that slips through is
// removed the instant it forms — which takes the callout bar with it.
// removeAllRanges() re-fires selectionchange, but that pass sees a collapsed
// selection and returns, so this does not loop.
let watchdogOn = false;
function startSelectionWatchdog() {
  if (watchdogOn) return;
  watchdogOn = true;
  document.addEventListener('selectstart', (e) => {
    if (inFormField(e.target)) return;
    e.preventDefault();
  });
  document.addEventListener('selectionchange', dropNativeSelection);
  dbg('native-selection watchdog on');
}

// The iframe under a parent-space point, plus that point in iframe coordinates.
function frameAt(x, y) {
  const viewer = $('viewer');
  if (!viewer) return null;
  const frames = viewer.querySelectorAll('iframe');
  dbgStatus('iframes', frames.length);
  for (let i = 0; i < frames.length; i++) {
    const ifr = frames[i];
    const r = ifr.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    let doc;
    try { doc = ifr.contentDocument || ifr.contentWindow?.document; } catch { continue; }
    if (!doc) continue;
    return { ifr, doc, x: x - r.left, y: y - r.top };
  }
  return null;
}

// The capture layer covers the book, so taps no longer reach it. Give back the
// one thing that actually needs a tap: following a link inside the book.
function followLinkAt(hit) {
  let el;
  try { el = hit.doc.elementFromPoint(hit.x, hit.y); } catch { return false; }
  while (el && el.tagName !== 'A') el = el.parentElement;
  const href = el && el.getAttribute('href');
  if (!href) return false;
  dbg('link tap ->', href);
  try { runtime.rendition && runtime.rendition.display(href); } catch (err) { dbg('link error:', String(err)); }
  return true;
}

// The layer is built here rather than relied upon from index.html. Safari
// caches HTML, CSS and JS independently, so fresh JS can easily find itself
// looking for an element that a stale index.html never contained — which
// silently disables selection with no visible cause. Creating it removes that
// dependency entirely; the markup in index.html is just the fast path.
function ensureCaptureLayer() {
  let layer = $('touch-capture');
  if (layer) { dbgStatus('layer', 'Y'); return layer; }

  const host = $('reader');
  if (!host) { dbgStatus('layer', 'NO-READER'); return null; }

  layer = document.createElement('div');
  layer.id = 'touch-capture';
  // Inline geometry so a stale reader.css can't disable it either.
  Object.assign(layer.style, {
    position: 'absolute',
    top: 'var(--pad-top)',
    bottom: 'var(--pad-bottom)',
    left: 'var(--pad-left)',
    right: 'var(--pad-right)',
    zIndex: '4',
    background: 'transparent',
    pointerEvents: 'auto',
    // The element that receives the long-press must never depend on a cached
    // stylesheet to be unselectable, or iOS starts its own page-wide selection.
    webkitUserSelect: 'none',
    userSelect: 'none',
    webkitTouchCallout: 'none',
    // We own every gesture here; see the stylesheet rule for why.
    touchAction: 'none',
  });
  host.appendChild(layer);
  dbg('created #touch-capture (was missing from the HTML)');
  dbgStatus('layer', 'Y(made)');
  return layer;
}

export function initTouchSelection() {
  dbgStatus('coarse', isCoarsePointer ? 'Y' : 'N');
  if (!isCoarsePointer) { dbg('touch selection off: pointer is fine'); return; }
  startSelectionWatchdog();
  const layer = ensureCaptureLayer();
  if (!layer) { dbg('NO #touch-capture element and could not create one'); return; }

  let touchId = null;   // identifier of the touch we're following, or null
  let start = null;     // { x, y } in parent space
  let startedAt = 0;
  let timer = null;
  let hitDoc = null;    // { ifr, doc } resolved at press time
  let anchor = null;    // word range under the initial press
  let active = false;   // long press fired — we own the gesture

  // Tracked separately from everything above: reset() wipes `start`, and the
  // swipe decision can only be made at touchend, after that has happened.
  let swipe = null;     // { x, y, t, id }

  const cancelTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const reset = () => {
    cancelTimer();
    touchId = null; start = null; startedAt = 0; hitDoc = null; anchor = null; active = false;
  };

  // Any throw must leave the state machine neutral. A previous version could
  // wedge permanently on an exception and go silently dead.
  const guarded = (name, fn) => (e) => {
    try { fn(e); }
    catch (err) { dbg('handler error [' + name + ']:', String(err)); reset(); }
  };

  const STALE_MS = 2000;

  // Indexed loop: TouchList is a legacy array-like with no Symbol.iterator in
  // WebKit, so `for (const t of list)` throws a TypeError on iOS.
  const ours = (list) => {
    if (!list) return null;
    for (let i = 0; i < list.length; i++) {
      if (list[i].identifier === touchId) return list[i];
    }
    return null;
  };

  let lastDragLog = 0;

  const setCurrent = (range) => {
    const text = range ? range.toString().trim() : '';
    current = text && hitDoc
      ? { text, range: range.cloneRange(), doc: hitDoc.doc, ifr: hitDoc.ifr }
      : null;
    dbgStatus('sel', current ? JSON.stringify(current.text) : 'none');
    paint(current ? range : null, hitDoc && hitDoc.ifr);
  };

  layer.addEventListener('touchstart', guarded('touchstart', e => {
    const t = e.changedTouches[0];
    dropNativeSelection();
    dbg('capture touchstart', t ? Math.round(t.clientX) + ',' + Math.round(t.clientY) : 'no touch',
        'touchId=' + touchId);
    if (touchId !== null) {
      if (Date.now() - startedAt < STALE_MS) return;
      dbg('stale gesture -> taking over');
      reset();
    }
    if (!t) return;
    touchId = t.identifier;
    startedAt = Date.now();
    start = { x: t.clientX, y: t.clientY };
    swipe = { x: t.clientX, y: t.clientY, t: Date.now(), id: t.identifier };
    timer = setTimeout(() => {
      timer = null;
      if (!start) return;
      dropNativeSelection();
      const hit = frameAt(start.x, start.y);
      if (!hit) { dbg('longpress: no iframe under point'); return; }
      dbg('longpress fired -> iframe local', Math.round(hit.x) + ',' + Math.round(hit.y));
      hitDoc = hit;
      const r = wordRangeAt(hit.doc, hit.x, hit.y);
      if (!r) { dbg('-> no word, aborting'); hitDoc = null; return; }
      anchor = r;
      active = true;
      setCurrent(r);
    }, LONG_PRESS_MS);
  }), { passive: true });

  // Non-passive so it can preventDefault once the long press has fired.
  layer.addEventListener('touchmove', guarded('touchmove', e => {
    const t = ours(e.touches);
    if (!t || !start) return;
    if (!active) {
      // Drifted before the timer → it's a scroll/swipe, not a press.
      if (Math.abs(t.clientX - start.x) > HOLD_TOLERANCE ||
          Math.abs(t.clientY - start.y) > HOLD_TOLERANCE) {
        // Not a press. The swipe tracker deliberately survives this — touchend
        // still has to be able to read it.
        dbg('drift -> not a press');
        reset();
      }
      return;
    }
    e.preventDefault();   // we own the gesture — no scrolling mid-drag
    swipe = null;         // a selection drag is never a page swipe
    if (!hitDoc) return;
    const r = hitDoc.ifr.getBoundingClientRect();
    const focus = wordRangeAt(hitDoc.doc, t.clientX - r.left, t.clientY - r.top);
    // Throttled so a drag can't flood the panel off the top.
    const now = Date.now();
    if (now - lastDragLog > 250) {
      lastDragLog = now;
      dbg('drag', Math.round(t.clientX) + ',' + Math.round(t.clientY),
          focus ? JSON.stringify(focus.toString()) : 'no word');
    }
    if (!focus) return;
    setCurrent(unionRange(anchor, focus));
  }), { passive: false });

  layer.addEventListener('touchend', guarded('touchend', e => {
    // Taken straight from the event, NOT via ours(): a drift-cancel has already
    // run reset() and nulled touchId by this point, and gating on it here is
    // what made every swipe unreachable — a swipe is precisely the gesture that
    // drift-cancels. isOurs gates the selection/tap branches instead.
    const t = e.changedTouches[0];
    if (!t) return;
    const isOurs = touchId !== null && t.identifier === touchId;
    const wasActive = active && isOurs;
    const tapStart = start;
    const dt = startedAt ? Date.now() - startedAt : Infinity;
    const moved = !!tapStart
      && (Math.abs(t.clientX - tapStart.x) > MOVE_TOLERANCE
       || Math.abs(t.clientY - tapStart.y) > MOVE_TOLERANCE);
    if (isOurs) reset();

    if (wasActive) {
      e.preventDefault();   // suppress the synthetic click
      lastGesture = Date.now();
      if (!current) { clearTouchSelection(); return; }
      const sel = current;
      dbg('settled:', JSON.stringify(sel.text));
      settledCbs.forEach(cb => { try { cb(sel); } catch (err) { dbg('cb error:', String(err)); } });
      return;
    }

    // Horizontal flick → turn the page. Evaluated without isOurs, and before
    // the tap branch so one gesture can't both swipe and dismiss the popup.
    if (swipe && swipe.id === t.identifier) {
      const dx = t.clientX - swipe.x;
      const dy = t.clientY - swipe.y;
      const sdt = Date.now() - swipe.t;
      swipe = null;
      const ok = sdt < SWIPE_MS
              && Math.abs(dx) > SWIPE_MIN_X
              && Math.abs(dx) > Math.abs(dy) * SWIPE_RATIO;
      // Logged either way: if the thresholds are wrong for how the flick is
      // actually performed, the numbers are on screen rather than guessed at.
      dbg('touchend dx=' + Math.round(dx), 'dy=' + Math.round(dy), 'dt=' + sdt,
          ok ? '-> SWIPE' : '-> no swipe');
      if (ok) {
        const dir = dx < 0 ? 1 : -1;   // flick left = next page
        dbg('swipe', dir > 0 ? 'next' : 'prev');
        if (current) clearTouchSelection();
        swipeCbs.forEach(cb => { try { cb(dir); } catch (err) { dbg('swipe cb error:', String(err)); } });
        return;
      }
    }

    // Everything below belongs to the gesture we were tracking.
    if (!isOurs) return;

    // Short tap. Dismiss a live selection first; otherwise let it act on the
    // book underneath, which the capture layer would otherwise swallow.
    if (dt > 350 || moved) return;
    if (current) { clearTouchSelection(); return; }
    const hit = frameAt(t.clientX, t.clientY);
    if (hit && followLinkAt(hit)) { e.preventDefault(); return; }
    tapCbs.forEach(cb => { try { cb(); } catch (err) { dbg('tap cb error:', String(err)); } });
  }), { passive: false });

  layer.addEventListener('touchcancel', guarded('touchcancel', e => {
    if (ours(e.changedTouches)) { dbg('touchcancel -> reset'); swipe = null; reset(); }
  }), { passive: true });

  dbg('capture layer ready (build stamp in header)');
}
