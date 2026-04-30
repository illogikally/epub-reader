// ============================================================
// Theme application: CSS variables on :root, book-content theming
// via epub.js themes API, custom-CSS injection, color input sync,
// and the slider fill helper used by every range input.
// ============================================================

import { settings, runtime, blendHex, relLuminance, persistSettings, $ } from './state.js';

export function applyChromeTheme() {
  settings.dark = relLuminance(settings.bg) < 0.5;
  const chromeFg = blendHex(settings.fg, settings.bg, 0.45);
  const root = document.documentElement;
  root.style.setProperty('--bg', settings.bg);
  root.style.setProperty('--fg', settings.fg);
  root.style.setProperty('--chrome-fg', chromeFg);
  root.style.setProperty('--chrome-hover', settings.fg);
  root.style.setProperty('--pad-top', settings.padTop + 'px');
  root.style.setProperty('--pad-bottom', settings.padBottom + 'px');
  root.style.setProperty('--pad-left', settings.padLeft + 'px');
  root.style.setProperty('--pad-right', settings.padRight + 'px');
  document.body.classList.toggle('dark-chrome', !!settings.dark);
  // Mark active theme swatch (works for both built-ins and saved presets)
  document.querySelectorAll('#color-options .theme-swatch').forEach(b => {
    const matches = b.dataset.bg.toLowerCase() === settings.bg.toLowerCase()
                 && b.dataset.fg.toLowerCase() === settings.fg.toLowerCase();
    b.classList.toggle('active', matches);
  });
  syncColorInputs();
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
  r.themes.override('-webkit-touch-callout', 'none', true);
  r.themes.override('-webkit-user-select', 'text', true);
  r.themes.override('user-select', 'text', true);
  applyCustomCssToBook();
}

export function applyCustomCssToParent() {
  const el = document.getElementById('user-custom-css');
  if (el) el.textContent = settings.customCss || '';
}
export function applyCustomCssToBook() {
  const r = runtime.rendition;
  if (!r) return;
  try {
    r.themes.registerCss('user-custom', settings.customCss || '');
    r.themes.select('user-custom');
  } catch {}
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
