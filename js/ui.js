// ============================================================
// UI wiring: drawers, settings modal, tab switching, all input
// bindings, theme presets (save/delete current bg+fg).
//
// Fix #5: every range input calls updateSliderFill on init AND on input
// so the Apple-style track gradient (filled left / faded right) reflects
// the value at all times.
// Fix #6: Color tab supports saving the current bg+fg as a named preset,
// rendered alongside built-in themes; presets persist via settings.customThemes.
// ============================================================

import {
  $, settings, runtime, persistSettings,
  MODELS,
} from './state.js';
import {
  applyChromeTheme, applyAll, updateSliderFill,
  applyCustomCssToParent, applyCustomCssToBook,
} from './theme.js';
import { closeBook, createRendition } from './reader.js';

const overlay = $('overlay');
const tocDrawer = $('toc-drawer');
const settingsModal = $('settings-modal');
const modelSelect = $('model-select');
const colorOptions = $('color-options');
const viewer = $('viewer');

// ============================================================
// Drawers / modal show + hide
// ============================================================
export function showDrawer(drawer) {
  document.querySelectorAll('.drawer').forEach(d => d.classList.remove('visible'));
  settingsModal.classList.remove('visible');
  drawer.classList.add('visible');
  overlay.classList.add('visible');
}
export function showSettingsModal() {
  document.querySelectorAll('.drawer').forEach(d => d.classList.remove('visible'));
  settingsModal.classList.add('visible');
  overlay.classList.add('visible');
}
export function hideAllDrawers() {
  document.querySelectorAll('.drawer').forEach(d => d.classList.remove('visible'));
  settingsModal.classList.remove('visible');
  overlay.classList.remove('visible');
}

// ============================================================
// Theme swatch rendering — built-ins + saved presets in one grid
// ============================================================
function renderThemeSwatches() {
  // Remove existing saved-preset buttons (keep built-ins)
  colorOptions.querySelectorAll('.theme-swatch.saved').forEach(b => b.remove());

  settings.customThemes.forEach((t, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-swatch saved';
    btn.dataset.bg = t.bg;
    btn.dataset.fg = t.fg;
    btn.style.background = t.bg;
    btn.style.color = t.fg;
    btn.title = t.name;
    btn.textContent = 'Aa';

    const del = document.createElement('span');
    del.className = 'delete-preset';
    del.textContent = '×';
    del.title = `Delete "${t.name}"`;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      settings.customThemes.splice(idx, 1);
      persistSettings();
      renderThemeSwatches();
    });
    btn.appendChild(del);

    btn.addEventListener('click', () => {
      settings.bg = t.bg;
      settings.fg = t.fg;
      applyAll();
    });
    colorOptions.appendChild(btn);
  });

  // Update active class for ALL swatches
  colorOptions.querySelectorAll('.theme-swatch').forEach(b => {
    const matches = b.dataset.bg.toLowerCase() === settings.bg.toLowerCase()
                 && b.dataset.fg.toLowerCase() === settings.fg.toLowerCase();
    b.classList.toggle('active', matches);
  });
}

// ============================================================
// Slider bindings — every helper calls updateSliderFill on init + input
// ============================================================
function bindSlider(id, key, suffix) {
  const input = $(id);
  const valueEl = $(id + '-value');
  input.value = settings[key];
  valueEl.textContent = settings[key] + suffix;
  updateSliderFill(input);
  input.addEventListener('input', () => {
    settings[key] = parseFloat(input.value);
    valueEl.textContent = settings[key] + suffix;
    updateSliderFill(input);
    applyAll();
  });
}

function bindLineHeight() {
  const input = $('line-height');
  const valueEl = $('line-height-value');
  input.value = settings.lineHeight;
  valueEl.textContent = settings.lineHeight.toFixed(2);
  updateSliderFill(input);
  input.addEventListener('input', () => {
    settings.lineHeight = parseFloat(input.value);
    valueEl.textContent = settings.lineHeight.toFixed(2);
    updateSliderFill(input);
    applyAll();
  });
}

function bindPaddingSlider(id, key) {
  const input = $(id);
  const valueEl = $(id + '-value');
  input.value = settings[key];
  valueEl.textContent = settings[key] + 'px';
  updateSliderFill(input);
  let padResizeTimer;
  input.addEventListener('input', () => {
    settings[key] = parseInt(input.value);
    valueEl.textContent = settings[key] + 'px';
    updateSliderFill(input);
    applyChromeTheme();
    persistSettings();
    clearTimeout(padResizeTimer);
    padResizeTimer = setTimeout(() => {
      if (runtime.rendition) { try { runtime.rendition.resize(); } catch {} }
    }, 100);
  });
}

function bindContextLength() {
  const input = $('context-length');
  const valueEl = $('context-length-value');
  const fmt = n => n + ' sentence' + (n === 1 ? '' : 's');
  input.value = settings.contextSentences;
  valueEl.textContent = fmt(settings.contextSentences);
  updateSliderFill(input);
  input.addEventListener('input', () => {
    settings.contextSentences = parseInt(input.value);
    valueEl.textContent = fmt(settings.contextSentences);
    updateSliderFill(input);
    persistSettings();
  });
}

// ============================================================
// Color picker pair (color input + hex text)
// ============================================================
function bindColorPair(colorId, hexId, key) {
  const c = $(colorId);
  const h = $(hexId);
  c.value = settings[key];
  h.value = settings[key].toUpperCase();
  c.addEventListener('input', () => {
    settings[key] = c.value;
    applyAll();
  });
  h.addEventListener('change', () => {
    const v = h.value.trim();
    const norm = /^#?[0-9a-fA-F]{6}$/.test(v) ? (v.startsWith('#') ? v : '#' + v) : null;
    if (norm) {
      settings[key] = norm.toLowerCase();
      applyAll();
    } else {
      h.value = settings[key].toUpperCase();
    }
  });
}

// ============================================================
// Model select + popup label sync
// ============================================================
function populateModelSelect() {
  modelSelect.innerHTML = '';
  MODELS.forEach((m, idx) => {
    const o = document.createElement('option');
    o.value = idx;
    o.textContent = m.name;
    if (idx === settings.selectedModelIdx) o.selected = true;
    modelSelect.appendChild(o);
  });
}

// ============================================================
// API key input bindings
// ============================================================
function bindKeyInput(id, ref) {
  const input = $(id);
  input.value = settings.apiKeys[ref] || '';
  input.addEventListener('change', () => {
    settings.apiKeys[ref] = input.value.trim();
    persistSettings();
  });
}

// ============================================================
// Custom CSS textarea
// ============================================================
function bindCustomCss() {
  const ta = $('custom-css');
  if (!ta) return;
  ta.value = settings.customCss || '';
  let cssTimer;
  ta.addEventListener('input', () => {
    settings.customCss = ta.value;
    applyCustomCssToParent();
    clearTimeout(cssTimer);
    cssTimer = setTimeout(() => {
      applyCustomCssToBook();
      persistSettings();
    }, 250);
  });
}

// ============================================================
// Init — call once at boot
// ============================================================
export function initUI() {
  // ---- Drawers / modal ----
  overlay.addEventListener('click', hideAllDrawers);
  document.querySelectorAll('.drawer-close').forEach(btn => {
    btn.addEventListener('click', hideAllDrawers);
  });
  const settingsCloseBtn = $('settings-close');
  if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', hideAllDrawers);

  // Custom event from reader.js (Esc key) closes drawers
  document.addEventListener('reader:hideAllDrawers', hideAllDrawers);

  // ---- Tab switching ----
  document.querySelectorAll('#settings-tabs button.tab').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      const target = tabBtn.dataset.tab;
      document.querySelectorAll('#settings-tabs button.tab').forEach(b =>
        b.classList.toggle('active', b === tabBtn));
      document.querySelectorAll('#settings-modal .tab-panel').forEach(p =>
        p.classList.toggle('active', p.dataset.panel === target));
    });
  });

  // ---- Top-level chrome buttons ----
  $('btn-toc').addEventListener('click', () => showDrawer(tocDrawer));
  $('btn-settings').addEventListener('click', showSettingsModal);
  $('btn-library').addEventListener('click', async () => {
    hideAllDrawers();
    await closeBook();
  });

  // ---- Layout mode toggle ----
  document.querySelectorAll('#mode-toggle button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === settings.layout);
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === settings.layout) return;
      settings.layout = mode;
      document.querySelectorAll('#mode-toggle button').forEach(b =>
        b.classList.toggle('active', b.dataset.mode === mode));
      persistSettings();
      if (runtime.book && runtime.rendition) {
        const cfi = runtime.rendition.currentLocation()?.start?.cfi;
        try { runtime.rendition.destroy(); } catch {}
        viewer.innerHTML = '';
        createRendition();
        runtime.rendition.display(cfi || undefined);
      }
    });
  });

  // ---- Built-in theme swatches (also wires saved ones via renderThemeSwatches) ----
  colorOptions.querySelectorAll('.theme-swatch:not(.saved)').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.bg = btn.dataset.bg;
      settings.fg = btn.dataset.fg;
      applyAll();
    });
  });
  renderThemeSwatches();

  // ---- Save current as preset ----
  $('save-theme-preset').addEventListener('click', () => {
    settings.customThemes.push({
      name: '',
      bg: settings.bg,
      fg: settings.fg,
    });
    persistSettings();
    renderThemeSwatches();
  });

  // ---- Font select ----
  const fontSelect = $('font-family');
  fontSelect.value = settings.fontFamily;
  fontSelect.addEventListener('change', () => {
    settings.fontFamily = fontSelect.value;
    applyAll();
  });

  // ---- Sliders (font + spacing) ----
  bindSlider('font-size', 'fontSize', 'px');
  bindSlider('letter-spacing', 'letterSpacing', 'px');
  bindSlider('word-spacing', 'wordSpacing', 'px');
  bindLineHeight();

  // ---- Padding sliders ----
  bindPaddingSlider('pad-top',    'padTop');
  bindPaddingSlider('pad-bottom', 'padBottom');
  bindPaddingSlider('pad-left',   'padLeft');
  bindPaddingSlider('pad-right',  'padRight');

  // ---- Color pair inputs ----
  bindColorPair('bg-color', 'bg-color-hex', 'bg');
  bindColorPair('fg-color', 'fg-color-hex', 'fg');

  // ---- Translation tab ----
  bindContextLength();
  populateModelSelect();
  modelSelect.addEventListener('change', () => {
    settings.selectedModelIdx = parseInt(modelSelect.value);
    persistSettings();
  });
  bindKeyInput('key-gemini', 'GEMINI_API_KEY');
  bindKeyInput('key-groq', 'GROQ_API_KEY');

  // ---- Custom CSS ----
  bindCustomCss();

  // After applyChromeTheme runs its theme-swatch active toggle, ensure saved
  // presets are also marked correctly by re-running our renderer once more.
  renderThemeSwatches();
}