// ============================================================
// Two-way sync between the library and a Dropbox folder.
//
// Everything lives in the Dropbox app folder itself — Apps/<app name>/:
//
//   Apps/<app name>/*.epub
//   Apps/<app name>/.reader-sync.json
//
// The app has App-folder access, so the API roots every path there and spells
// that folder '' (see js/dropbox.js). There is nothing to configure: the app
// folder is created when you authorise and cannot be pointed elsewhere, so a
// folder setting could only ever name a subfolder of it — one more thing to
// get wrong for no gain.
//
// The manifest is what makes the sync more than a file copy. A folder listing
// can say what exists; only the manifest can say what used to exist and was
// deliberately deleted, or where in a book you had got to, or which device
// changed a setting last. Deletions in particular need it: without a tombstone
// a deleted book is indistinguishable from a book this device has not
// downloaded yet, and it would come straight back on the next pass.
//
// Book ids are makeBookId(name, size), the same id a local import produces, so
// an EPUB dropped into the folder by hand lands on the same id everywhere.
// Covers are not stored remotely — they are re-extracted on download, which
// keeps the manifest small and means one code path produces every cover.
// ============================================================

import {
  $, settings, runtime, persistSettingsQuiet,
  exportSettings, importSettings,
  dbGet, dbDelete, dbAllIds, makeBookId,
  getProgress, setProgress, clearProgress,
  allTombstones, clearTombstone,
} from './state.js?v=34';
import * as dbx from './dropbox.js?v=34';
import { addBookFromBuffer, renderLibrary } from './library.js?v=34';
import { applyAll } from './theme.js?v=34';
import { createRendition } from './reader.js?v=34';
import { refreshSettingsUI, showSettingsModal, bindDisclosure } from './ui.js?v=34';
import { dbg } from './debug.js?v=34';

const MANIFEST_NAME = '.reader-sync.json';
// Past this, Dropbox wants a chunked upload session. An EPUB that big is a
// scanned-page monster; skip it with a message rather than carry the machinery.
const MAX_UPLOAD = 150 * 1024 * 1024;
// Tombstones are kept long enough for every device to have seen them, then
// dropped so the manifest doesn't grow forever.
const TOMBSTONE_TTL = 90 * 24 * 60 * 60 * 1000;

// ============================================================
// Status — one small observable the button and the settings row both read
// ============================================================
const listeners = new Set();
let status = { state: 'idle', message: '' };   // idle | syncing | ok | error

export function getStatus() { return status; }
export function onStatus(fn) {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}
function setStatus(state, message = '') {
  status = { state, message };
  listeners.forEach(fn => { try { fn(status); } catch {} });
}

// ============================================================
// Paths
// ============================================================
// SYNC_ROOT is the app folder. Dropbox spells it '' — it will not accept '/'.
const SYNC_ROOT = '';
const childPath = name => `/${name}`;

export function isReady() {
  return dbx.isConfigured() && dbx.isConnected();
}

// ============================================================
// Manifest
// ============================================================
function emptyManifest() {
  return { version: 1, books: {}, deleted: {}, progress: {}, settings: { at: 0, values: {} } };
}

// Returns { manifest, rev }. rev is null when the file does not exist yet, and
// is what the write-back uses to refuse to clobber a newer manifest.
async function readManifest() {
  try {
    const { buffer, meta } = await dbx.download(childPath(MANIFEST_NAME));
    const text = new TextDecoder().decode(buffer);
    const parsed = JSON.parse(text);
    const m = emptyManifest();
    for (const k of ['books', 'deleted', 'progress']) {
      if (parsed[k] && typeof parsed[k] === 'object') m[k] = parsed[k];
    }
    if (parsed.settings && typeof parsed.settings === 'object') {
      m.settings = { at: Number(parsed.settings.at) || 0, values: parsed.settings.values || {} };
    }
    return { manifest: m, rev: meta?.rev || null };
  } catch (err) {
    if (err instanceof dbx.DropboxError && err.isTag('path', 'not_found')) {
      return { manifest: emptyManifest(), rev: null };   // first sync into this folder
    }
    // Corrupt JSON should not wedge sync forever, but it must not silently
    // erase the tombstones and positions it could not read either — that is a
    // conflict for the retry pass to notice, not something to paper over.
    if (err instanceof SyntaxError) throw new Error('The Dropbox manifest is not readable JSON.');
    throw err;
  }
}

function writeManifest(manifest, rev) {
  const body = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const mode = rev ? { '.tag': 'update', update: rev } : 'add';
  return dbx.upload(childPath(MANIFEST_NAME), body, mode, false);
}

function isConflict(err) {
  return err instanceof dbx.DropboxError && err.isTag('conflict');
}

// ============================================================
// The pass
// ============================================================
let inFlight = null;
let rerun = false;

// Never two passes at once: a second request while one is running just marks
// the running pass to go round again when it lands.
export function syncNow() {
  if (inFlight) { rerun = true; return inFlight; }
  inFlight = (async () => {
    try {
      await runPass();
      if (rerun) { rerun = false; await runPass(); }
    } finally {
      inFlight = null;
      rerun = false;
    }
  })();
  return inFlight;
}

// Background triggers (a book added, a book closed) coalesce: several in a row
// cost one pass, a couple of seconds after the last of them.
let pending = null;
export function requestSync(delay = 2500) {
  if (!isReady()) return;
  clearTimeout(pending);
  pending = setTimeout(() => { pending = null; syncNow(); }, delay);
}

async function runPass() {
  if (!dbx.isConfigured()) { setStatus('error', 'No Dropbox app key is set.'); return; }
  if (!dbx.isConnected()) { setStatus('idle', 'Not connected'); return; }
  setStatus('syncing', 'Syncing…');
  try {
    const summary = await reconcile(false);
    settings.dropbox.lastSync = Date.now();
    // Quiet: lastSync is device-local and never travels. Stamping updatedAt for
    // it would make this device look newer than every other one after every
    // single pass, and its settings would win races it never actually entered.
    persistSettingsQuiet();
    setStatus('ok', summary);
  } catch (err) {
    console.error(err);
    // The on-screen debug log is the only console on iOS, and is where this
    // actually gets read — give it everything, including the raw body.
    dbg('sync failed —', err.message);
    if (err instanceof dbx.DropboxError && err.body) dbg('  body:', err.body.slice(0, 500));
    setStatus('error', explain(err));
  }
}

// Turns a Dropbox failure into something worth reading. Anything unrecognised
// keeps the labelled summary rather than being flattened into "Sync failed" —
// a message naming the endpoint is the difference between a fixable report and
// a shrug.
function explain(err) {
  if (!(err instanceof dbx.DropboxError)) return err.message || 'Sync failed';
  if (err.isTag('missing_scope')) {
    return 'Reconnect — the app\'s permissions changed since you authorised it.';
  }
  if (err.isUnspecified) {
    return `Dropbox gave no reason (${err.endpoint}). Try again.`;
  }
  return err.message;
}

async function reconcile(isRetry) {
  const { manifest, rev } = await readManifest();

  // ---- what each side has ----
  const remoteFiles = new Map();   // id -> Dropbox file entry
  for (const e of await dbx.listFolder(SYNC_ROOT)) {
    if (!/\.epub$/i.test(e.name)) continue;
    // Prefer the id the manifest already filed this path under: a book whose
    // file was renamed in Dropbox keeps its progress and its tombstone history.
    const known = Object.keys(manifest.books)
      .find(id => manifest.books[id]?.path === e.path_lower);
    remoteFiles.set(known || makeBookId(e.name, e.size), e);
  }
  const localIds = new Set(await dbAllIds());
  const localTombs = allTombstones();

  const notes = [];
  let touched = false;

  // ---- deletions this device made, replayed outward ----
  for (const [id, tomb] of Object.entries(localTombs)) {
    const remote = remoteFiles.get(id);
    if (remote) {
      try {
        await dbx.deletePath(remote.path_lower);
        notes.push('deleted');
      } catch (err) {
        // Already gone is the outcome we wanted anyway.
        if (!(err instanceof dbx.DropboxError && err.isTag('path_lookup', 'not_found'))) throw err;
      }
      remoteFiles.delete(id);
    }
    manifest.deleted[id] = { at: tomb.at, fileName: tomb.fileName || '' };
    delete manifest.books[id];
    delete manifest.progress[id];
    // Recorded in the manifest now, so other devices will see it — this
    // device no longer needs to remember it locally.
    clearTombstone(id);
    touched = true;
  }

  // ---- deletions other devices made, applied here ----
  for (const [id, tomb] of Object.entries(manifest.deleted)) {
    if (Date.now() - (tomb.at || 0) > TOMBSTONE_TTL) {
      delete manifest.deleted[id];
      touched = true;
      continue;
    }
    if (!localIds.has(id)) continue;
    const record = await dbGet(id);
    // A book re-added here after the delete is a deliberate undo: keep it, and
    // retract the tombstone so it isn't deleted again on the next pass.
    if (record && (record.addedAt || 0) > (tomb.at || 0)) {
      delete manifest.deleted[id];
      touched = true;
      continue;
    }
    await dbDelete(id);
    clearProgress(id);
    localIds.delete(id);
    if (localStorage.getItem('reader-last-book') === id) {
      localStorage.removeItem('reader-last-book');
    }
    notes.push('removed');
    touched = true;
  }

  // ---- books only Dropbox has → download ----
  for (const [id, entry] of remoteFiles) {
    if (localIds.has(id) || manifest.deleted[id]) continue;
    const { buffer } = await dbx.download(entry.path_lower);
    let record;
    try {
      record = await addBookFromBuffer(buffer, entry.name, entry.size);
    } catch (err) {
      // One unreadable EPUB in the folder must not abort the whole pass.
      dbg('sync: could not import', entry.name, '—', err.message);
      notes.push(`skipped ${entry.name}`);
      continue;
    }
    localIds.add(record.id);
    // The file was renamed in Dropbox since the manifest last saw it, so its
    // id has moved. Carry the reading position across and drop the stale entry
    // rather than leaving an orphan that looks like a book to re-upload.
    if (record.id !== id) {
      if (manifest.progress[id] && !manifest.progress[record.id]) {
        manifest.progress[record.id] = manifest.progress[id];
      }
      delete manifest.progress[id];
      delete manifest.books[id];
    }
    manifest.books[record.id] = {
      path: entry.path_lower,
      fileName: entry.name,
      size: entry.size,
      title: record.title,
      author: record.author,
      addedAt: record.addedAt,
    };
    notes.push('downloaded');
    touched = true;
  }

  // ---- books only this device has → upload ----
  for (const id of localIds) {
    if (remoteFiles.has(id) || manifest.deleted[id]) continue;
    // Whole records are read only here, for the few books that need it —
    // dbAll() would drag every book's bytes into memory on every pass.
    const record = await dbGet(id);
    if (!record?.data) continue;
    if (record.data.byteLength > MAX_UPLOAD) {
      notes.push(`${record.fileName || record.title} is too big to upload`);
      continue;
    }
    const name = record.fileName || `${record.title || id}.epub`;
    // autorename, because a same-named file that isn't in the manifest is some
    // other book and must not be overwritten.
    const meta = await dbx.upload(childPath(name), record.data, 'add', true);
    manifest.books[id] = {
      path: meta.path_lower,
      fileName: meta.name,
      size: record.data.byteLength,
      title: record.title || '',
      author: record.author || '',
      addedAt: record.addedAt || Date.now(),
    };
    notes.push('uploaded');
    touched = true;
  }

  // ---- reading position: newest wins, both ways ----
  for (const id of localIds) {
    const mine = getProgress(id);
    const theirs = manifest.progress[id];
    if (mine && (!theirs || mine.at > (theirs.at || 0))) {
      manifest.progress[id] = { cfi: mine.cfi, at: mine.at };
      touched = true;
    } else if (theirs?.cfi && (!mine || (theirs.at || 0) > mine.at)) {
      setProgress(id, theirs.cfi, theirs.at);
      touched = true;
    }
  }

  // ---- settings: one timestamp for the whole blob, newest wins ----
  const remoteAt = manifest.settings?.at || 0;
  const localAt = settings.updatedAt || 0;
  if (remoteAt > localAt) {
    const wasLayout = settings.layout;
    if (importSettings(manifest.settings.values)) {
      applyAll();
      refreshSettingsUI();
      // Single/dual page is baked into the rendition at construction time, so
      // an arriving change needs the same rebuild the settings row does.
      if (settings.layout !== wasLayout && runtime.book && runtime.rendition) {
        const cfi = runtime.rendition.currentLocation()?.start?.cfi;
        try { runtime.rendition.destroy(); } catch {}
        $('viewer').innerHTML = '';
        createRendition();
        runtime.rendition.display(cfi || undefined);
      }
      // Last, because applyAll persists — and therefore stamps — on its way
      // through. Keep the timestamp we copied: stamping our own would make this
      // device look newer than the one it just copied from, and on the next
      // pass it would push the same values straight back.
      settings.updatedAt = remoteAt;
      persistSettingsQuiet();
      notes.push('settings updated');
    }
  } else if (localAt > remoteAt) {
    manifest.settings = { at: localAt, values: exportSettings() };
    touched = true;
  }

  // ---- write back ----
  if (touched) {
    try {
      await writeManifest(manifest, rev);
    } catch (err) {
      // Another device wrote while we were working. Its version is now the
      // truth; start over against it. Once only — a second conflict means
      // something is writing continuously and retrying will not help.
      if (isConflict(err) && !isRetry) return reconcile(true);
      throw err;
    }
  }

  await renderLibrary();
  return summarise(notes);
}

function summarise(notes) {
  if (!notes.length) return 'Up to date';
  const counts = {};
  for (const n of notes) counts[n] = (counts[n] || 0) + 1;
  return Object.entries(counts)
    .map(([label, n]) => (n > 1 ? `${n} ${label}` : label))
    .join(', ')
    .replace(/^./, c => c.toUpperCase());
}

// ============================================================
// Library header button
// ============================================================
export function initSyncUI() {
  const btn = $('btn-sync');
  if (!btn) return;

  onStatus(s => {
    btn.classList.toggle('syncing', s.state === 'syncing');
    btn.classList.toggle('sync-error', s.state === 'error');
    btn.title = s.message || (isReady() ? 'Dropbox sync' : 'Set up Dropbox sync');
  });

  // Always the settings sheet, connected or not. Syncing itself is automatic,
  // so a button that sometimes synced and sometimes opened settings was asking
  // people to guess at state they cannot see from the library.
  btn.addEventListener('click', showSettingsModal);

  // Fired by library.js on add/delete and by reader.js on closing a book.
  document.addEventListener('reader:syncRequest', () => requestSync());
}

// ============================================================
// Settings sheet — the Sync section
// ============================================================
export function initDropboxSettings() {
  const stateEl = $('sync-state');
  const noteEl = $('sync-note');
  const codeInput = $('sync-code');
  const errEl = $('sync-error');
  const nowBtn = $('sync-now');
  const disconnectBtn = $('sync-disconnect');
  const connectRow = $('sync-connect');
  const syncErrEl = $('sync-failure');
  if (!stateEl) return;

  const closeConnect = bindDisclosure(connectRow);

  const fail = (msg) => { errEl.textContent = msg; errEl.hidden = false; };

  const refresh = () => {
    const connected = dbx.isConnected();
    const s = getStatus();
    // Worth spelling out where the files actually land, since the app folder
    // is not somewhere people look by habit.
    const where = 'Books live in your Dropbox under Apps/<your app>/.';
    if (!dbx.isConfigured()) {
      stateEl.textContent = 'No app key';
      noteEl.textContent = 'Paste your Dropbox app key into DROPBOX_APP_KEY in js/dropbox.js. '
        + 'Create the app at dropbox.com/developers with App folder access and the '
        + 'files.content, files.metadata and account_info.read permissions.';
    } else if (!connected) {
      stateEl.textContent = 'Not connected';
      noteEl.textContent = 'Books, reading position and every setting — including your '
        + 'translation key — are kept there. Anyone with access to that folder can read '
        + 'the key. ' + where;
    } else {
      stateEl.textContent = s.state === 'syncing' ? 'Syncing…' : (dbx.connectedAccount() || 'Connected');
      const last = settings.dropbox.lastSync;
      const ok = s.state === 'error' ? '' : (s.message || '');
      noteEl.textContent = [ok, last ? `Last synced ${new Date(last).toLocaleString()}` : '', where]
        .filter(Boolean).join(' · ');
    }
    // A failed sync gets its own line rather than being appended to the
    // footnote: these messages name an endpoint and a status, and are too long
    // to read buried in a paragraph or squeezed into a tooltip.
    if (s.state === 'error') { syncErrEl.textContent = s.message; syncErrEl.hidden = false; }
    else syncErrEl.hidden = true;
    connectRow.hidden = connected;
    nowBtn.hidden = !connected;
    disconnectBtn.hidden = !connected;
  };

  onStatus(refresh);

  $('sync-open').addEventListener('click', async () => {
    errEl.hidden = true;
    try {
      await dbx.beginAuth();
      codeInput.focus();
    } catch (err) { fail(err.message); }
  });

  const finish = async () => {
    errEl.hidden = true;
    const code = codeInput.value.trim();
    if (!code) return fail('Paste the code Dropbox showed you.');
    try {
      await dbx.finishAuth(code);
      codeInput.value = '';
      closeConnect();
      refresh();
      syncNow();
    } catch (err) { fail(err.message); }
  };
  $('sync-finish').addEventListener('click', finish);
  codeInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
  });

  nowBtn.addEventListener('click', () => syncNow());

  disconnectBtn.addEventListener('click', () => {
    if (!confirm('Disconnect Dropbox? Your books stay on this device and in Dropbox.')) return;
    dbx.disconnect();
    setStatus('idle', '');
    refresh();
  });

  refresh();
}
