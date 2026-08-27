// ============================================================
// Library: grid of cards, add via file picker or drag/drop,
// extracts cover art and metadata from EPUB on import.
// ============================================================

import {
  $, escapeHtml,
  dbAll, dbPut, dbDelete, makeBookId,
  clearProgress, addTombstone, clearTombstone,
} from './state.js?v=35';

// Something changed that Dropbox should hear about. A custom event rather than
// an import so library.js stays free of sync.js — which imports from here.
// Same shape as the reader:hideAllDrawers hop between reader.js and ui.js.
function announceChange() {
  document.dispatchEvent(new CustomEvent('reader:syncRequest'));
}

// Lazy import to avoid circular dependency: reader imports from library.
let _openBookFromDb = null;
export function setBookOpener(fn) { _openBookFromDb = fn; }

const library = $('library');
const libraryGrid = $('library-grid');
const fileInput = $('file-input');
const loading = $('loading');

async function extractCover(epubBook) {
  try {
    const url = await epubBook.coverUrl();
    if (!url) return null;
    const res = await fetch(url);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch { return null; }
}

// The import itself: parse, pull metadata and cover art, store. Split out from
// addBookFromFile so a book arriving from Dropbox goes through exactly the same
// path and comes out with the same title, cover and id as a local import would.
// Throws — the caller decides whether that deserves an alert.
export async function addBookFromBuffer(buffer, fileName, fileSize) {
  const tmp = window.ePub(buffer);
  await tmp.ready;
  const meta = (tmp.packaging && tmp.packaging.metadata) || {};
  const cover = await extractCover(tmp);
  const id = makeBookId(fileName, fileSize);
  const record = {
    id,
    title: meta.title || fileName.replace(/\.epub$/i, ''),
    author: meta.creator || '',
    fileName, fileSize,
    addedAt: Date.now(),
    cover, data: buffer,
  };
  try { tmp.destroy(); } catch {}
  await dbPut(record);
  // Adding a book back after deleting it retracts the delete, rather than
  // letting the next sync replay the tombstone and remove it again.
  clearTombstone(id);
  return record;
}

export async function addBookFromFile(file) {
  loading.classList.add('visible');
  try {
    await addBookFromBuffer(await file.arrayBuffer(), file.name, file.size);
    await renderLibrary();
    announceChange();
  } catch (err) {
    alert('Could not add this EPUB:\n' + err.message);
    console.error(err);
  } finally {
    loading.classList.remove('visible');
  }
}

export async function renderLibrary() {
  const books = await dbAll();
  books.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  libraryGrid.innerHTML = '';

  // Covers only. Title and author are carried by the tooltip and the alt text
  // rather than shown, and the coverless fallback still prints the title.
  books.forEach(b => {
    const card = document.createElement('div');
    card.className = 'book-card';
    const label = escapeHtml([b.title, b.author].filter(Boolean).join(' — '));
    card.title = [b.title, b.author].filter(Boolean).join(' — ');
    card.innerHTML = `
      <div class="book-cover">
        ${b.cover ? `<img src="${b.cover}" alt="${label}">` : `<span>${escapeHtml(b.title)}</span>`}
      </div>
      <button class="book-delete" title="Remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    `;
    card.addEventListener('click', () => {
      if (_openBookFromDb) _openBookFromDb(b.id);
    });
    card.querySelector('.book-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove "${b.title}"?`)) return;
      await dbDelete(b.id);
      clearProgress(b.id);
      // The delete has to survive as a fact, not just an absence: the next sync
      // replays it to Dropbox, and without it the book would simply download
      // itself back again.
      addTombstone(b.id, b.fileName || '');
      if (localStorage.getItem('reader-last-book') === b.id) {
        localStorage.removeItem('reader-last-book');
      }
      await renderLibrary();
      announceChange();
    });
    libraryGrid.appendChild(card);
  });
}

export function initLibraryEvents() {
  // Adding a book lives in the header now, next to the title.
  $('btn-add-book').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    for (const f of e.target.files) await addBookFromFile(f);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(evt =>
    library.addEventListener(evt, e => {
      e.preventDefault();
      library.classList.add('dragging');
    })
  );
  ['dragleave', 'drop'].forEach(evt =>
    library.addEventListener(evt, e => {
      e.preventDefault();
      library.classList.remove('dragging');
    })
  );
  library.addEventListener('drop', async e => {
    for (const f of e.dataTransfer.files) {
      if (f.name.toLowerCase().endsWith('.epub')) await addBookFromFile(f);
    }
  });
}
