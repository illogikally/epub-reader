// ============================================================
// Bootstrap. Wires modules together in the correct order.
// ============================================================

import { applyChromeTheme } from './theme.js?v=36';
import { renderLibrary, initLibraryEvents, setBookOpener } from './library.js?v=36';
import { openBookFromDb, initReaderEvents } from './reader.js?v=36';
import { initTranslateEvents } from './translate.js?v=36';
import { initUI } from './ui.js?v=36';
import { initSyncUI, initDropboxSettings, requestSync } from './sync.js?v=36';
import { dbGet } from './state.js?v=36';
import { syncDebugPanel } from './debug.js?v=36';

// 0. Debug panel first, so anything that fails during the wiring below is
//    visible on a phone instead of silent. No-op unless debug is enabled.
syncDebugPanel();

// 1. Initial CSS (theme variables on :root)
applyChromeTheme();

// 2. Wire library (and let it know how to open books — avoids circular import)
setBookOpener(openBookFromDb);
initLibraryEvents();

// 3. Wire reader (keyboard, viewer wheel, edge zones)
initReaderEvents();

// 4. Wire translation popup (close/+ buttons, outside-click, sel change)
initTranslateEvents();

// 5. Wire all the UI bindings (drawers, the settings sheet and every row in it)
initUI();

// 6. Wire Dropbox sync — the Sync section in the sheet and the library button.
//    After initUI, because the settings section reuses its disclosure binder.
initDropboxSettings();
initSyncUI();

// 7. First paint of the library (async — the boot guard in index.html watches
//    the flag below, not the grid, because this has not painted yet on 'load')
renderLibrary();

// 8. Tell the boot guard the module graph ran end to end.
window.__readerBooted = true;

// 9. Pull anything new from Dropbox. A no-op when sync isn't set up, and
//    delayed so it never competes with opening the last-read book.
requestSync(1500);

// 10. Auto-resume the last-read book if one is marked. Pre-check via dbGet so a
//    stale marker (book deleted from another tab, etc.) clears silently
//    instead of triggering openBookFromDb's "Book not found" alert.
(async () => {
  const lastId = localStorage.getItem('reader-last-book');
  if (!lastId) return;
  const exists = await dbGet(lastId);
  if (exists) openBookFromDb(lastId);
  else localStorage.removeItem('reader-last-book');
})();
