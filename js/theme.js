// ============================================================
// Theme application: CSS variables on :root, book-content theming
// via epub.js themes API, color input sync, and the slider fill
// helper used by every range input.
// ============================================================

import { settings, runtime, relLuminance, persistSettings, isCoarsePointer, $ } from './state.js?v=39';

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

// Paginated text is laid out as a column exactly as tall as #viewer. Lines fill
// it from the top in whole line-heights, so whatever is left over — the column
// height modulo one line — is a strip at the foot of every page that can never
// hold anything. That strip lands on top of the bottom margin, which is why the
// gap under the text reads as bigger than the gap above it even though #viewer
// itself is perfectly symmetric.
//
// Trimming the viewer to a whole number of lines and splitting the remainder
// between top and bottom removes it. Half on each side is a fixed point: the
// new height is exactly `usable`, so the remainder does not need recomputing.
//
// This only removes the systematic part. Where a page ends is still ragged —
// a paragraph that cannot fit its next line breaks early — and no amount of
// padding arithmetic fixes that.
//
// It also assumes the page really renders at fontSize x lineHeight. bookForceCss
// forces line-height on block text so that holds for books that set their own,
// but a book that also scales paragraph font-size (`p { font-size: 0.9em }`)
// renders a different line box, and the strip comes back. Feeding a measured
// line height in here was tried and does not help: epub.js keeps its iframe at
// the old height, so the column never picks the trimmed size up.
export function alignToLineGrid() {
  const root = document.documentElement;
  const lh = settings.fontSize * settings.lineHeight;
  const avail = window.innerHeight - 2 * settings.padV;
  const extra = (lh > 0 && avail > lh) ? (avail % lh) : 0;
  root.style.setProperty('--pad-extra', (extra / 2) + 'px');
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
