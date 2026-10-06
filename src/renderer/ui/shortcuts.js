'use strict';
// ════════════════════════════════════════════
//  ACCESOS DIRECTOS EDITABLES
// ════════════════════════════════════════════
const SHORTCUTS_STORAGE_KEY = 'mc_shortcuts';

function loadShortcuts() {
  try {
    const raw = localStorage.getItem(SHORTCUTS_STORAGE_KEY);
    if (raw) state.shortcuts = JSON.parse(raw);
  } catch {}
  if (!state.shortcuts || !state.shortcuts.length) state.shortcuts = [...DEFAULT_SHORTCUTS];
  renderShortcuts();
  renderShortcutsEditor();
}

function saveShortcuts() {
  try { localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(state.shortcuts)); } catch {}
}

function renderShortcuts() {
  const container = $('nt-shortcuts-container');
  if (!container) return;
  container.innerHTML = state.shortcuts.map((s, i) =>
    '<div class="nt-shortcut" onclick="loadUrl(\'' + s.url.replace(/'/g, "\\'") + '\')">' +
      getShortcutIconHtml(s, 18) +
      '<div class="nt-sc-label">' + escapeHtml(s.label) + '</div>' +
    '</div>'
  ).join('');
}

function getShortcutIconHtml(s, size) {
  size = size || 18;
  if (!s.icon) {
    // No cargar favicons externos para evitar tracking/ads
    return '<span style="font-size:' + size + 'px;">🔗</span>';
  } else if (s.icon.startsWith('http')) {
    // No permitir iconos externos, usar emoji por defecto
    return '<span style="font-size:' + size + 'px;">🔗</span>';
  } else {
    return '<div class="nt-sc-icon">' + s.icon + '</div>';
  }
}

function renderShortcutsEditor() {
  const editor = $('shortcuts-editor');
  if (!editor) return;
  if (!state.shortcuts.length) {
    editor.innerHTML = '<div style="color:var(--muted);font-size: 0.846rem;text-align:center;padding:8px 0;">No hay accesos directos configurados</div>';
    return;
  }
  editor.innerHTML = state.shortcuts.map((s, i) =>
    '<div style="display:flex;gap:6px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);">' +
      '<div style="width:40px;text-align:center;">' + getShortcutIconHtml(s, 16) + '</div>' +
      '<input class="text-input" style="flex:1;" value="' + escapeHtml(s.label) + '" onchange="updateShortcutLabel(' + i + ', this.value)" placeholder="Etiqueta">' +
      '<input class="text-input" style="flex:2;" value="' + escapeHtml(s.url) + '" onchange="updateShortcutUrl(' + i + ', this.value)" placeholder="URL">' +
      '<input class="text-input" style="flex:1;" value="' + escapeHtml(s.icon || '') + '" onchange="updateShortcutIcon(' + i + ', this.value)" placeholder="Icono (emoji o URL)">' +
      '<button class="rule-del" onclick="deleteShortcut(' + i + ')" title="Eliminar">&#215;</button>' +
    '</div>'
  ).join('');
}

function updateShortcutIcon(idx, val) {
  if (!state.shortcuts[idx]) return;
  // Si el valor está vacío, tratarlo como null para cargar favicon automático
  state.shortcuts[idx].icon = val.trim() || null;
  saveShortcuts();
  renderShortcuts();
  renderShortcutsEditor();
}
function updateShortcutLabel(idx, val) {
  if (state.shortcuts[idx]) { state.shortcuts[idx].label = val; saveShortcuts(); renderShortcuts(); }
}
function updateShortcutUrl(idx, val) {
  if (!state.shortcuts[idx]) return;
  state.shortcuts[idx].url = val;
  // Reiniciar icono para que se cargue el favicon de la nueva URL
  state.shortcuts[idx].icon = null;
  saveShortcuts();
  renderShortcuts();
  renderShortcutsEditor();
}

function addShortcut() {
  state.shortcuts.push({ url: 'https://ejemplo.com', icon: null, label: 'Nuevo acceso' });
  saveShortcuts();
  renderShortcuts();
  renderShortcutsEditor();
  addSidebarLog('info', '[SHORTCUT] Acceso directo agregado');
}

function deleteShortcut(idx) {
  state.shortcuts.splice(idx, 1);
  saveShortcuts();
  renderShortcuts();
  renderShortcutsEditor();
  addSidebarLog('info', '[SHORTCUT] Acceso directo eliminado');
}

function resetShortcuts() {
  state.shortcuts = [...DEFAULT_SHORTCUTS];
  saveShortcuts();
  renderShortcuts();
  renderShortcutsEditor();
  addSidebarLog('info', '[SHORTCUT] Accesos restaurados a valores predeterminados');
}
