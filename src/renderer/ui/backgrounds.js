'use strict';

// ── Sidebar background ──
let _sidebarBg = { data: null };
function loadSideBg() {
  try { const r = localStorage.getItem('mc-sidebar-bg'); if (r) _sidebarBg = JSON.parse(r); } catch {}
  if (_sidebarBg.data) applySideBg(_sidebarBg.data);
}
function saveSideBg() { try { localStorage.setItem('mc-sidebar-bg', JSON.stringify(_sidebarBg)); } catch {} }
function applySideBg(data) {
  const bg = document.getElementById('sidebar-bg');
  const sb = document.getElementById('sidebar');
  if (!data) {
    if (bg) bg.style.backgroundImage = '';
    if (sb) { sb.classList.remove('has-bg'); sb.style.background = ''; }
    setPanelContrast(sb, 0);
    return;
  }
  if (bg) bg.style.backgroundImage = 'url("' + data + '")';
  if (sb) { sb.style.background = 'transparent'; sb.classList.add('has-bg'); }
  computeImageLuminance(data, lum => setPanelContrast(sb, lum));
}
function handleSideBgFile(e) {
  const file = e.target.files[0];
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = (ev) => { _sidebarBg.data = ev.target.result; saveSideBg(); applySideBg(_sidebarBg.data); };
  reader.readAsDataURL(file);
}
function applySideBgUrl() {
  const url = document.getElementById('side-bg-url')?.value?.trim();
  if (!url) return;
  _sidebarBg.data = url; saveSideBg(); applySideBg(url);
}
function clearSideBg() {
  _sidebarBg.data = null; saveSideBg(); applySideBg(null);
  const inp = document.getElementById('side-bg-url');
  if (inp) inp.value = '';
  const file = document.getElementById('side-bg-file');
  if (file) file.value = '';
}
loadSideBg();
loadPanelBg('bookmarks');
loadPanelBg('utility');
loadPanelBg('resources');

// ── Generic panel background helper ──
function getPanelBgKey(name) {
  return 'mc-panel-bg-' + name;
}
// Auto-contraste: calcula la luminancia media de la imagen de fondo y
// ajusta las variables de color del panel para que el texto siempre sea legible.
function computeImageLuminance(dataUrl, cb) {
  const img = new Image();
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = 24; c.height = 24;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 24, 24);
      const d = ctx.getImageData(0, 0, 24, 24).data;
      let sum = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        n++;
      }
      cb(sum / n);
    } catch { cb(0); }
  };
  img.onerror = () => cb(0);
  img.src = dataUrl;
}
function setPanelContrast(host, lum) {
  if (!host) return;
  if (lum === 0) {
    // Sin fondo (o imagen no cargada) → tema por defecto
    host.dataset.contrast = '';
    ['--text','--muted','--muted2','--border','--surface','--surface2','--accent','--danger','--warn','--panel-overlay','--panel-controls-bg','--panel-header-bg','--panel-tabs-bg','--panel-view-bg'].forEach(p => host.style.removeProperty(p));
    return;
  }
  if (lum > 150) {
    // Fondo claro → texto teal oscuro
    host.dataset.contrast = 'light';
    host.style.setProperty('--text', '#0b5a4e');
    host.style.setProperty('--muted', '#2f7a6d');
    host.style.setProperty('--muted2', '#1f6b5e');
    host.style.setProperty('--border', 'rgba(0,0,0,.22)');
    host.style.setProperty('--surface', 'rgba(255,255,255,.6)');
    host.style.setProperty('--surface2', 'rgba(255,255,255,.42)');
    host.style.setProperty('--accent', '#008f74');
    host.style.setProperty('--danger', '#c22b47');
    host.style.setProperty('--warn', '#a8640f');
    host.style.setProperty('--panel-overlay', 'rgba(255,255,255,.38)');
    host.style.setProperty('--panel-controls-bg', 'rgba(255,255,255,.35)');
    host.style.setProperty('--panel-header-bg', 'rgba(255,255,255,.3)');
    host.style.setProperty('--panel-tabs-bg', 'rgba(255,255,255,.2)');
    host.style.setProperty('--panel-view-bg', 'rgba(255,255,255,.12)');
  } else {
    // Fondo oscuro → texto menta suave (teal claro) con borde teal oscuro
    host.dataset.contrast = 'dark';
    host.style.setProperty('--text', '#c9f5ea');
    host.style.setProperty('--muted', '#8fd8c8');
    host.style.setProperty('--muted2', '#a9e8da');
    ['--border','--surface','--surface2','--accent','--danger','--warn','--panel-overlay','--panel-controls-bg','--panel-header-bg','--panel-tabs-bg','--panel-view-bg'].forEach(p => host.style.removeProperty(p));
  }
}
function applyPanelBg(name, data) {
  const hostMap = {
    bookmarks: 'bookmarks-panel',
    utility: 'dl-overlay',
    resources: 'resources-panel'
  };
  const el = document.getElementById(name + '-panel-bg');
  const host = document.getElementById(hostMap[name] || (name + '-panel'));
  if (!el || !host) return;
  if (!data) {
    el.style.backgroundImage = '';
    host.classList.remove('has-panel-bg');
    setPanelContrast(host, 0);
    return;
  }
  el.style.backgroundImage = 'url("' + data + '")';
  host.classList.add('has-panel-bg');
  computeImageLuminance(data, lum => setPanelContrast(host, lum));
}
function loadPanelBg(name) {
  try {
    const raw = localStorage.getItem(getPanelBgKey(name));
    if (!raw) return;
    const val = JSON.parse(raw);
    if (val && val.data) applyPanelBg(name, val.data);
  } catch {}
}
function savePanelBg(name, data) {
  try { localStorage.setItem(getPanelBgKey(name), JSON.stringify({ data })); } catch {}
}
function handlePanelBgFile(name, e) {
  const file = e?.target?.files?.[0];
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const data = ev.target.result;
    savePanelBg(name, data);
    applyPanelBg(name, data);
  };
  reader.readAsDataURL(file);
}
function applyPanelBgUrl(name) {
  const input = document.getElementById(name + '-panel-bg-url');
  const url = input?.value?.trim();
  if (!url) return;
  savePanelBg(name, url);
  applyPanelBg(name, url);
  input.value = '';
}
function clearPanelBg(name) {
  savePanelBg(name, null);
  applyPanelBg(name, null);
  const input = document.getElementById(name + '-panel-bg-url');
  if (input) input.value = '';
}
// ════════════════════════════════════════════
//  FONDO PERSONALIZABLE
// ════════════════════════════════════════════
const BG_STORAGE_KEY = 'mc_bg_settings';

function loadBgSettings() {
  try {
    const raw = localStorage.getItem(BG_STORAGE_KEY);
    if (raw) state.bgSettings = JSON.parse(raw);
  } catch {}
  if (!state.bgSettings) state.bgSettings = { type: null, data: null };
  applyBgFromState();
}

function saveBgSettings() {
  try { localStorage.setItem(BG_STORAGE_KEY, JSON.stringify(state.bgSettings)); } catch {}
}

function applyBgFromState() {
  const container = $('newtab-page');
  const bgDiv = $('nt-bg-image');
  if (!container || !bgDiv) return;
  if (state.bgSettings && state.bgSettings.type) {
    bgDiv.style.display = 'block';
    bgDiv.style.backgroundImage = 'url("' + state.bgSettings.data + '")';
    container.classList.add('has-bg');
  } else {
    bgDiv.style.display = 'none';
    bgDiv.style.backgroundImage = '';
    container.classList.remove('has-bg');
  }
}

function handleBgFile(e) {
  const file = e.target.files[0];
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    state.bgSettings = { type: 'file', data: ev.target.result };
    saveBgSettings();
    applyBgFromState();
    addSidebarLog('info', '[BG] Imagen de fondo aplicada');
  };
  reader.readAsDataURL(file);
}

function applyBgUrl() {
  const url = $('bg-url-input').value.trim();
  if (!url) return;
  state.bgSettings = { type: 'url', data: url };
  saveBgSettings();
  applyBgFromState();
  $('bg-url-input').value = '';
  addSidebarLog('info', '[BG] Imagen de fondo (URL) aplicada');
}

function clearBgImage() {
  state.bgSettings = { type: null, data: null };
  saveBgSettings();
  applyBgFromState();
  $('bg-file-input').value = '';
  $('bg-url-input').value = '';
  addSidebarLog('info', '[BG] Imagen de fondo eliminada');
}

