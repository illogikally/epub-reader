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

const MAX_LINES = 12;
const lines = [];
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
  lines.push(new Date().toISOString().slice(14, 23) + ' ' + msg);
  while (lines.length > MAX_LINES) lines.shift();
  if (!panel || !panel.isConnected) {
    panel = document.createElement('div');
    panel.id = 'debug-panel';
    document.body.appendChild(panel);
  }
  panel.textContent = lines.join('\n');
}

// Called when the setting is switched off so the panel goes away immediately
// rather than lingering until the next dbg() call.
export function syncDebugPanel() {
  if (!isDebug()) hidePanel();
  else dbg('debug log on');
}
