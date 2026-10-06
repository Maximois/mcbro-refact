'use strict';

// ── Bookmarks Panel ─────────────────────────────
let _bookmarks = [];
let _bookmarkFolder = '';

async function loadBookmarks() {
  try { _bookmarks = await mc.bookmarksList(); } catch { _bookmarks = []; }
  renderBookmarks();
}

function renderBookmarks() {
  const list = $('bp-list');
  if (!list) return;
  const searchInput = $('bp-search-input');
  const q = (searchInput?.value || '').toLowerCase();
  let filtered = _bookmarks;
  if (_bookmarkFolder) {
    filtered = filtered.filter(b => (_bookmarkFolder === '_unfiled' ? !b.folder : b.folder === _bookmarkFolder));
  }
  if (q) {
    filtered = filtered.filter(b => (b.title || '').toLowerCase().includes(q) || (b.url || '').toLowerCase().includes(q));
  }
  if (!filtered.length) {
    list.innerHTML = '<div class="bp-empty"><div class="bp-empty-icon">&#9734;</div><div>' +
      (_bookmarks.length ? 'Sin resultados' : 'Sin marcadores aún') +
      '</div><div style="margin-top:4px;font-size: 0.769rem;">Haz clic en &#9734; en la barra de URL</div></div>';
    return;
  }
  list.innerHTML = filtered.map((b, i) => {
    const faviconUrl = b.icon || ('https://www.google.com/s2/favicons?domain=' + new URL(b.url).hostname + '&sz=32');
    const idx = _bookmarks.indexOf(b);
    const label = humanizeUrlLabel(b.url, b.title || 'Marcador');
    const titleText = b.title || label;
    return `<div class="bp-item" draggable="true" data-idx="${idx}" onclick="navigateToBookmark('${b.id}')" title="${escHtml(label)}">
      <div class="bp-item-icon"><img src="${faviconUrl}" onerror="this.style.display='none';this.parentNode.textContent='🔗';" /></div>
      <div class="bp-item-info">
        <div class="bp-item-title">${escHtml(titleText)}</div>
        <div class="bp-item-url">${escHtml(label)}</div>
      </div>
      <button class="bp-item-del" onclick="event.stopPropagation();removeBookmark('${b.id}')" title="Eliminar">&#10005;</button>
    </div>`;
  }).join('');
  // Update star for current URL
  updateBookmarkStar();
  // Drag & drop reorder
  list.querySelectorAll('.bp-item').forEach(el => {
    el.addEventListener('dragstart', (e) => {
      const idx = parseInt(el.dataset.idx, 10);
      const bookmark = _bookmarks[idx];
      const label = humanizeUrlLabel(bookmark?.url || '', bookmark?.title || 'Marcador');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-mc-bookmark-index', String(idx));
      e.dataTransfer.setData('text/plain', label);
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      const fromIdx = parseInt(e.dataTransfer.getData('application/x-mc-bookmark-index') || e.dataTransfer.getData('text/plain') || '-1', 10);
      const toIdx = parseInt(el.dataset.idx, 10);
      if (Number.isInteger(fromIdx) && fromIdx >= 0 && fromIdx !== toIdx) { await mc.bookmarksReorder(fromIdx, toIdx); await loadBookmarks(); }
    });
  });
}

async function addBookmark() {
  const url = $('urlinput')?.value?.trim();
  if (!url || url === 'mc://newtab') return;
  const title = getTitleForUrl(url) || url;
  try { await mc.bookmarksAdd({ url, title, icon: '', folder: _bookmarkFolder || '' }); } catch {}
  await loadBookmarks();
}

async function removeBookmark(id) {
  try { await mc.bookmarksRemove(id); } catch {}
  await loadBookmarks();
}

async function navigateToBookmark(id) {
  const b = _bookmarks.find(x => x.id === id);
  if (b?.url) loadUrl(b.url);
}

function toggleBookmark() {
  const url = $('urlinput')?.value?.trim();
  if (!url || url === 'mc://newtab') return;
  const existing = _bookmarks.find(b => b.url === url);
  if (existing) { removeBookmark(existing.id); } else { addBookmark(); }
}

function updateBookmarkStar() {
  const star = $('bookmark-star');
  if (!star) return;
  const url = $('urlinput')?.value?.trim();
  const isBookmarked = url && _bookmarks.some(b => b.url === url);
  star.classList.toggle('bookmarked', !!isBookmarked);
  star.innerHTML = isBookmarked ? '&#9733;' : '&#9734;';
  star.title = isBookmarked ? 'Quitar marcador' : 'Añadir marcador';
}

function toggleBookmarksPanel() {
  const panel = $('bookmarks-panel');
  const btn = $('bookmarks-toggle');
  if (!panel) return;
  const collapsed = panel.classList.toggle('collapsed');
  if (btn) btn.classList.toggle('collapsed', collapsed);
  try { localStorage.setItem('mc_bookmarks_collapsed', collapsed ? '1' : ''); } catch {}
  if (!collapsed) loadBookmarks();
}

function addBookmarkFromPanel() {
  addBookmark();
}

function setBookmarkFolder(folder) {
  _bookmarkFolder = folder;
  const bar = $('bp-folder-bar');
  if (bar) {
    bar.querySelectorAll('.bp-folder-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.folder === folder);
    });
  }
  renderBookmarks();
}

function filterBookmarks(q) { renderBookmarks(); }

// Init bookmarks panel collapsed state
(function(){
  const bp = $('bookmarks-panel');
  const btn = $('bookmarks-toggle');
  if (bp && btn) {
    const was = localStorage.getItem('mc_bookmarks_collapsed');
    if (was === null || was !== '1') {
      // Default: collapsed (user can toggle open)
    } else {
      bp.classList.add('collapsed');
      btn.classList.add('collapsed');
    }
  }
})();
