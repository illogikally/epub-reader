// ============================================================
// On-screen debug log.
//
// iOS Safari has no console you can reach from a phone, so a silent failure
// in the touch-selection gesture costs a full round-trip to diagnose.
//
// Two ways to switch it on:
//   * Settings → CSS tab → Debug log        (works in the standalone PWA)
//   * ?debug=1 / #debug in the URL          (works in Safari)
//
// The manifest's start_url is "." with display:standalone, so launching from
// the home-screen icon drops any query string — hence the settings toggle.
// The flag is read per call, not frozen at load, so the toggle takes effect
// immediately without a reload.
// ============================================================

import { settings } from './state.js';

const URL_FLAG = (() => {
  try {
    return new URLSearchParams(location.search).get('debug') === '1'
        || location.hash === '#debug';
  } catch { return false; }
})();

// 24, not 12: repeated 'attached to chapter' lines nearly buried the one line
// that mattered last round.
const MAX_LINES = 24;
const lines = [];        // { text, count }
let panel = null;

export function isDebug() { return URL_FLAG || !!settings.debug; }

function hidePanel() {
  if (panel && panel.isConnected) panel.remove();
  panel = null;
  lines.length = 0;
}

export function dbg(...parts) {
  if (!isDebug()) { if (panel) hidePanel(); return; }
  const msg = parts
    .map(p => typeof p === 'string' ? p : (() => { try { return JSON.stringify(p); } catch { return String(p); } })())
    .join(' ');
  // Collapse consecutive duplicates to "… xN" so a chatty line can never push
  // the interesting one off the top.
  const last = lines[lines.length - 1];
  if (last && last.raw === msg) last.count++;
  else lines.push({ text: new Date().toISOString().slice(14, 23) + ' ' + msg, raw: msg, count: 1 });
  while (lines.length > MAX_LINES) lines.shift();
  if (!panel || !panel.isConnected) {
    panel = document.createElement('div');
    panel.id = 'debug-panel';
    document.body.appendChild(panel);
  }
  panel.textContent = lines
    .map(l => l.count > 1 ? l.text + '  x' + l.count : l.text)
    .join('\n');
}

// Called when the setting is switched off so the panel goes away immediately
// rather than lingering until the next dbg() call.
export function syncDebugPanel() {
  if (!isDebug()) hidePanel();
  else dbg('debug log on');
}

// Surface thrown errors on the phone. Without this a failure anywhere in the
// app is completely invisible on iOS — which is how several rounds were lost.
window.addEventListener('error', (e) => {
  dbg('ERROR:', (e.message || 'unknown') + ' @' + (e.filename || '?').split('/').pop() + ':' + (e.lineno || '?'));
});
window.addEventListener('unhandledrejection', (e) => {
  dbg('REJECT:', String(e.reason && e.reason.message || e.reason));
});
