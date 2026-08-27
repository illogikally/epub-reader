// ============================================================
// Library: grid of cards, add via file picker or drag/drop,
// extracts cover art and metadata from EPUB on import.
// ============================================================

import {
  $, escapeHtml,
  dbAll, dbPut, dbDelete, makeBookId,
} from './state.js?v=23';

// Lazy import to avoid circular dependency: reader imports from library.
let _openBookFromDb = null;
export function setBookOpener(fn) { _openBookFromDb = fn; }

const library = $('library');
const libraryGrid = $('library-grid');
const libraryCount = $('library-count');
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

export async function addBookFromFile(file) {
  loading.classList.add('visible');
  try {
    const buffer = await file.arrayBuffer();
    const tmp = window.ePub(buffer);
    await tmp.ready;
    const meta = (tmp.packaging && tmp.packaging.metadata) || {};
    const cover = await extractCover(tmp);
    const id = makeBookId(file.name, file.size);
    const record = {
      id,
      title: meta.title || file.name.replace(/\.epub$/i, ''),
      author: meta.creator || '',
      fileName: file.name, fileSize: file.size,
      addedAt: Date.now(),
      cover, data: buffer,
    };
    try { tmp.destroy(); } catch {}
    await dbPut(record);
    await renderLibrary();
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
  libraryCount.textContent = books.length === 0
    ? 'No books yet'
    : `${books.length} book${books.length === 1 ? '' : 's'}`;

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
      localStorage.removeItem(`reader-progress-${b.id}`);
      if (localStorage.getItem('reader-last-book') === b.id) {
        localStorage.removeItem('reader-last-book');
      }
      await renderLibrary();
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
