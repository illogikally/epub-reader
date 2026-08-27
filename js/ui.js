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
  GROQ_KEY_REF, REASONING_MODES, DEFAULT_REASONING,
  allModels, addModel, removeModel,
} from './state.js?v=29';
import {
  applyChromeTheme, applyAll, updateSliderFill, applyBookStyle,
} from './theme.js?v=29';
import { closeBook, createRendition, hideChrome } from './reader.js?v=29';
import { scrollTocToCurrent } from './translate.js?v=29';
import { syncDebugPanel } from './debug.js?v=29';

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
const TRASH_SVG = '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/>'
                + '<path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>';

// Makes a .set-select row expand and collapse. Used both by the option lists
// below and by rows that reveal something else entirely (the add-model form) —
// which is why it is not buried inside bindSelectRow.
function bindDisclosure(root) {
  const disclosure = root.querySelector('.set-disclosure');
  const close = () => {
    root.classList.remove('open');
    disclosure.setAttribute('aria-expanded', 'false');
  };
  disclosure.addEventListener('click', () => {
    const willOpen = !root.classList.contains('open');
    // Accordion: one panel open at a time — but a nested panel must not
    // collapse the panel it lives in, so ancestors of `root` are left alone.
    document.querySelectorAll('#settings-body .set-select.open').forEach(s => {
      if (s === root || s.contains(root)) return;
      s.classList.remove('open');
      s.querySelector('.set-disclosure').setAttribute('aria-expanded', 'false');
    });
    root.classList.toggle('open', willOpen);
    disclosure.setAttribute('aria-expanded', String(willOpen));
    // Collapsing a panel collapses anything nested inside it, so reopening it
    // doesn't reveal a sub-panel the user left open a while ago.
    if (!willOpen) {
      root.querySelectorAll('.set-select.open').forEach(s => {
        s.classList.remove('open');
        s.querySelector('.set-disclosure').setAttribute('aria-expanded', 'false');
      });
    }
  });
  return close;
}

// `remove(value)`, when given, puts a trash button on every option flagged
// `removable`. The option row is a wrapper rather than one element because the
// label and the trash are both real <button>s — nesting them would be invalid
// markup and would cost keyboard activation.
function bindSelectRow(id, { options, get, set, remove, emptyLabel }) {
  const root = $(id);
  if (!root) return () => {};
  const valueEl = root.querySelector('.set-value');
  const list = root.querySelector('.set-options');
  const optionsOf = () => (typeof options === 'function' ? options() : options);
  // No disclosure row means the list is always shown (see .set-options-inline).
  const close = root.querySelector('.set-disclosure') ? bindDisclosure(root) : () => {};

  const refresh = () => {
    const opts = optionsOf();
    const cur = String(get());
    list.innerHTML = '';
    opts.forEach(o => {
      const row = document.createElement('div');
      row.className = 'set-option-row';

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
      row.appendChild(el);

      if (remove && o.removable) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'set-option-del';
        del.title = `Remove ${o.label}`;
        del.setAttribute('aria-label', del.title);
        del.innerHTML = TRASH_SVG;
        del.addEventListener('click', (e) => {
          e.stopPropagation();   // removing is not also selecting
          if (remove(o.value) !== false) refresh();
        });
        row.appendChild(del);
      }

      list.appendChild(row);
    });
    if (!opts.length && emptyLabel) {
      const empty = document.createElement('div');
      empty.className = 'set-option-empty';
      empty.textContent = emptyLabel;
      list.appendChild(empty);
    }
    if (valueEl) {
      const hit = opts.find(o => o.value === cur);
      // `short` lets a long option label collapse to something that fits the row.
      valueEl.textContent = hit ? (hit.short || hit.label) : (opts.length ? '' : (emptyLabel || ''));
    }
  };

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
  const modelInput = $('nm-model');
  const errEl = $('nm-error');

  keyInput.value = settings.apiKeys[GROQ_KEY_REF] || '';
  keyInput.addEventListener('change', () => {
    settings.apiKeys[GROQ_KEY_REF] = keyInput.value.trim();
    persistSettings();
  });

  const refreshModelRow = bindSelectRow('model-card', {
    // Every model is removable, so the list can legitimately end up empty.
    emptyLabel: 'No models — add one below.',
    options: () => allModels().map(m => ({
      value: m.id,
      label: m.model,
      removable: true,
    })),
    get: () => settings.selectedModelId,
    set: id => {
      settings.selectedModelId = id;
      persistSettings();
    },
    remove: id => {
      const model = allModels().find(m => m.id === id);
      if (!model || !confirm(`Remove "${model.model}"?`)) return false;
      removeModel(id);   // bindSelectRow re-renders once this returns
    },
  });

  // ---- Add-model form ----
  const closeAddForm = bindDisclosure($('add-model'));
  let reasoning = DEFAULT_REASONING;
  const syncReasoning = bindSelectRow('nm-reasoning', {
    options: REASONING_MODES.map(m => ({
      value: m.value, label: `${m.label} — ${m.hint}`, short: m.label,
    })),
    get: () => reasoning,
    set: v => { reasoning = v; },
  });

  const submit = () => {
    const id = modelInput.value.trim();
    if (!id) {
      errEl.textContent = 'Enter a model ID, the name Groq knows it by.';
      errEl.hidden = false;
      return;
    }
    const added = addModel(id, reasoning);
    if (!added) {
      errEl.textContent = `"${id}" is already in the list.`;
      errEl.hidden = false;
      return;
    }
    errEl.hidden = true;
    settings.selectedModelId = added.id;   // adding it means you want to use it
    persistSettings();
    modelInput.value = '';
    reasoning = DEFAULT_REASONING;
    syncReasoning();
    closeAddForm();
    refreshModelRow();
  };
  $('nm-add').addEventListener('click', submit);
  modelInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
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
