// ============================================================
// UI wiring: drawers, the settings sheet and every input inside it.
//
// The sheet is one scrolling page of grouped rows (see index.html and the
// "Grouped rows" block in reader.css). Three row shapes are wired here:
//   .set-select  — disclosure row that expands into an inline option list
//   .set-slider  — range input; updateSliderFill keeps the track gradient honest
//   .set-switch  — iOS-style on/off switch
// ============================================================

import {
  $, settings, runtime, persistSettings, attachPullToDismiss,
  MODEL_FORMATS, allModels, currentModel, addCustomModel, removeCustomModel,
} from './state.js?v=24';
import {
  applyChromeTheme, applyAll, updateSliderFill, applyBookStyle,
} from './theme.js?v=24';
import { closeBook, createRendition, hideChrome } from './reader.js?v=24';
import { scrollTocToCurrent } from './translate.js?v=24';
import { syncDebugPanel } from './debug.js?v=24';

const overlay = $('overlay');
const tocDrawer = $('toc-drawer');
const settingsModal = $('settings-modal');
const colorOptions = $('color-options');
const viewer = $('viewer');

// ============================================================
// Drawers / sheet show + hide
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
// Disclosure select — a row showing the current value that expands into an
// inline list of options. `options` is [{ value, label, style? }] or a function
// returning one (for lists the user can edit); `get` returns the current value,
// `set` applies a picked one. Values are compared as strings, so callers hand
// back strings and parse if they need a number. Only one list stays open at a
// time. Returns a refresh() that re-reads the options and the selection.
// ============================================================
const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>';

function bindSelectRow(id, { options, get, set }) {
  const root = $(id);
  if (!root) return () => {};
  const disclosure = root.querySelector('.set-disclosure');
  const valueEl = root.querySelector('.set-value');
  const list = root.querySelector('.set-options');
  const optionsOf = () => (typeof options === 'function' ? options() : options);

  const close = () => {
    root.classList.remove('open');
    disclosure.setAttribute('aria-expanded', 'false');
  };

  const refresh = () => {
    const opts = optionsOf();
    const cur = String(get());
    list.innerHTML = '';
    opts.forEach(o => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'set-option';
      el.dataset.value = o.value;
      el.innerHTML = `<span></span>${CHECK_SVG}`;
      el.firstChild.textContent = o.label;
      if (o.style) el.firstChild.style.cssText = o.style;
      el.classList.toggle('selected', o.value === cur);
      el.addEventListener('click', () => {
        set(o.value);
        refresh();
        close();
      });
      list.appendChild(el);
    });
    if (valueEl) {
      const hit = opts.find(o => o.value === cur);
      valueEl.textContent = hit ? hit.label : '';
    }
  };

  disclosure.addEventListener('click', () => {
    const willOpen = !root.classList.contains('open');
    document.querySelectorAll('#settings-body .set-select.open').forEach(s => {
      s.classList.remove('open');
      s.querySelector('.set-disclosure').setAttribute('aria-expanded', 'false');
    });
    root.classList.toggle('open', willOpen);
    disclosure.setAttribute('aria-expanded', String(willOpen));
  });

  refresh();
  return refresh;
}

// Option list for the font row — each entry previews its own face.
const FONTS = [
  ["'Seravek', ui-sans-serif, system-ui, sans-serif", 'Seravek'],
  ["Georgia, 'Iowan Old Style', serif", 'Georgia'],
  ["'Iowan Old Style', Palatino, 'Palatino Linotype', serif", 'Iowan / Palatino'],
  ["ui-serif, 'Charter', 'Bitstream Charter', serif", 'Charter'],
  ["'Times New Roman', Times, serif", 'Times'],
  ['ui-sans-serif, system-ui, -apple-system, sans-serif', 'System sans'],
  ["'Helvetica Neue', Helvetica, Arial, sans-serif", 'Helvetica'],
  ["ui-monospace, 'SF Mono', Menlo, monospace", 'Mono'],
].map(([value, label]) => ({ value, label, style: `font-family:${value}` }));

// ============================================================
// Slider bindings — every helper calls updateSliderFill on init + on input
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

// ============================================================
// Color picker pair (round chip + hex text). applyAll -> applyChromeTheme
// re-marks the matching theme swatch, so nothing extra is needed here.
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
// Translation models — pick one, key it, add and remove your own
// ============================================================
function initModelSettings() {
  const keyInput = $('key-model');
  const keyNote = $('key-note');
  const removeCard = $('del-model');

  // Keys are filed per endpoint host, so the row shows whichever key the
  // selected model will actually send.
  const refreshKeyRow = () => {
    const ref = currentModel()?.keyRef || '';
    keyInput.value = settings.apiKeys[ref] || '';
    keyInput.placeholder = ref ? 'key for ' + ref : 'paste key';
    keyNote.textContent = ref
      ? `Saved in this browser under "${ref}" and shared by every model on that host. `
        + 'Requests stream straight from the page to the endpoint — no backend.'
      : '';
  };
  keyInput.addEventListener('change', () => {
    const ref = currentModel()?.keyRef;
    if (!ref) return;
    settings.apiKeys[ref] = keyInput.value.trim();
    persistSettings();
  });

  const refreshModelRow = bindSelectRow('sel-model', {
    options: () => allModels().map(m => ({
      value: m.id,
      label: m.custom ? `${m.name} · custom` : m.name,
    })),
    get: () => settings.selectedModelId,
    set: id => {
      settings.selectedModelId = id;
      persistSettings();
      refreshKeyRow();
    },
  });

  const refreshRemoveRow = bindSelectRow('del-model', {
    // Built-ins are not listed: something has to remain selectable.
    options: () => settings.customModels.map(m => ({ value: m.id, label: m.name })),
    get: () => '',
    set: id => {
      const model = settings.customModels.find(m => m.id === id);
      if (!model || !confirm(`Remove "${model.name}"?`)) return;
      removeCustomModel(id);
      refreshAll();
    },
  });

  const refreshAll = () => {
    refreshModelRow();
    refreshRemoveRow();
    refreshKeyRow();
    removeCard.hidden = settings.customModels.length === 0;
    if (removeCard.hidden) removeCard.classList.remove('open');
  };

  // ---- Add-model form ----
  const seg = $('nm-format');
  let format = MODEL_FORMATS[0];
  const urlInput = $('nm-url');
  // Each protocol wants a different shape of endpoint, so the hint follows it.
  const URL_HINTS = {
    openai: 'https://…/v1/chat/completions',
    google: 'https://generativelanguage.googleapis.com/v1beta',
  };
  const syncFormat = () => {
    seg.querySelectorAll('button').forEach(b =>
      b.classList.toggle('active', b.dataset.format === format));
    urlInput.placeholder = URL_HINTS[format] || 'https://…';
  };
  MODEL_FORMATS.forEach(f => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.format = f;
    b.textContent = f;
    b.addEventListener('click', () => { format = f; syncFormat(); });
    seg.appendChild(b);
  });
  syncFormat();

  const errEl = $('nm-error');
  $('nm-add').addEventListener('click', () => {
    const name = $('nm-name').value.trim();
    const url = urlInput.value.trim();
    const model = $('nm-model').value.trim();
    const fail = msg => { errEl.textContent = msg; errEl.hidden = false; };

    if (!name) return fail('Give the model a name.');
    if (!model) return fail('Model ID is required — the name the provider knows it by.');
    let host = '';
    try { host = new URL(url).host; } catch {}
    if (!host) return fail('Endpoint must be a full URL, starting with https://');
    errEl.hidden = true;

    const added = addCustomModel({ name, url, model, format });
    settings.selectedModelId = added.id;   // adding it means you want to use it
    persistSettings();
    ['nm-name', 'nm-url', 'nm-model'].forEach(id => { $(id).value = ''; });
    $('add-model').classList.remove('open');
    $('add-model').querySelector('.set-disclosure').setAttribute('aria-expanded', 'false');
    refreshAll();
  });

  refreshAll();
}

// ============================================================
// Switch row
// ============================================================
function bindSwitch(id, get, set) {
  const btn = $(id);
  const sync = () => btn.setAttribute('aria-checked', String(!!get()));
  sync();
  btn.addEventListener('click', () => {
    set(!get());
    sync();
  });
}

// ============================================================
// Init — call once at boot
// ============================================================
export function initUI() {
  // ---- Drawers / sheet ----
  overlay.addEventListener('click', hideAllDrawers);
  document.querySelectorAll('.drawer-close').forEach(btn => {
    btn.addEventListener('click', hideAllDrawers);
  });
  $('settings-close').addEventListener('click', hideAllDrawers);

  // Pull-down-to-dismiss for mobile bottom sheets
  // The header of each sheet is a drag handle: swiping it down closes the sheet
  // even when its list is scrolled somewhere in the middle.
  attachPullToDismiss(tocDrawer, () => $('toc-list'), hideAllDrawers, { grab: '#toc-header' });
  attachPullToDismiss(settingsModal, () => $('settings-body'), hideAllDrawers, { grab: '#settings-head' });

  // Custom event from reader.js (Esc key) closes drawers
  document.addEventListener('reader:hideAllDrawers', hideAllDrawers);

  // ---- Top-level chrome buttons ----
  // Each row opens its sheet and takes the floating chrome down with it —
  // otherwise its dimmer stacks under the sheet's own overlay.
  $('btn-toc').addEventListener('click', () => {
    hideChrome();
    showDrawer(tocDrawer);
    requestAnimationFrame(scrollTocToCurrent);
  });
  $('btn-settings').addEventListener('click', () => {
    hideChrome();
    showSettingsModal();
  });
  $('btn-library').addEventListener('click', async () => {
    hideChrome();
    hideAllDrawers();
    await closeBook();
  });

  // ---- Text: font + alignment ----
  bindSelectRow('sel-font', {
    options: FONTS,
    get: () => settings.fontFamily,
    set: v => { settings.fontFamily = v; applyAll(); },
  });

  bindSelectRow('sel-align', {
    options: [
      { value: 'default', label: 'Default' },
      { value: 'left',    label: 'Left' },
      { value: 'justify', label: 'Justified' },
    ],
    get: () => settings.textAlign,
    set: v => {
      settings.textAlign = v;
      persistSettings();
      applyBookStyle();
    },
  });

  // ---- Text: sliders ----
  bindSlider('font-size', 'fontSize', 'px');
  bindLineHeight();
  bindSlider('letter-spacing', 'letterSpacing', 'px');
  bindSlider('word-spacing', 'wordSpacing', 'px');

  // ---- Layout: page mode (hidden on phones — they are always single page) ----
  bindSelectRow('sel-layout', {
    options: [
      { value: 'single', label: 'Single page' },
      { value: 'dual',   label: 'Two pages' },
    ],
    get: () => settings.layout,
    set: mode => {
      if (mode === settings.layout) return;
      settings.layout = mode;
      persistSettings();
      if (runtime.book && runtime.rendition) {
        const cfi = runtime.rendition.currentLocation()?.start?.cfi;
        try { runtime.rendition.destroy(); } catch {}
        viewer.innerHTML = '';
        createRendition();
        runtime.rendition.display(cfi || undefined);
      }
    },
  });

  // ---- Layout: margins ----
  bindPaddingSlider('pad-top',    'padTop');
  bindPaddingSlider('pad-bottom', 'padBottom');
  bindPaddingSlider('pad-left',   'padLeft');
  bindPaddingSlider('pad-right',  'padRight');

  // ---- Theme ----
  colorOptions.querySelectorAll('.theme-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.bg = btn.dataset.bg;
      settings.fg = btn.dataset.fg;
      applyAll();
    });
  });
  bindColorPair('bg-color', 'bg-color-hex', 'bg');
  bindColorPair('fg-color', 'fg-color-hex', 'fg');

  // ---- Translation ----
  initModelSettings();

  // ---- Advanced ----
  bindSwitch('toggle-debug', () => settings.debug, on => {
    settings.debug = on;
    persistSettings();
    syncDebugPanel();
  });
}
