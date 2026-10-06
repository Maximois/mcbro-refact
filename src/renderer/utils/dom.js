'use strict';

// ── helpers ─────────────────────────────────────
function $(id){ return document.getElementById(id); }
function setText(id, v){ const e=$(id); if(e) e.textContent=v; }

// ── Sidebar toggle ────────────────────────────
function toggleSidebar() {
  const sb = $('sidebar');
  const btn = $('sidebar-toggle');
  if (!sb || !btn) return;
  const collapsed = sb.classList.toggle('collapsed');
  btn.classList.toggle('collapsed', collapsed);
  btn.innerHTML = collapsed ? '&#9654;' : '&#9664;';
  btn.title = collapsed ? 'Abrir sidebar (Ctrl+Shift+S)' : 'Colapsar sidebar (Ctrl+Shift+S)';
  try { localStorage.setItem('mc_sidebar_collapsed', collapsed ? '1' : ''); } catch {}
  if (!collapsed) {
    renderSidebarStreams();
  }
}
(function(){
  const sb = $('sidebar');
  const btn = $('sidebar-toggle');
  if (sb && btn) {
    const was = localStorage.getItem('mc_sidebar_collapsed') === '1';
    if (was) { sb.classList.add('collapsed'); btn.classList.add('collapsed'); btn.innerHTML = '&#9654;'; btn.title = 'Abrir sidebar (Ctrl+Shift+S)'; }
  }
})();

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function isExplicitlyDraggable(node) {
  if (!node || !(node instanceof Element)) return false;
  return !!node.closest('[draggable="true"], [data-draggable="true"], img, video, audio, canvas, svg');
}

document.addEventListener('dragstart', (event) => {
  const node = event.target;
  if (!(node instanceof Element)) return;
  if (isExplicitlyDraggable(node)) return;
  event.preventDefault();
  event.stopPropagation();
}, true);

function humanizeUrlLabel(url, fallback = 'Sin título') {
  const raw = String(url || '').trim();
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    const host = (u.hostname || '').replace(/^www\./i, '');
    const pathParts = (u.pathname || '').split('/').filter(Boolean).slice(0, 3).map(p => p.replace(/[-_]+/g, ' ').trim()).filter(Boolean);
    if (!host) return fallback;
    return pathParts.length ? host + ' • ' + pathParts.join(' / ') : host;
  } catch {
    const cleaned = raw
      .replace(/^https?:\/\//i, '')
      .replace(/^file:\/\//i, '')
      .replace(/[?#].*$/, '')
      .replace(/\/+$|\\+$/g, '')
      .trim();
    return cleaned || fallback;
  }
}

function getTitleForUrl(url) {
  return humanizeUrlLabel(url, 'Sin título');
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function fmtBytes(n) {
  if (!n || n <= 0) return '0 B';
  const u = ['B','KB','MB','GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}

function compactDownloadName(name, maxLength = 48) {
  const fullName = String(name || 'descarga');
  if (fullName.length <= maxLength) return fullName;
  const match = fullName.match(/^(.*)(\.[^.]*)$/);
  const extension = match ? match[2] : '';
  const base = match ? match[1] : fullName;
  const available = Math.max(8, maxLength - extension.length - 3);
  return base.slice(0, available) + '...' + extension;
}
