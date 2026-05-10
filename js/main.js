// ============================================================
// Bootstrap. Wires modules together in the correct order.
// ============================================================

import { applyChromeTheme, applyCustomCssToParent } from './theme.js';
import { renderLibrary, initLibraryEvents, setBookOpener } from './library.js';
import { openBookFromDb, initReaderEvents } from './reader.js';
import { initTranslateEvents } from './translate.js';
import { initUI } from './ui.js';
import { dbGet } from './state.js';

// 1. Initial CSS (variables + user-custom-css contents)
applyChromeTheme();
applyCustomCssToParent();

// 2. Wire library (and let it know how to open books — avoids circular import)
setBookOpener(openBookFromDb);
initLibraryEvents();

// 3. Wire reader (keyboard, viewer wheel, edge zones)
initReaderEvents();

// 4. Wire translation popup (close/+ buttons, outside-click, sel change)
initTranslateEvents();

// 5. Wire all the UI bindings (drawers, modal, tabs, settings inputs,
//    theme swatches + presets, font/layout/translation/css panels)
initUI();

// 6. First paint of the library
renderLibrary();

// 7. Auto-resume the last-read book if one is marked. Pre-check via dbGet so a
//    stale marker (book deleted from another tab, etc.) clears silently
//    instead of triggering openBookFromDb's "Book not found" alert.
(async () => {
  const lastId = localStorage.getItem('reader-last-book');
  if (!lastId) return;
  const exists = await dbGet(lastId);
  if (exists) openBookFromDb(lastId);
  else localStorage.removeItem('reader-last-book');
})();
