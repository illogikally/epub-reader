// ============================================================
// On-screen debug log.
//
// iOS Safari has no console you can reach from a phone, so a silent failure
// in the touch-selection gesture costs a full round-trip to diagnose. Turn
// this on by appending ?debug=1 (or #debug) to the URL; it is inert and
// costs nothing otherwise.
// ============================================================

const ENABLED = (() => {
  try {
    return new URLSearchParams(location.search).get('debug') === '1'
        || location.hash === '#debug';
  } catch { return false; }
})();

const MAX_LINES = 12;
const lines = [];
let panel = null;

export function isDebug() { return ENABLED; }

export function dbg(...parts) {
  if (!ENABLED) return;
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
