// ============================================================
// Theme application: CSS variables on :root, book-content theming
// via epub.js themes API, color input sync, and the slider fill
// helper used by every range input.
// ============================================================

import { settings, runtime, relLuminance, persistSettings, isCoarsePointer, $ } from './state.js?v=41';

// epub.js hard-codes `padding-top: 20px; padding-bottom: 20px` on the book's
// <body> in Contents.columns() (0.3.93, dist/epub.js:6664). It is inline but not
// !important, so it could be overridden — it is left alone deliberately: it is
// the only vertical breathing room between the text and the edge that survives
// padV going to 0, and it happens to match the horizontal gap/2 epub.js applies.
// alignToLineGrid() just has to know it is there.
const EPUBJS_BODY_PAD = 40;

export function applyChromeTheme() {
  settings.dark = relLuminance(settings.bg) < 0.5;
  const root = document.documentElement;
  root.style.setProperty('--bg', settings.bg);
  root.style.setProperty('--fg', settings.fg);
  root.style.setProperty('--chrome-fg', settings.fg);
  root.style.setProperty('--chrome-hover', settings.fg);
  // Still four CSS variables — everything downstream reads them per edge — but
  // one setting drives each axis.
  root.style.setProperty('--pad-top', settings.padV + 'px');
  root.style.setProperty('--pad-bottom', settings.padV + 'px');
  root.style.setProperty('--pad-left', settings.padH + 'px');
  root.style.setProperty('--pad-right', settings.padH + 'px');
  alignToLineGrid();
  document.body.classList.toggle('dark-chrome', !!settings.dark);
  // Mark the swatch matching the current bg/fg pair, if any
  document.querySelectorAll('#color-options .theme-swatch').forEach(b => {
    const matches = b.dataset.bg.toLowerCase() === settings.bg.toLowerCase()
                 && b.dataset.fg.toLowerCase() === settings.fg.toLowerCase();
    b.classList.toggle('active', matches);
  });
  syncColorInputs();
}

// Paginated text is laid out as a column that fills from the top in whole
// line-heights, so whatever is left over — the column height modulo one line —
// is a strip at the foot of every page that can never hold anything. That strip
// lands on top of the bottom margin, which is why the gap under the text reads
// as bigger than the gap above it even though #viewer itself is perfectly
// symmetric. Trimming the column to a whole number of lines and splitting the
// remainder between top and bottom removes it.
//
// The column is NOT #viewer. epub.js's Contents.columns() writes, inline on the
// book's <body>, `height: <#viewer height>px` plus `padding: 20px <gap/2>px` and
// `box-sizing: border-box` — so the box that actually holds lines is 40px
// shorter than #viewer. Snapping #viewer instead of that box is what the first
// version of this function got wrong: with H % lh == 0 the real leftover became
// lh - (40 mod lh), i.e. 14px at 18px/1.5 — the very strip this exists to kill,
// reintroduced, and oscillating with the sliders (0px at lh 20, 14px at lh 27,
// 5px at lh 45) so it read like pagination noise rather than a bug.
//
// The half is floored because `extra` is usually odd: a fractional --pad-extra
// makes #viewer fractionally tall, and epub.js reads that height back through
// container.clientHeight, which rounds — putting up to 1px of the error back.
//
// This only removes the systematic part. Where a page ends is still ragged — a
// paragraph that cannot fit its next line breaks early — and no amount of
// padding arithmetic fixes that.
//
// It also assumes the page really renders at fontSize x lineHeight. bookForceCss
// forces line-height on block text so that holds for books that set their own,
// but a book that also scales paragraph font-size (`p { font-size: 0.9em }`)
// renders a different line box, and the strip comes back. Feeding a measured
// line height in here was tried and does not help: epub.js keeps its iframe at
// the old height, so the column never picks the trimmed size up.
// Real safe-area inset, in px. getComputedStyle doesn't evaluate env()/max()
// inside a custom property, so this reads it off a real property instead —
// scroll-padding-top/bottom on <html>, which is otherwise inert (html/body
// never scroll) and exists in css/reader.css purely as this channel.
function safeAreaInsetPx(edge) {
  const cs = getComputedStyle(document.documentElement);
  const v = edge === 'top' ? cs.scrollPaddingTop : cs.scrollPaddingBottom;
  return parseFloat(v) || 0;
}

export function alignToLineGrid() {
  const root = document.documentElement;
  const lh = settings.fontSize * settings.lineHeight;
  // window.innerHeight is the layout viewport on iOS Safari — it stays put
  // while the address/tab bar animates in and out, so it can be taller than
  // what #reader (position:fixed, sized to the visual viewport) actually
  // gets. visualViewport.height tracks the real, current visible height;
  // falling back to innerHeight only where visualViewport isn't available.
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  // Mirrors --eff-pad-top/--eff-pad-bottom's max(slider, safe area) in CSS —
  // top and bottom insets differ on a notched phone (status bar/notch vs.
  // home indicator), so this can no longer assume they're both settings.padV.
  const effTop = Math.max(settings.padV, safeAreaInsetPx('top'));
  const effBottom = Math.max(settings.padV, safeAreaInsetPx('bottom'));
  const avail = vh - effTop - effBottom - EPUBJS_BODY_PAD;
  const extra = (lh > 0 && avail > lh) ? (avail % lh) : 0;
  root.style.setProperty('--pad-extra', Math.floor(extra / 2) + 'px');
}

export function applyBookTheme() {
  const r = runtime.rendition;
  if (!r) return;
  r.themes.override('color', settings.fg, true);
  r.themes.override('background', settings.bg, true);
  r.themes.override('font-family', settings.fontFamily, true);
  r.themes.override('line-height', String(settings.lineHeight), true);
  r.themes.override('letter-spacing', settings.letterSpacing + 'px', true);
  r.themes.override('word-spacing', settings.wordSpacing + 'px', true);
  r.themes.fontSize(settings.fontSize + 'px');
  // Selection behaviour is set in bookForceCss() instead of here: themes.override
  // only reaches the book's <body>, and a book's own `p { -webkit-user-select }`
  // would win over the inherited value.
  applyBookStyle();
}

// The typography settings above are pushed through themes.override, which only sets
// them (inherited) on the book's <body>. A book's own per-element rules
// (`p { font-family: … }`, `p { text-align: justify }`) declare their own value, so the
// inherited body value never reaches them. To actually *force* our settings we inject a
// stylesheet with element selectors + !important straight into each book document.
// Paragraph-level text only — deliberately excludes body/div/headings so headers
// keep their own alignment (text-align inherits, so targeting containers would drag
// headings along with it).
const BLOCK_SEL = 'p,li,dd,dt,blockquote';
// code / monospace blocks keep their own font — they aren't part of the reading font.
const MONO_SEL = 'code,pre,kbd,samp,tt';

function bookForceCss() {
  const parts = [];
  if (settings.textAlign && settings.textAlign !== 'default')
    parts.push(`${BLOCK_SEL}{text-align:${settings.textAlign} !important}`);

  // Line spacing has to be forced at element level, not just inherited from
  // body via themes.override: a book's own `p { line-height: 1.15 }` is a
  // direct declaration and beats any inherited value, !important or not. So
  // without this the slider silently does nothing on such books — and the
  // line-grid snap in alignToLineGrid() is computed against a line height the
  // page never actually uses, which puts the dead strip back at the foot of
  // the page. Paragraph-level only, so headings keep their own tighter
  // leading, exactly as with text-align above.
  parts.push(`${BLOCK_SEL}{line-height:${settings.lineHeight} !important}`);

  // Force the reader font on everything, then hand code/monospace back their font.
  const decls = [`font-family:${settings.fontFamily} !important`];
  if (settings.letterSpacing) decls.push(`letter-spacing:${settings.letterSpacing}px !important`);
  if (settings.wordSpacing)   decls.push(`word-spacing:${settings.wordSpacing}px !important`);
  parts.push(`*{${decls.join(';')}}`);
  parts.push(`${MONO_SEL}{font-family:monospace !important}`);

  // The book renders in its own document, so the parent's ::selection rule does
  // not reach it. Desktop selects natively, so it needs the blue here too.
  parts.push(`::selection{background:#3d8bfd !important;color:#fff !important}`);

  // Touch: kill native selection outright. iOS shows its Copy / Look Up /
  // Translate callout bar whenever a native selection exists and offers no way
  // to suppress it, so js/touchselect.js does the selecting instead and paints
  // its own highlight. Desktop keeps real selection (and Cmd+C).
  parts.push(isCoarsePointer
    ? `*{-webkit-user-select:none !important;user-select:none !important;`
      + `-webkit-touch-callout:none !important;-webkit-tap-highlight-color:transparent !important}`
    : `*{-webkit-user-select:text !important;user-select:text !important;`
      + `-webkit-touch-callout:none !important}`);

  return parts.join('\n');
}

export function injectBookStyle(doc) {
  if (!doc) return;
  const id = 'reader-force-style';
  let el = doc.getElementById(id);
  if (!el) { el = doc.createElement('style'); el.id = id; (doc.head || doc.documentElement).appendChild(el); }
  el.textContent = bookForceCss();
}

export function applyBookStyle() {
  const r = runtime.rendition;
  if (!r) return;
  try { r.getContents().forEach(c => injectBookStyle(c.document)); } catch {}
}

export function syncColorInputs() {
  const bgC = $('bg-color');
  const bgH = $('bg-color-hex');
  const fgC = $('fg-color');
  const fgH = $('fg-color-hex');
  if (bgC) bgC.value = settings.bg;
  if (bgH) bgH.value = settings.bg.toUpperCase();
  if (fgC) fgC.value = settings.fg;
  if (fgH) fgH.value = settings.fg.toUpperCase();
}

export function applyAll() {
  applyChromeTheme();
  applyBookTheme();
  persistSettings();
}

// Call this both on init and on every range input event.
// It updates a CSS variable consumed by the WebKit slider track gradient
// so the filled portion (left of thumb) and faded portion (right) render correctly.
// Firefox uses ::-moz-range-progress, which doesn't need this, but setting --val
// is harmless there.
export function updateSliderFill(input) {
  const min = +input.min || 0;
  const max = +input.max || 100;
  const val = +input.value;
  const pct = max === min ? 0 : ((val - min) / (max - min)) * 100;
  input.style.setProperty('--val', pct + '%');
}
