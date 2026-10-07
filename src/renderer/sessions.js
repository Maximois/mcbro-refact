// Init permissions panel collapsed state
(function(){
  const pp = $('permissions-panel');
  const btn = $('permissions-toggle');
  if (pp && btn) {
    const was = localStorage.getItem('mc_permissions_collapsed');
    if (was === '1') {
      pp.classList.add('collapsed');
      btn.classList.remove('open');
    } else {
      pp.classList.remove('collapsed');
      btn.classList.add('open');
    }
  }
})();

// ── Sesiones aisladas (mini-navegador con partición propia, panel a la
//    izquierda) — a diferencia de WebChat, acá se puede navegar a cualquier
//    sitio; cada sesión tiene su propia identidad/cookie jar, gestionada en
//    main.js (sessions:list/create/rename/delete/clear-data). ──
const Sessions = {
  list: [],
  activeId: null,
  _wv: null,
  _injected: false,
  bookmarks: [],
  history: [],
  settings: { home: 'https://duckduckgo.com/' },
  toolsTab: 'bookmarks',
  PALETTE: ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#748ffc', '#da77f2', '#f783ac'],
  // Pestañas (mini-navegador): varias <webview> por sesión, todas con la
  // misma partición persist:mc-session-<id> (misma identidad/cookies).
  tabs: [],
  activeTabId: null,
  tabSeq: 0,
  _tabsFor: null,   // id de la sesión a la que pertenecen this.tabs

  storageKey(kind) { return 'mc-session-' + this.activeId + '-' + kind; },
  readTabs() { try { return JSON.parse(localStorage.getItem(this.storageKey('tabs')) || 'null') ?? []; } catch { return []; } },
  writeTabsFor(id) {
    try {
      localStorage.setItem('mc-session-' + id + '-tabs', JSON.stringify(this.tabs.map(({ url, title }) => ({ url, title }))));
    } catch {}
  },
  writeTabs() { this.writeTabsFor(this.activeId); },
  loadData() {
    const read = (kind, fallback) => { try { return JSON.parse(localStorage.getItem(this.storageKey(kind)) || 'null') ?? fallback; } catch { return fallback; } };
    this.bookmarks = read('bookmarks', []);
    this.history = read('history', []);
    this.settings = read('settings', { home: 'https://duckduckgo.com/' });
  },
  saveData(kind, value) { try { localStorage.setItem(this.storageKey(kind), JSON.stringify(value)); } catch {} },
  currentUrl() { try { return this._wv?.getURL() || ''; } catch { return ''; } },
  currentTitle() { try { return this._wv?.getTitle() || this.currentUrl(); } catch { return this.currentUrl(); } },

  async injectSidebar() {
    if (this._injected) return;
    this._injected = true;
    const sb = document.createElement('div');
    sb.id = 'session-sidebar';
    sb.innerHTML = `
      <div class="session-topbar">
        <div class="session-brand"><span class="session-brand-mark">MC</span></div>
        <select id="session-select" class="session-select"></select>
        <button class="session-action-btn" onclick="Sessions.renameCurrent()" title="Renombrar esta sesión">&#9998;</button>
        <button class="session-action-btn" onclick="Sessions.createNew()" title="Nueva sesión">&#43;</button>
        <button class="session-action-btn" onclick="Sessions.deleteCurrent()" title="Eliminar esta sesión y todos sus datos">&#128465;</button>
        <button class="session-action-btn" onclick="Sessions.toggleTools()" title="Marcadores, historial y configuración">&#128209;</button>
        <button class="session-action-btn" onclick="Sessions.toggleFullwidth()" title="Modo completo (Ctrl+Shift+M)">&#9974;</button>
      </div>
      <div id="session-color-row" class="session-color-row"></div>
      <div id="session-tabbar" class="session-tabbar"></div>
      <div class="session-nav">
        <button class="session-action-btn" onclick="Sessions.goBack()" title="Atrás">&#8592;</button>
        <button class="session-action-btn" onclick="Sessions.goForward()" title="Adelante">&#8594;</button>
        <button class="session-action-btn" onclick="Sessions.reload()" title="Recargar">&#8635;</button>
        <button class="session-action-btn" onclick="Sessions.home()" title="Inicio">&#8962;</button>
        <input id="session-urlbar" class="session-urlbar" placeholder="URL o búsqueda..." spellcheck="false" autocomplete="off" onkeydown="if(event.key==='Enter') Sessions.navigate(this.value)"/>
        <button class="session-action-btn" onclick="Sessions.toggleBookmark()" title="Marcar página">&#9734;</button>
      </div>
      <div id="session-webview-wrap" class="session-webview-wrap">
        <div id="session-tools" class="session-tools">
          <div class="session-tools-head"><span>MC</span><button class="session-action-btn session-tools-close" onclick="Sessions.closeTools()" title="Cerrar">&#10005;</button></div>
          <div class="session-tools-tabs">
            <button class="session-tools-tab active" data-session-tool="bookmarks" onclick="Sessions.switchTools('bookmarks')">Marcadores</button>
            <button class="session-tools-tab" data-session-tool="history" onclick="Sessions.switchTools('history')">Historial</button>
            <button class="session-tools-tab" data-session-tool="settings" onclick="Sessions.switchTools('settings')">Config</button>
          </div>
          <div id="session-tools-content" class="session-tools-content"></div>
        </div>
      </div>
    `;
    const content = document.getElementById('content');
    if (content) content.appendChild(sb);
    document.getElementById('session-select')?.addEventListener('change', (e) => this.switchTo(e.target.value));
    await this.refreshList();
  },

  async refreshList() {
    try {
      this.list = await mc.sessionsList();
      if (!this.list.length) {
        const first = await mc.sessionsCreate();
        if (first?.id) this.list = [first];
      }
    } catch { this.list = []; }
    const sel = document.getElementById('session-select');
    if (!sel) return;
    if (!this.list.length) {
      sel.innerHTML = '<option value="">MC</option>';
      this.activeId = null;
      this.teardownTabs();
      return;
    }
    sel.innerHTML = this.list.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    if (!this.activeId || !this.list.some(s => s.id === this.activeId)) this.activeId = this.list[0].id;
    sel.value = this.activeId;
    this.loadData();
    this.renderColorRow();
    this.applyAccent();
    this.ensureTabs();
  },

  renderColorRow() {
    const row = document.getElementById('session-color-row');
    if (!row) return;
    const current = this.list.find(entry => entry.id === this.activeId);
    row.innerHTML = this.PALETTE.map(color => `<button class="session-color-dot${current?.color === color ? ' active' : ''}" style="background:${color}" onclick="Sessions.setColor('${color}')" title="Color de esta sesión"></button>`).join('');
  },

  applyAccent() {
    const sidebar = document.getElementById('session-sidebar');
    const current = this.list.find(entry => entry.id === this.activeId);
    if (sidebar) sidebar.style.setProperty('--session-accent', current?.color || '#f6b860');
  },

  async setColor(color) {
    if (!this.activeId || !this.PALETTE.includes(color)) return;
    const result = await mc.sessionsSetColor(this.activeId, color);
    if (result?.ok) await this.refreshList();
  },

  // ── Pestañas de la sesión activa ────────────────────
  ensureTabs() {
    const wrap = document.getElementById('session-webview-wrap');
    if (!wrap || !this.activeId) return;
    // Ya montadas para esta misma sesión: solo re-activar la activa.
    if (this._tabsFor === this.activeId && this.tabs.length) {
      this.activateTab(this.tabs.some(t => t.id === this.activeTabId) ? this.activeTabId : this.tabs[0].id);
      return;
    }
    // Cambio de sesión: guardar las tabs de la sesión que se estaba mostrando.
    if (this._tabsFor && this._tabsFor !== this.activeId && this.tabs.length) this.writeTabsFor(this._tabsFor);
    this.teardownTabs();
    this._tabsFor = this.activeId;
    const saved = this.readTabs();
    if (Array.isArray(saved) && saved.length) {
      saved.forEach(item => this.addTab(item.url || this.settings.home || 'https://duckduckgo.com/', { title: item.title }));
    } else {
      this.addTab(this.settings.home || 'https://duckduckgo.com/');
    }
    if (!this.tabs.some(t => t.id === this.activeTabId) && this.tabs[0]) this.activateTab(this.tabs[0].id);
  },

  teardownTabs() {
    const wrap = document.getElementById('session-webview-wrap');
    const webviews = new Set([
      ...(wrap ? Array.from(wrap.querySelectorAll('webview')) : []),
      ...this.tabs.map(t => t.wv).filter(Boolean)
    ]);
    webviews.forEach(wv => this.destroyTabWebview(wv));
    this.tabs = [];
    this.activeTabId = null;
    this._wv = null;
  },

  destroyTabWebview(wv) {
    if (!wv) return;
    try { wv.stop(); } catch {}
    let webContentsId = 0;
    try { webContentsId = Number(wv.getWebContentsId?.()) || 0; } catch {}
    if (webContentsId && typeof mc !== 'undefined' && typeof mc.destroyWebview === 'function') {
      mc.destroyWebview(webContentsId).catch(() => {});
    }
    try { wv.removeAttribute('src'); } catch {}
    try { wv.remove(); } catch {}
  },

  addTab(url, opts = {}) {
    const wrap = document.getElementById('session-webview-wrap');
    if (!wrap || !this.activeId) return null;
    const id = ++this.tabSeq;
    const wv = document.createElement('webview');
    wv.id = 'session-wv-' + id;
    wv.dataset.sessionId = this.activeId;
    wv.dataset.tabId = String(id);
    wv.setAttribute('partition', 'persist:mc-session-' + this.activeId);
    // Misma paridad que los webviews de pestaña normal (app.js): el preload
    // trae la poda de anuncios de YouTube (json-prune), el puente de selección
    // y la navegación con botones del ratón. Sin él, el aislamiento de datos
    // se comía también las funciones del navegador principal.
    wv.setAttribute('preload', selectionPreloadPath);
    wv.setAttribute('allow', 'autoplay; media; encrypted-media; fullscreen');
    wv.setAttribute('allowpopups', '');
    wv.style.cssText = 'width:100%;height:100%;';
    wv.style.display = 'none';
    wrap.appendChild(wv);
    this.bindSessionWebview(wv, id);
    this.tabs.push({ id, title: opts.title || 'Nueva pestaña', url: url || '', wv });
    this._wv = wv;
    this.activeTabId = id;
    this.activateTab(id);
    // Asignar src DESPUÉS de estar en el DOM (el patrón objetivo de esta
    // recreación: setAttribute tras appendChild — antes no navegaba).
    wv.setAttribute('src', url || 'about:blank');
    this.renderTabs();
    this.writeTabs();
    return id;
  },

  bindSessionWebview(wv, id) {
    // Filtros cosméticos del adblock: el panel de sesiones usa webviews
    // propios, así que bindWebviewToTab no los cubre. Misma inyección que la
    // pestaña normal (app.js), en dom-ready de cada documento.
    wv.addEventListener('dom-ready', () => {
      try { applyCosmeticFiltersToWebview(wv); } catch {}
    });
    wv.addEventListener('did-navigate', () => {
      if (this.activeTabId === id) {
        this.syncUrlbar();
        this.addHistory(this.currentUrl(), this.currentTitle());
        this.renderTabs();
        this.writeTabs();
        if (!$('permissions-panel')?.classList.contains('collapsed')) {
          syncPermissionsDomainField();
          renderPermissionsList();
        }
      }
    });
    wv.addEventListener('did-navigate-in-page', () => {
      if (this.activeTabId === id) {
        this.syncUrlbar();
        if (!$('permissions-panel')?.classList.contains('collapsed')) syncPermissionsDomainField();
      }
    });
    wv.addEventListener('page-title-updated', (e) => {
      const tab = this.tabs.find(t => t.id === id);
      if (tab && e.title) { tab.title = e.title; this.renderTabs(); this.writeTabs(); }
    });
  },

  activateTab(id) {
    if (!this.tabs.some(t => t.id === id)) return;
    this.activeTabId = id;
    this.tabs.forEach(t => { if (t.wv) t.wv.style.display = t.id === id ? 'inline-flex' : 'none'; });
    this._wv = this.tabs.find(t => t.id === id)?.wv || null;
    this.renderTabs();
    this.syncUrlbar();
    if (!$('permissions-panel')?.classList.contains('collapsed')) syncPermissionsDomainField();
  },

  closeTab(id) {
    const idx = this.tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    const [removed] = this.tabs.splice(idx, 1);
    this.destroyTabWebview(removed.wv);
    if (this.tabs.length === 0) {
      this._wv = null;
      this.activeTabId = null;
      this.addTab(this.settings.home || 'https://duckduckgo.com/');
      return;
    }
    if (this.activeTabId === id) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activateTab(next.id);
    } else {
      this.renderTabs();
    }
    this.writeTabs();
  },

  newTab() { if (this.activeId) this.addTab(this.settings.home || 'https://duckduckgo.com/'); },

  renderTabs() {
    const bar = document.getElementById('session-tabbar');
    if (!bar) return;
    bar.innerHTML = this.tabs.map(t => `
      <div class="session-tab${t.id === this.activeTabId ? ' active' : ''}" onclick="Sessions.activateTab(${t.id})" title="${escapeHtml(t.url || '')}">
        <span class="session-tab-title">${escapeHtml(t.title || 'Nueva pestaña')}</span>
        <button class="session-tab-close" onclick="event.stopPropagation();Sessions.closeTab(${t.id})" title="Cerrar pestaña">&#10005;</button>
      </div>`).join('')
      + '<button class="session-tab-add" onclick="Sessions.newTab()" title="Nueva pestaña">+</button>';
  },

  syncUrlbar() {
    const input = document.getElementById('session-urlbar');
    if (input && this._wv) { try { input.value = this._wv.getURL(); } catch {} }
  },

  addHistory(url, title) {
    if (!url || isInternalHistoryUrl(url)) return;
    this.history = this.history.filter(item => item.url !== url);
    this.history.unshift({ url, title: title || url, time: Date.now() });
    this.history = this.history.slice(0, 200);
    this.saveData('history', this.history);
    if (document.getElementById('session-tools')?.classList.contains('open') && this.toolsTab === 'history') this.renderTools();
  },

  toggleBookmark() {
    const url = this.currentUrl();
    if (!url || /^(about|mc|chrome):/i.test(url)) return;
    const index = this.bookmarks.findIndex(item => item.url === url);
    if (index >= 0) this.bookmarks.splice(index, 1);
    else this.bookmarks.unshift({ url, title: this.currentTitle() || url, time: Date.now() });
    this.saveData('bookmarks', this.bookmarks);
    this.renderTools();
  },

  openSaved(url) { if (url && this._wv) { notifyNavIntent(this._wv); this._wv.loadURL(url); } this.closeTools(); },
  removeSaved(kind, index) {
    const list = kind === 'bookmarks' ? this.bookmarks : this.history;
    list.splice(index, 1);
    this.saveData(kind, list);
    this.renderTools();
  },

  toggleTools(tab = 'bookmarks') {
    const tools = document.getElementById('session-tools');
    if (!tools) return;
    if (tools.classList.contains('open') && this.toolsTab === tab) { this.closeTools(); return; }
    tools.classList.add('open');
    this.switchTools(tab);
  },
  closeTools() { document.getElementById('session-tools')?.classList.remove('open'); },
  switchTools(tab) {
    this.toolsTab = tab;
    document.querySelectorAll('[data-session-tool]').forEach(button => button.classList.toggle('active', button.dataset.sessionTool === tab));
    this.renderTools();
  },
  renderTools() {
    const content = document.getElementById('session-tools-content');
    if (!content) return;
    if (this.toolsTab === 'settings') {
      content.innerHTML = `<div class="session-settings">
        <label>Inicio</label><input id="session-home" value="${escapeHtml(this.settings.home || '')}" placeholder="https://duckduckgo.com/"/>
        <button onclick="Sessions.saveSettings()">Guardar</button><span id="session-settings-status"></span>
        <button onclick="Sessions.clearOwnData()">Limpiar datos de MC</button>
      </div>`;
      return;
    }
    const list = this.toolsTab === 'bookmarks' ? this.bookmarks : this.history;
    if (!list.length) { content.innerHTML = `<div class="session-empty">Sin ${this.toolsTab === 'bookmarks' ? 'marcadores' : 'historial'}</div>`; return; }
    content.innerHTML = list.slice(0, 50).map((item, index) => `<div class="session-tool-item">
      <div class="session-tool-item-main" onclick="Sessions.openSaved('${escapeHtml(item.url)}')"><span class="session-tool-item-title">${escapeHtml(item.title || item.url)}</span><span class="session-tool-item-url">${escapeHtml(item.url)}</span></div>
      <button class="session-tool-delete" onclick="Sessions.removeSaved('${this.toolsTab}',${index})" title="Quitar">&#10005;</button>
    </div>`).join('');
  },
  saveSettings() {
    const value = document.getElementById('session-home')?.value.trim();
    if (value) {
      this.settings.home = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'https://' + value;
    }
    this.saveData('settings', this.settings);
    const status = document.getElementById('session-settings-status');
    if (status) { status.textContent = 'Guardado'; status.style.color = 'var(--session-accent)'; }
    this.home();
  },
  clearOwnData() {
    this.bookmarks = [];
    this.history = [];
    this.saveData('bookmarks', this.bookmarks);
    this.saveData('history', this.history);
    try { localStorage.removeItem(this.storageKey('tabs')); } catch {}
    this.renderTools();
  },

  switchTo(id) {
    this.writeTabs();
    this.activeId = id;
    this.loadData();
    this.ensureTabs();
  },

  async createNew() {
    const entry = await mc.sessionsCreate();
    await this.refreshList();
    this.activeId = entry.id;
    const sel = document.getElementById('session-select');
    if (sel) sel.value = entry.id;
    this.ensureTabs();
  },

  async renameCurrent() {
    if (!this.activeId) return;
    const current = this.list.find(s => s.id === this.activeId);
    const name = prompt('Nuevo nombre:', current?.name || '');
    if (name === null) return;
    await mc.sessionsRename(this.activeId, name);
    await this.refreshList();
  },

  async deleteCurrent() {
    if (!this.activeId) return;
    const current = this.list.find(s => s.id === this.activeId);
    if (!confirm(`¿Eliminar la sesión "${current?.name || ''}" y todos sus datos? Esta acción no se puede deshacer.`)) return;
    await mc.sessionsDelete(this.activeId);
    try { localStorage.removeItem(this.storageKey('tabs')); } catch {}
    this.teardownTabs();
    this.activeId = null;
    await this.refreshList();
  },

  async clearData() {
    if (!this.activeId) return;
    if (!confirm('¿Borrar cookies, caché y datos guardados de esta sesión? Vas a perder el login en los sitios abiertos acá (no afecta al resto del navegador).')) return;
    const res = await mc.sessionsClearData(this.activeId);
    if (res?.ok && this._wv) { try { this._wv.loadURL('about:blank'); } catch {} }
  },

  navigate(value) {
    if (!this._wv || !value?.trim()) return;
    let url = value.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      url = /^[^\s.]+\.[^\s]+$/.test(url) ? 'https://' + url : 'https://duckduckgo.com/?q=' + encodeURIComponent(url);
    }
    notifyNavIntent(this._wv);
    try { this._wv.loadURL(url); } catch {}
  },

  home() { if (this._wv) { notifyNavIntent(this._wv); this._wv.loadURL(this.settings.home || 'https://duckduckgo.com/'); } },

  goBack() { if (this._wv) { notifyNavIntent(this._wv); try { this._wv.canGoBack() && this._wv.goBack(); } catch {} } },
  goForward() { if (this._wv) { notifyNavIntent(this._wv); try { this._wv.canGoForward() && this._wv.goForward(); } catch {} } },
  reload() { if (this._wv) { notifyNavIntent(this._wv); try { this._wv.reload(); } catch {} } },

  open(mode = 'panel') {
    this.injectSidebar().then(() => {
      const sb = document.getElementById('session-sidebar');
      if (!sb) return;
      sb.classList.toggle('full', mode === 'full' || localStorage.getItem('mc-session-fullwidth') === '1');
      sb.classList.add('open');
      // close() desmonta los webviews, asi que al reabrir hay que volver a
      // montarlos. ensureTabs() los lee de localStorage (writeTabsFor guardo
      // url y title), con lo que las pestañas vuelven tal cual estaban.
      this.ensureTabs();
    });
  },

  toggleFullwidth() {
    this.injectSidebar().then(() => {
      const sidebar = document.getElementById('session-sidebar');
      if (!sidebar) return;
      const full = !sidebar.classList.contains('full');
      try { localStorage.setItem('mc-session-fullwidth', full ? '1' : '0'); } catch {}
      if (full) {
        sidebar.classList.add('full');
        // El atajo tambien salta con el panel cerrado, y injectSidebar() ya
        // habria montado los webviews: hay que pasar por open() para que queden
        // montados solo si el panel va a ser visible.
        if (!sidebar.classList.contains('open')) this.open('full');
        return;
      }
      sidebar.classList.remove('full');
      if (!sidebar.classList.contains('open')) this.close();
    });
  },

  close() {
    const sb = document.getElementById('session-sidebar');
    if (sb) sb.classList.remove('open');
    // Cerrar el panel significa soltar la sesion: si no, los webviews de la
    // sesion activa siguen montados en #session-webview-wrap y sus procesos
    // renderer quedan vivos aunque no se este usando nada. Antes solo se
    // quitaba la clase 'open' (width: 0) y el webview seguia ahi.
    // Las pestañas se guardan antes en localStorage, asi que no se pierde nada
    // de lo que habia abierto; open() las vuelve a crear con ensureTabs().
    if (this.tabs.length) this.writeTabs();
    this.teardownTabs();
  },

  toggle() {
    const sb = document.getElementById('session-sidebar');
    if (sb && sb.classList.contains('open')) { this.close(); return; }
    this.open();
  }
};
window.Sessions = Sessions;

// ── Chat edge toggle (fallback si módulo AI no cargó) ──
function toggleChatPanel(type) {
  const id = type === 'ai' ? 'ai-sidebar' : type === 'web' ? 'webchat-sidebar' : type === 'wa' ? 'wa-sidebar' : 'perchance-sidebar';
  const sb = document.getElementById(id);
  const btn = document.getElementById('chat-toggle-' + type);
  if (!sb) return;
  const opening = !sb.classList.contains('open');
  sb.classList.toggle('open');
  if (btn) {
    btn.className = 'chat-toggle ' + (opening ? 'open' : 'closed');
    btn.innerHTML = opening ? '&#9654;' : '&#9664;';
    btn.title = opening ? 'Cerrar' : 'Abrir ' + (type === 'ai' ? 'IA (Ctrl+Shift+A)' : type === 'web' ? 'WebChat (Ctrl+Shift+W)' : type === 'wa' ? 'WhatsApp (Ctrl+Shift+Q)' : 'Perchance (Ctrl+Shift+Y)');
  }
}

// MutationObserver: sincroniza botones edge cuando módulos cambian el panel
const chatToggleObserver = new MutationObserver(() => {
  ['ai', 'web', 'wa', 'pch'].forEach(t => {
    const id = t === 'ai' ? 'ai-sidebar' : t === 'web' ? 'webchat-sidebar' : t === 'wa' ? 'wa-sidebar' : 'perchance-sidebar';
    const sb = document.getElementById(id);
    const btn = document.getElementById('chat-toggle-' + t);
    if (sb && btn) {
      const open = sb.classList.contains('open');
      if (open && btn.classList.contains('closed')) { btn.className = 'chat-toggle open'; btn.innerHTML = '&#9654;'; btn.title = 'Cerrar'; }
      if (!open && btn.classList.contains('open')) { btn.className = 'chat-toggle closed'; btn.innerHTML = '&#9664;'; btn.title = 'Abrir ' + (t === 'ai' ? 'IA (Ctrl+Shift+A)' : t === 'web' ? 'WebChat (Ctrl+Shift+W)' : t === 'wa' ? 'WhatsApp (Ctrl+Shift+Q)' : 'Perchance (Ctrl+Shift+Y)'); }
    }
  });
});
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const target = document.getElementById('main') || document.body;
    chatToggleObserver.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }, 1000);
});

// ── panels / webview routing ─────────────────────
let _redirecting = false;
const _panelRedirect = { network:'settings' };
function showPanel(name) {
  if (_panelRedirect[name]) {
    const target = _panelRedirect[name];
    _redirecting = true;
    showPanel(target);
    _redirecting = false;
    const idx = ['network'].indexOf(name);
    if (idx >= 0) {
      setTimeout(() => {
        const details = document.querySelectorAll('#panel-settings details');
        if (details[idx]) details[idx].open = true;
      }, 50);
    }
    return;
  }
  // cookies / privacy abren el panel de permisos y cookies
  if (name === 'cookies' || name === 'privacy') {
    const panel = $('permissions-panel');
    if (panel && panel.classList.contains('collapsed')) togglePermissionsPanel();
    else if (panel) { syncPermissionsDomainField(); renderPermissionsList(); }
    return;
  }
  const p = $('panel-'+name);
  if (p && p.classList.contains('active') && !_redirecting) {
    if (name === 'newtab') return;
    showWebview();
    return;
  }
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  if (p) p.classList.add('active');
  state.currentPanel = name;
  document.querySelectorAll('.tnbtn').forEach(b => b.classList.remove('active'));
  const map = { newtab:0, history:1, reader:2, streams:3, media:4, settings:5, lab:6 };
  const btns = document.querySelectorAll('.tnbtn');
  if (btns[map[name]]) btns[map[name]].classList.add('active');
  // ocultar webview cuando estamos en paneles internos
  stopFailureScene();
  $('webview-container').style.display = 'none';
}

async function openReader() {
  const wv = $('webview-' + state.activeTab);
  const content = $('reader-content');
  const title = $('reader-title');
  const meta = $('reader-meta');
  if (!wv || !wv.getURL || !/^https?:\/\//i.test(wv.getURL())) {
    showPanel('reader');
    title.textContent = 'Modo Reader';
    meta.textContent = 'Abre primero una página web';
    content.className = 'loading';
    content.textContent = 'No hay una página web activa para leer.';
    return;
  }
  showPanel('reader');
  content.className = 'loading';
  content.textContent = 'Extrayendo contenido principal...';
  try {
    const data = await wv.executeJavaScript(`(() => {
      const root = document.querySelector('article, main, [role="main"]') || document.body;
      const clone = root.cloneNode(true);
      clone.querySelectorAll('script,style,nav,aside,form,header,footer,figure,iframe,video,audio,button').forEach(el => el.remove());
      const text = (clone.innerText || '').replace(/\\s+\\n/g, '\\n').replace(/\\n\\s+/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
      return { title: document.title || location.hostname, text: text.slice(0, 100000), url: location.href };
    })()`);
    title.textContent = data.title || 'Modo Reader';
    meta.textContent = data.url || '';
    content.className = data.text ? '' : 'loading';
    content.textContent = data.text || 'No se pudo extraer contenido legible de esta página.';
  } catch (error) {
    content.className = 'loading';
    content.textContent = 'No se pudo extraer el contenido de esta página.';
    addSidebarLog('blocked', '[READER] ' + (error.message || 'error de extracción'));
  }
}

let failureSceneFrame = 0;
let failureSceneTick = 0;

function stopFailureScene() {
  if (failureSceneFrame) cancelAnimationFrame(failureSceneFrame);
  failureSceneFrame = 0;
}

function drawFailureTechnician(ctx, x, y, color, label, tick, working) {
  const bob = Math.sin((tick + x) * 0.07) * 2;
  const toolMotion = working ? Math.sin((tick + x) * 0.22) * 5 : 0;
  ctx.save();
  ctx.translate(x, y + bob);
  ctx.fillStyle = '#151d25';
  ctx.fillRect(-8, 12, 6, 25);
  ctx.fillRect(2, 12, 6, 25);
  ctx.fillStyle = '#080d12';
  ctx.fillRect(-10, 34, 8, 5);
  ctx.fillRect(2, 34, 9, 5);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(-12, -10, 24, 24, 4);
  ctx.fill();
  ctx.fillStyle = '#f0d28d';
  ctx.fillRect(-12, -2, 24, 3);
  ctx.fillStyle = '#142019';
  ctx.font = 'bold 6px monospace';
  ctx.fillText('MC', -5, 2);
  ctx.fillStyle = '#dca77f';
  ctx.beginPath();
  ctx.arc(0, -18, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, -20, 9, Math.PI, 0);
  ctx.fill();
  ctx.fillRect(-10, -21, 20, 3);
  ctx.fillStyle = color;
  if (working) {
    ctx.fillRect(9, -4 + toolMotion, 11, 5);
    ctx.strokeStyle = '#c9d1d9';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(18, -10 + toolMotion);
    ctx.lineTo(29, -21 + toolMotion);
    ctx.stroke();
    ctx.fillStyle = '#f0a14f';
    ctx.fillRect(26, -24 + toolMotion, 7, 6);
  } else {
    ctx.fillRect(-18, -6, 7, 12);
    ctx.fillStyle = '#0c1117';
    ctx.fillRect(-23, -12, 12, 9);
    ctx.fillStyle = '#ff6262';
    ctx.fillRect(-21, -10, 8, 2);
  }
  ctx.fillStyle = '#a7b1b8';
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(label, 0, 50);
  ctx.restore();
}

function drawFailureScene() {
  const overlay = $('connection-failure');
  const canvas = $('failure-canvas');
  if (!overlay || overlay.hidden || !canvas) {
    stopFailureScene();
    return;
  }

  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.max(1, Math.round(bounds.width * pixelRatio));
  const pixelHeight = Math.max(1, Math.round(bounds.height * pixelRatio));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(pixelWidth / 520, 0, 0, pixelHeight / 320, 0, 0);
  const tick = failureSceneTick++;
  const sky = ctx.createLinearGradient(0, 0, 0, 320);
  sky.addColorStop(0, '#111923');
  sky.addColorStop(.68, '#202b31');
  sky.addColorStop(1, '#333a32');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 520, 320);

  ctx.strokeStyle = 'rgba(120,150,153,.2)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= 520; x += 28) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 320); ctx.stroke(); }
  for (let y = 0; y <= 320; y += 28) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(520, y); ctx.stroke(); }

  ctx.fillStyle = '#283b3a';
  ctx.beginPath(); ctx.moveTo(0, 218); ctx.lineTo(80, 154); ctx.lineTo(155, 218); ctx.lineTo(242, 170); ctx.lineTo(330, 220); ctx.lineTo(424, 156); ctx.lineTo(520, 220); ctx.lineTo(520, 320); ctx.lineTo(0, 320); ctx.fill();
  ctx.fillStyle = '#10161b';
  ctx.fillRect(0, 245, 520, 75);
  ctx.strokeStyle = '#ff6262';
  ctx.lineWidth = 3;
  ctx.shadowColor = '#ff6262';
  ctx.shadowBlur = 11;
  ctx.beginPath();
  ctx.moveTo(0, 252); ctx.lineTo(98, 264); ctx.lineTo(172, 247); ctx.lineTo(258, 270); ctx.lineTo(348, 246); ctx.lineTo(435, 263); ctx.lineTo(520, 251);
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.save();
  ctx.translate(260, 160);
  ctx.rotate(.1);
  ctx.fillStyle = '#161d25';
  ctx.strokeStyle = '#73808a';
  ctx.lineWidth = 2;
  ctx.fillRect(-49, -72, 98, 142);
  ctx.strokeRect(-49, -72, 98, 142);
  ctx.fillStyle = '#080d12';
  ctx.fillRect(-39, -58, 78, 42);
  ctx.strokeStyle = '#ff6262';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-24, -49); ctx.lineTo(24, -25); ctx.moveTo(24, -49); ctx.lineTo(-24, -25);
  ctx.stroke();
  ctx.font = 'bold 8px monospace';
  ctx.fillStyle = '#ff8585';
  ctx.textAlign = 'center';
  ctx.fillText('SERVER OFFLINE', 0, -4);
  for (let row = 0; row < 3; row++) {
    const rowY = 8 + row * 21;
    ctx.fillStyle = '#252f38';
    ctx.fillRect(-39, rowY, 78, 15);
    ctx.fillStyle = Math.floor(tick / 10 + row) % 2 ? '#59bd84' : '#ff6262';
    ctx.beginPath();
    ctx.arc(-27, rowY + 7, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.strokeStyle = '#f0a14f';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(176, 92); ctx.quadraticCurveTo(197, 162, 220, 248);
  ctx.stroke();
  if (Math.floor(tick / 6) % 4 === 0) {
    ctx.strokeStyle = '#f4d79d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(214, 229); ctx.lineTo(231, 239); ctx.lineTo(215, 255);
    ctx.stroke();
  }

  drawFailureTechnician(ctx, 148, 232, '#4eb982', 'MC-DEV', tick, false);
  drawFailureTechnician(ctx, 372, 232, '#f0a14f', 'MC-OPS', tick + 30, true);
  ctx.fillStyle = 'rgba(224,231,227,.68)';
  ctx.font = '9px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('MC FIELD TEAM  /  SIGNAL RECOVERY', 14, 304);

  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    failureSceneFrame = requestAnimationFrame(drawFailureScene);
  } else {
    failureSceneFrame = 0;
  }
}

function renderConnectionFailure(wv) {
  const overlay = $('connection-failure');
  const failure = wv && wv.__mcLoadFailure;
  const isVisible = !!failure && wv.id === 'webview-' + state.activeTab && state.currentPanel === 'webview';
  if (!overlay) return;
  overlay.hidden = !isVisible;
  if (!isVisible) {
    stopFailureScene();
    return;
  }

  const targetUrl = failure.url || '';
  $('failure-host').textContent = targetUrl;
  $('failure-host').title = targetUrl;
  $('failure-detail').textContent = failure.description || 'Error de conexión ' + failure.errorCode;
  if (!failureSceneFrame) drawFailureScene();
}

function retryConnectionFailure() {
  const wv = $('webview-' + state.activeTab);
  if (!wv) return;
  wv.__mcLoadFailure = null;
  renderConnectionFailure(wv);
  try { reloadTab(id); } catch {}
}

function showWebview() {
  const tab = state.tabs.find(t => t.id === state.activeTab);
  if (tab && tab.url === 'mc://newtab') { showPanel('newtab'); return; }
  if (tab && tab.url === 'mc://lab') { showPanel('lab'); return; }
  if (tab && tab.url === 'mc://doc') { showPanel('doc'); return; }
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tnbtn').forEach(b => b.classList.remove('active'));
  $('webview-container').style.display = 'block';
  document.querySelectorAll('.tab-webview').forEach(wv => wv.classList.remove('active'));
  const wv = $('webview-' + state.activeTab);
  if (wv) wv.classList.add('active');
  state.currentPanel = 'webview';
  renderConnectionFailure(wv);
  updateBookmarkStar();
}

