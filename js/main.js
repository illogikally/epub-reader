// ============================================================
// Bootstrap. Wires modules together in the correct order.
// ============================================================

import { applyChromeTheme, applyCustomCssToParent } from './theme.js';
import { renderLibrary, initLibraryEvents, setBookOpener } from './library.js';
import { openBookFromDb, initReaderEvents } from './reader.js';
import { initTranslateEvents } from './translate.js';
import { initUI } from './ui.js';

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
