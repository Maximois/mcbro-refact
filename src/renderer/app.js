'use strict';
// ════════════════════════════════════════════════
//  MC BROWSER — RENDERER
//  Se comunica con main.js a través de window.mc (preload)
// ════════════════════════════════════════════════

// ── navegación ──────────────────────────────────
function handleUrl(e) {
  if (e.key !== 'Enter') return;
  const v = $('urlinput').value.trim();
  loadUrl(v);
}

function loadUrl(url) {
  if (!url) return;
  if (url === 'mc://newtab') { showPanel('newtab'); $('urlinput').value='mc://newtab'; return; }
  if (url === 'mc://lab') { showPanel('lab'); $('urlinput').value='mc://lab'; return; }
  if (url === 'mc://doc') { showPanel('doc'); $('urlinput').value='mc://doc'; return; }
  let final = url;
  if (url.includes(' ') || (!url.startsWith('http') && !url.startsWith('mc://') && !url.includes('.'))) {
    // Copilot engine removed; default handling uses ENGINES mapping.
    final = ENGINES[state.currentEngine] + encodeURIComponent(url);
  } else if (!url.startsWith('http') && !url.startsWith('mc://')) {
    final = 'https://' + url;
  }
  $('urlinput').value = final;
  updateBookmarkStar();

  // Obtener el webview de la pestaña activa
  const wv = $('webview-' + state.activeTab);
  if (wv) {
    const tab = state.tabs.find(t => t.id === state.activeTab);
    if (tab) {
      const currentTabUrl = tab.url || '';
      const targetIsAuth = /^https?:\/\/(?:accounts\.|login\.|auth\.|oauth\.)/i.test(final) || /\/signin|\/login|\/challenge|\/v3\/signin/i.test(final);
      const currentIsNormal = /^https?:\/\//i.test(currentTabUrl) && !(/^https?:\/\/(?:accounts\.|login\.|auth\.|oauth\.)/i.test(currentTabUrl) || /\/signin|\/login|\/challenge|\/v3\/signin/i.test(currentTabUrl));
      if (targetIsAuth && currentIsNormal) state.authReturnUrls[state.activeTab] = currentTabUrl;
      tab.url = final; tab.title = final.replace(/https?:\/\//,'').split('/')[0];
    }
    $('webview-container').style.display = 'block';
    showWebview();
    // Navegación explícita del usuario: avisar al main para que NO bloquee
    // redirecciones de esta navegación (solo bloquea auto-redirecciones).
    try {
      const wcId = Number(wv.getWebContentsId?.()) || 0;
      if (wcId && typeof mc !== 'undefined' && typeof mc.navIntent === 'function') mc.navIntent({ wcId });
    } catch {}
    try {
      wv.src = final;
    } catch(e){ console.error(e); }
    const te = document.querySelector('#tab-'+state.activeTab+' .tab-title');
    if (te) te.textContent = tab.title;
    addSidebarLog('info', '[NAV] '+ final.replace(/https?:\/\//,'').substring(0,40));
    addHistory(final);
  }
}

// ── webview events ──────────────────────────────
const selectionPreloadPath = new URL('../preload/selection-bridge.js', document.location.href).toString();
// Filtro cosmético (reglas ## del adblock) inyectado en un <webview>. Es
// global para poder usarla también desde el panel de sesiones aisladas
// (sessions.js), que tiene sus propios webviews y se quedaba sin filtrar.
async function applyCosmeticFiltersToWebview(wv) {
  try {
    if (!wv || !mc?.adblockCosmetics) return;
    let pageUrl = '';
    try { pageUrl = wv.getURL(); } catch {}
    if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) return;
    const result = await mc.adblockCosmetics(pageUrl);
    await wv.executeJavaScript(`(() => {
      try {
        const styleId = 'mc-adblock-cosmetics';
        let el = document.getElementById(styleId);
        if (el && el.tagName === 'STYLE') el.remove();
      } catch {}
    })()`).catch(() => {});
    if (result?.ok && result.css) {
      const cssEscaped = result.css
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$/g, '\\$');
      await wv.executeJavaScript(`(() => {
        try {
          const styleId = 'mc-adblock-cosmetics';
          let el = document.getElementById(styleId);
          if (!el || el.tagName !== 'STYLE') {
            el = document.createElement('style');
            el.id = styleId;
            (document.head || document.documentElement || document.body).appendChild(el);
          }
          el.textContent = \`${cssEscaped}\`;
        } catch {}
      })()`).catch(() => {});
    }
  } catch {}
}

function bindWebviewToTab(id, wv) {
  if (!wv) return;
  // Guard anti-duplicación: si este webview ya fue bindeado, no agregar
  // listeners otra vez (si no, se acumulan y disparan MaxListenersExceeded
  // en el WebContents del guest — el navegador se degrada con el tiempo).
  if (wv.dataset.mcBound === '1') return;
  wv.dataset.mcBound = '1';
  let lastPopupUrl = '';
  let lastPopupAt = 0;

  const injectSelectionBridge = () => {
    wv.executeJavaScript(`(() => {
      if (window.__mcSelectionBridge) return true;
      window.__mcSelectionBridge = true;
      document.addEventListener('mouseup', () => {
        const selection = window.getSelection()?.toString()?.trim() || '';
        if (selection.length < 5 || selection.length > 500 || !window.__mcSelectionBridge?.send) return;
        window.__mcSelectionBridge.send(selection);
      }, true);
      return true;
    })()`).catch(() => {});
  };

  const injectCosmeticFilters = () => applyCosmeticFiltersToWebview(wv);

  wv.addEventListener('ipc-message', (event) => {
    if (event.channel === 'mc-history-nav') {
      const direction = event.args?.[0];
      try {
        if (direction === 'back' && wv.canGoBack()) {
          notifyNavIntent(wv);
          wv.goBack();
        } else if (direction === 'forward' && wv.canGoForward()) {
          notifyNavIntent(wv);
          wv.goForward();
        }
      } catch {}
      return;
    }
    if (event.channel !== 'mc-selection') return;
    const text = String(event.args?.[0] || '').trim();
    if (text) window.dispatchEvent(new CustomEvent('mc-selection', { detail: text }));
  });
  wv.addEventListener('dom-ready', () => {
    injectSelectionBridge();
    injectCosmeticFilters();
  });

  // Navegación completa (cambio de página)
  wv.addEventListener('did-navigate', (e) => {
    // El webview quedó en blanco (historial agotado): p. ej. "atrás" desde una
    // búsqueda abierta desde Inicio. En vez de dejar la pantalla en blanco,
    // volver al panel de Inicio.
    if (!e.url || e.url === 'about:blank') {
      if (state.activeTab === id) {
        const tab = state.tabs.find(t => t.id === id);
        if (tab && tab.url !== 'mc://newtab') {
          tab.url = 'mc://newtab';
          tab.title = 'Nueva pestaña';
          const te = document.querySelector('#tab-'+id+' .tab-title');
          if (te) te.textContent = 'Nueva pestaña';
          $('urlinput').value = 'mc://newtab';
          showPanel('newtab');
        }
      }
      return;
    }
    if (isAdUrl(e.url)) {
      addSidebarLog('blocked', '[URL-AD bloqueada en barra] ' + (e.url||'').replace(/https?:\/\//,'').substring(0,60));
      return;
    }
    // Solo actualizar si es la pestaña activa
    if (state.activeTab !== id) return;
    $('urlinput').value = getTabAddress(e.url);
    addHistory(e.url);
    updateBookmarkStar();
    // actualizar tab con dominio
    const tab = state.tabs.find(t => t.id === id);
    if (tab) {
      tab.url = e.url;
      const te = document.querySelector('#tab-'+id+' .tab-title');
      if (te && (!tab.title || tab.title === 'Nueva pestaña' || tab.title === tab.url)) {
        tab.title = e.url.replace(/https?:\/\//,'').split('/')[0];
        te.textContent = tab.title;
      }
    }
    renderCosmeticRules();
    // Panel de permisos abierto: seguir a la página activa. Antes el dominio
    // quedaba congelado al de la página en que se abrió el panel; al navegar
    // por clic en un enlace, atrás/adelante o reload seguía mostrando los
    // recursos y dominios relacionados de la página anterior.
    try {
      const permPanel = document.getElementById('permissions-panel');
      if (permPanel && !permPanel.classList.contains('collapsed') && typeof refreshPermissionsForActivePage === 'function') {
        refreshPermissionsForActivePage();
      }
    } catch {}
  });

  // Navegación interna (SPA, hash, history.pushState)
  wv.addEventListener('did-navigate-in-page', (e) => {
    if (!e.url || e.url === 'about:blank') return;
    if (isAdUrl(e.url)) {
      addSidebarLog('blocked', '[URL-AD (in-page) bloqueada en barra] ' + (e.url||'').replace(/https?:\/\//,'').substring(0,60));
      return;
    }
    if (state.activeTab !== id) return;
    // Solo actualizar si es mismo origen que la URL actual
    try {
      const current = $('urlinput').value;
      if (current && current !== 'mc://newtab') {
        const curHost = new URL(current).hostname;
        const newHost = new URL(e.url).hostname;
        if (curHost !== newHost) return; // diferente origen = probable ad redirect
      }
    } catch {}
    $('urlinput').value = getTabAddress(e.url);
    addHistory(e.url);
    updateBookmarkStar();
    renderCosmeticRules();
  });

  wv.addEventListener('new-window', (e) => {
    if (!e.url || e.url === 'about:blank') return;
    try {
      const host = new URL(e.url).hostname.toLowerCase();
      const authDomains = ['x.com', 'twitter.com', 'x.ai', 'google.com', 'googleusercontent.com', 'grok.com', 'accounts.google.com', 'oauth.googleusercontent.com'];
      const isAuth = authDomains.some(domain => host === domain || host.endsWith('.' + domain));
      if (isAuth) {
        e.preventDefault();
        addTab(e.url, null, true);
        return;
      }
      const currentUrl = wv.getURL();
      const sameSite = (() => {
        try {
          const cur = new URL(currentUrl);
          const pop = new URL(e.url);
          if (!/^https?:$/.test(cur.protocol) || !/^https?:$/.test(pop.protocol)) return false;
          return baseDomain(cur.hostname) === baseDomain(pop.hostname);
        } catch { return false; }
      })();
      if (!sameSite) {
        addSidebarLog('blocked', '[Popup externo bloqueado] ' + (e.url||'').replace(/https?:\/\//,'').substring(0,60));
        return;
      }
      const now = Date.now();
      if (e.url === lastPopupUrl && now - lastPopupAt < 1500) return;
      lastPopupUrl = e.url;
      lastPopupAt = now;
      e.preventDefault();
      addTab(e.url, null, true);
    } catch {
      // Si no se puede analizar la URL, no abrir pestañas de terceros
      return;
    }
  });

  wv.addEventListener('page-title-updated', (e) => {
    const tab = state.tabs.find(t => t.id === id);
    if (tab) {
      tab.title = e.title || tab.title;
      const te = document.querySelector('#tab-'+id+' .tab-title');
      if (te) te.textContent = tab.title;
    }
  });

  wv.addEventListener('did-finish-load', () => {
    renderSidebarStreams();
  });

  wv.addEventListener('did-start-loading', () => {
    wv.__mcLoadFailure = null;
    if (state.activeTab === id) renderConnectionFailure(wv);
    if (state.activeTab !== id) return;
    const shield = $('shield-icon');
    if (shield) shield.textContent = '⏳';
  });

  const onStop = () => {
    if (state.activeTab !== id) return;
    const shield = $('shield-icon');
    if (shield) shield.textContent = '🛡';
  };
  wv.addEventListener('did-stop-loading', onStop);
  wv.addEventListener('destroyed', () => {
    try { wv.removeEventListener('did-stop-loading', onStop); } catch {}
  });

  wv.addEventListener('did-fail-load', (e)=>{
    if (e.errorCode === -3 || e.isMainFrame === false) return;
    const failedUrl = e.validatedURL || wv.getURL();
    if (!/^https?:\/\//i.test(failedUrl || '')) return;
    wv.__mcLoadFailure = { url: failedUrl, description: e.errorDescription || '', errorCode: e.errorCode };
    renderConnectionFailure(wv);
    if (state.activeTab !== id) return;
    addSidebarLog('blocked', '[ERR] '+ (e.errorDescription || e.errorCode));
    const shield = $('shield-icon');
    if (shield) shield.textContent = '🛡';
  });
}

// ── tabs ────────────────────────────────────────
function getTabAddress(url) {
  return /^data:text\/html/i.test(url || '') ? 'mc:player' : (url || 'mc://newtab');
}

function addTab(url, pageUrl, isPopup) {
  state.tabCounter++;
  const id = state.tabCounter;
  state.tabs.push({ id, title: 'Nueva pestaña', url: url || 'mc://newtab', pageUrl: pageUrl || '', isPopup: !!isPopup, popupAt: isPopup ? Date.now() : 0 });
  const bar = $('tabbar');
  const btn = $('newtab-btn');
  const colors = ['var(--accent)','var(--accent2)','var(--warn)','var(--danger)','var(--info)'];
  const col = colors[id % colors.length];
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.id = 'tab-' + id;
  tab.onclick = () => switchTab(id);
  tab.innerHTML = '<div class="tab-favicon" style="background:'+col+';border-radius:50%;"></div>'
                + '<span class="tab-title">Nueva pestaña</span>'
                + '<span class="tab-close" onclick="closeTab(event,'+id+')">&#215;</span>';
  bar.insertBefore(tab, btn);

  // Crear webview para esta pestaña
  const container = $('webview-container');
  const wv = document.createElement('webview');
  wv.id = 'webview-' + id;
  wv.className = 'tab-webview';
  wv.setAttribute('partition', 'persist:mc');
  wv.setAttribute('preload', selectionPreloadPath);
  wv.setAttribute('allow', 'autoplay; media; encrypted-media; fullscreen');
  wv.setAttribute('allowpopups', '');
  container.appendChild(wv);
  bindWebviewToTab(id, wv);
  // Marcar que addTab ya inició la navegación de este webview, para que
  // switchTab() no la pise con un segundo wv.src (que aborta la primera).
  wv.dataset.mcNav = '1';
  if (url && pageUrl && /^https?:\/\//i.test(url) && /^https?:\/\//i.test(pageUrl)) {
    notifyNavIntent(wv);
    wv.loadURL(url, { httpReferrer: pageUrl }).catch(() => {});
  } else {
    wv.setAttribute('src', url || 'about:blank');
  }

  switchTab(id);
}

function switchTab(id) {
  state.activeTab = id;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const el = $('tab-'+id);
  if (el) el.classList.add('active');

  const tab = state.tabs.find(t => t.id === id);
  if (!tab) return;
  $('urlinput').value = getTabAddress(tab.url);
  if (tab.url === 'mc://newtab') {
    showPanel('newtab');
    // showPanel ya oculta el webview-container
  } else {
    // Usar showWebview para ocultar paneles y mostrar el webview activo
    showWebview();
    // Si el webview está en about:blank y la tab tiene una URL, cargarla.
    // Solo si NO hay una navegación en curso: addTab() ya disparó la carga
    // (loadURL o src), y al volver a escribir wv.src aquí se aborta la
    // primera con ERR_ABORTED (la navegación queda "a medias").
    const wv = $('webview-' + id);
    // addTab() ya dejó marcada la navegación (loadURL/src): no volver a
    // cargar aquí o se aborta la primera con ERR_ABORTED (navegación "a
    // medias"). Solo cargar si el webview nunca navegó y no hay carga en curso.
    if (wv && !wv.dataset.mcNav && !wv.isLoading() && (wv.getURL() === 'about:blank' || !wv.getURL()) && tab.url !== 'mc://newtab' && tab.url !== 'mc://lab' && tab.url !== 'mc://doc') {
      wv.src = tab.url;
    }
    // Actualizar reglas cosméticas para el dominio de la pestaña activa
    renderCosmeticRules();
  }
}

function closeTab(e, id) {
  if (e && e.stopPropagation) e.stopPropagation();
  if (state.tabs.length <= 1) return;
  state.tabs = state.tabs.filter(t => t.id !== id);
  const el = $('tab-'+id);
  if (el) el.remove();
  // Eliminar el webview asociado
  const wv = $('webview-' + id);
  if (wv) {
    let webContentsId = 0;
    try { webContentsId = Number(wv.getWebContentsId?.()) || 0; } catch {}
    if (webContentsId && typeof mc !== 'undefined' && typeof mc.destroyWebview === 'function') mc.destroyWebview(webContentsId).catch(() => {});
    try { wv.removeAttribute('src'); } catch {}
    wv.remove();
  }
  if (state.activeTab === id) switchTab(state.tabs[state.tabs.length-1].id);
}

// ── recarga ─────────────────────────────────────
function isYouTubePage(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'youtube.com' || h.endsWith('.youtube.com')
        || h === 'youtube-nocookie.com' || h.endsWith('.youtube-nocookie.com');
  } catch { return false; }
}

// En YouTube, wv.reload() reutiliza el guest webContents y cada recarga deja
// ~28 MB de memoria nativa sin liberar (decodificadores de video y capas de
// Blink), que no se recuperan forzando GC ni limpiando la caché HTTP: solo
// destruyendo y recreando el guest deja la memoria plana. Ese estado
// se acumulaba en el renderer y por eso disparaba la RAM al recargar.
function hardReloadTab(id) {
  const tab = state.tabs.find(t => t.id === id);
  const old = $('webview-' + id);
  if (!tab || !old) return;
  let url = '';
  try { url = old.getURL() || tab.url || ''; } catch {}
  if (!/^https?:\/\//i.test(url)) { try { old.reload(); } catch {} return; }

  let webContentsId = 0;
  try { webContentsId = Number(old.getWebContentsId?.()) || 0; } catch {}
  if (webContentsId && typeof mc !== 'undefined' && typeof mc.destroyWebview === 'function') {
    mc.destroyWebview(webContentsId).catch(() => {});
  }
  try { old.removeAttribute('src'); } catch {}
  try { old.remove(); } catch {}

  const wv = document.createElement('webview');
  wv.id = 'webview-' + id;
  wv.className = 'tab-webview';
  wv.setAttribute('partition', 'persist:mc');
  wv.setAttribute('preload', selectionPreloadPath);
  wv.setAttribute('allow', 'autoplay; media; encrypted-media; fullscreen');
  wv.setAttribute('allowpopups', '');
  $('webview-container').appendChild(wv);
  bindWebviewToTab(id, wv);
  wv.dataset.mcNav = '1';
  wv.setAttribute('src', url);
  tab.url = url;
  if (state.activeTab === id) switchTab(id);
}

function reloadTab(id) {
  const wv = $('webview-' + id);
  if (!wv || typeof wv.reload !== 'function') return;
  let url = '';
  try { url = wv.getURL() || ''; } catch {}
  if (isYouTubePage(url)) { hardReloadTab(id); return; }
  try { notifyNavIntent(wv); wv.reload(); } catch {}
}

// ── new tab page ────────────────────────────────
function setEngine(eng, btn) {
  state.currentEngine = eng;
  document.querySelectorAll('.nt-engine-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}
function ntSearchKey(e) { if (e.key === 'Enter') ntSearchBtn(); }
function ntSearchBtn() {
  const q = $('nt-input').value.trim();
  if (q) loadUrl(q);
}

// ── Tamaños de la página de inicio (Config → Tamaños) ──
const NT_SCALES = { x1: 1, x2: 1.5, x4: 2, x8: 2.5 };
async function updateNtSize(key, value) {
  try { state.cfg = await mc.updateCfg({ [key]: value }); } catch {}
  applyNtSizes();
}
function applyNtSizes() {
  const page = $('newtab-page');
  if (!page) return;
  const s = state.cfg || {};
  page.style.setProperty('--nt-search-scale', NT_SCALES[s.ntSearchSize] || 1);
  page.style.setProperty('--nt-icon-scale',   NT_SCALES[s.ntIconSize]   || 1);
  page.style.setProperty('--nt-logo-scale',   NT_SCALES[s.ntLogoSize]   || 1);
  page.style.setProperty('--nt-stats-scale',  NT_SCALES[s.ntStatsSize]  || 1);
  if ($('nt-size-search')) $('nt-size-search').value = s.ntSearchSize || 'x1';
  if ($('nt-size-icons'))  $('nt-size-icons').value  = s.ntIconSize   || 'x1';
  if ($('nt-size-logo'))   $('nt-size-logo').value   = s.ntLogoSize   || 'x1';
  if ($('nt-size-stats'))  $('nt-size-stats').value  = s.ntStatsSize  || 'x1';
}

// ── Tamaño del texto de la interfaz (Config → Tamaño del texto) ──
const UI_TEXT_SCALES = { x1: '13px', x2: '14px', x3: '15px', x4: '16px' };
async function updateUiTextSize(value) {
  try { state.cfg = await mc.updateCfg({ uiTextSize: value }); } catch {}
  applyUiTextSize();
}
function applyUiTextSize() {
  const size = UI_TEXT_SCALES[state.cfg?.uiTextSize] || '13px';
  document.documentElement.style.setProperty('--ui-font-size', size);
  if ($('ui-text-size')) $('ui-text-size').value = state.cfg?.uiTextSize || 'x1';
}

window.addEventListener('mc-selection', (event) => {
  const text = String(event.detail || '').trim();
  const ai = window.AI || (typeof AI !== 'undefined' ? AI : null);
  if (!text || !ai) return;
  const sb = document.getElementById('ai-sidebar');
  if (sb && !sb.classList.contains('open') && typeof ai.toggle === 'function') ai.toggle();
  setTimeout(() => {
    if (typeof ai.send === 'function') ai.send(`Sobre este texto seleccionado: "${text.slice(0, 500)}"\n\nExplicame, analizame, o lo que consideres relevante.`);
  }, 300);
});

// ── sidebar log ─────────────────────────────────
// ── keyboard ────────────────────────────────────
document.addEventListener('keydown', e => {
  const k = e.key;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && k === 'l') { e.preventDefault(); $('urlinput').focus(); $('urlinput').select(); }
  if (mod && !e.shiftKey && (k === 'n' || k === 'N')) { e.preventDefault(); Sessions.open('panel'); return; }
  if (mod && !e.shiftKey && (k === 'm' || k === 'M')) { e.preventDefault(); Sessions.open('full'); return; }
  if (mod && e.shiftKey && (k === 'l' || k === 'L')) { e.preventDefault(); addTab('mc://lab'); }
  if (mod && k === 't') { e.preventDefault(); addTab(); }
  if (mod && k === 'w') { e.preventDefault(); closeTab({stopPropagation:()=>{}}, state.activeTab); }
  if (mod && k === 'r') { e.preventDefault(); reloadPage(); }
  if (k === 'F5') { e.preventDefault(); reloadPage(); }
  if (k === 'F11') { e.preventDefault(); if (document.fullscreenElement || document.webkitFullscreenElement) { document.exitFullscreen?.() || document.webkitExitFullscreen?.(); } else { document.documentElement.requestFullscreen?.() || document.documentElement.webkitRequestFullscreen?.(); } }
  if ((k === 'F12') || (mod && e.shiftKey && (k === 'i' || k === 'I'))) {
    e.preventDefault();
    const wv = $('webview-' + state.activeTab);
    if (wv && wv.openDevTools) wv.openDevTools();
  }

  // ── Atajos de teclado para paneles (Ctrl+Shift+<tecla>) ──
  if (mod && e.shiftKey) {
    const kk = k.toLowerCase();
    switch (kk) {
      case 'b': // Marcadores
        e.preventDefault(); toggleBookmarksPanel(); break;
      case 's': // Sidebar (privacidad/estadísticas)
        e.preventDefault(); toggleSidebar(); break;
      case 'x': // Recursos / Extractor
        e.preventDefault(); openResourceExtractor(); break;
      case 'h': // Historial y Descargas
        e.preventDefault(); toggleUtilityPanel(); break;
      case 'p': // Permisos y Cookies
        e.preventDefault(); togglePermissionsPanel(); break;
      case 'a': // Panel IA
        e.preventDefault();
        if (window.AI && typeof AI.toggle === 'function') AI.toggle();
        else toggleChatPanel('ai');
        break;
      case 'w': // WebChat
        e.preventDefault();
        if (window.WebChat && typeof WebChat.toggle === 'function') WebChat.toggle();
        else toggleChatPanel('web');
        break;
      case 'm': // Sesión aislada en modo completo
        e.preventDefault();
        Sessions.toggleFullwidth();
        break;
      case 'q': // WhatsApp Web
        e.preventDefault();
        if (window.WhatsAppChat && typeof WhatsAppChat.toggle === 'function') WhatsAppChat.toggle();
        else toggleChatPanel('wa');
        break;
      case 'n': // Sesiones aisladas
        e.preventDefault();
        if (window.Sessions && typeof Sessions.toggle === 'function') Sessions.toggle();
        break;
      case 'e': // Modo Reader
        e.preventDefault(); openReader(); break;
      case 'g': // Laboratorio Web
        e.preventDefault(); showPanel('lab'); break;
      case ',': // Configuración
        e.preventDefault(); showPanel('settings'); break;
      case 'n': // Inicio / Nueva pestaña
        e.preventDefault(); showPanel('newtab'); break;
      case 'y': // Perchance
        e.preventDefault();
        if (window.PerchancePanel && typeof PerchancePanel.toggle === 'function') PerchancePanel.toggle();
        else toggleChatPanel('pch');
        break;
    }
  }
});

// ── Panel de Perchance: mini-navegador en sidebar (modules/perchance-panel/renderer.js) ──

// ════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════

(async function init() {
  // Cargar historial persistido antes de cualquier otra cosa
  await loadHistoryLS();
  renderHistory();
  loadBgSettings();
  loadShortcuts();
  loadBookmarks();
  updateBookmarkStar();
  // Cargar historial persistente de descargas
  loadDownloadsLS();
  renderPersistedDownloads();

  // Crear webview para la primera pestaña
  const firstTab = state.tabs[0];
  if (firstTab) {
    const container = $('webview-container');
    const wv = document.createElement('webview');
    wv.id = 'webview-' + firstTab.id;
    wv.className = 'tab-webview';
    wv.setAttribute('partition', 'persist:mc');
    wv.setAttribute('preload', selectionPreloadPath);
    wv.setAttribute('src', 'about:blank');
    wv.setAttribute('allow', 'autoplay; media; encrypted-media; fullscreen');
    wv.setAttribute('allowpopups', '');
    // No se establece display inline; la clase .tab-webview controla la visibilidad
    container.appendChild(wv);
    bindWebviewToTab(firstTab.id, wv);
  }

  bindDownloadEvents();

  // events from main
  mc.on('req-blocked', d => {
    if (d.resourceType === 'script' && d.url) {
      state.blockedScripts = [...state.blockedScripts.filter(item => item.url !== d.url), { url: d.url, blocked: d.blocked === true }].slice(-200);
      renderSiteScripts();
    }
    const lbl = (d.type||'request').toUpperCase();
    const color = d.type === 'request' ? 'var(--accent)' : 'var(--danger)';
    addSidebarLog(d.type === 'request' ? 'info' : 'blocked', '['+lbl+'] '+ (d.url.replace(/https?:\/\//,'').split('/')[0]));
    addReqLog(d.type || 'request', color, d.msg || d.url);
  });
  mc.on('media-detected', d => {
    if (/\.ts(\?|#|$)/i.test(d.url || '')) return;
    addMediaItem(d);
    addStreamItem({ url: d.url, via: 'request:' + (d.type || 'media'), pageUrl: d.pageUrl || getActivePageUrl(), type: d.type || 'MP4' });
    addSidebarLog('modified', '[MEDIA] ' + d.type + ' detectado (' + d.count + ')');
    addReqLog('media', 'var(--warn)', '[MEDIA '+d.type+'] '+d.url);
  });
  mc.on('cookie-intercepted', d => {
    addCookieLog(d.action, d.domain, d.cookie);
    if (d.action === 'blocked') addSidebarLog('blocked', '[CK-BLOQ] '+d.domain);
  });
  const notificationPermissionToasts = new Map();
  mc.on('notification-permission-request', request => {
    const requestId = String(request?.requestId || '');
    const domain = String(request?.domain || 'este sitio');
    if (!requestId || notificationPermissionToasts.has(requestId)) return;
    let stack = document.getElementById('notification-permission-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'notification-permission-stack';
      stack.setAttribute('aria-live', 'assertive');
      document.body.appendChild(stack);
    }
    const toast = document.createElement('section');
    toast.className = 'notification-permission-toast';
    toast.setAttribute('role', 'alertdialog');
    toast.setAttribute('aria-label', 'Permiso de notificaciones');
    const title = document.createElement('div');
    title.className = 'notification-permission-title';
    title.textContent = 'Permiso de notificaciones';
    const message = document.createElement('div');
    message.className = 'notification-permission-message';
    message.textContent = domain + ' quiere enviarte notificaciones.';
    const actions = document.createElement('div');
    actions.className = 'notification-permission-actions';
    const deny = document.createElement('button');
    deny.type = 'button';
    deny.className = 'notification-permission-deny';
    deny.textContent = 'Bloquear';
    const allow = document.createElement('button');
    allow.type = 'button';
    allow.className = 'notification-permission-allow';
    allow.textContent = 'Permitir';
    const respond = decision => {
      const pending = notificationPermissionToasts.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      notificationPermissionToasts.delete(requestId);
      toast.remove();
      mc.respondNotificationPermission(requestId, decision);
    };
    deny.addEventListener('click', () => respond(false));
    allow.addEventListener('click', () => respond(true));
    actions.append(deny, allow);
    toast.append(title, message, actions);
    stack.appendChild(toast);
    const timer = setTimeout(() => respond(null), 43000);
    notificationPermissionToasts.set(requestId, { timer });
    deny.focus();
  });
  mc.on('webview-fullscreen', d => {
    // Solo aplica si el evento viene de la pestaña activa (una pestaña de
    // fondo no debería poder tapar toda la ventana).
    const wv = $('webview-' + state.activeTab);
    let activeWcId = 0;
    try { activeWcId = wv && wv.getWebContentsId ? wv.getWebContentsId() : 0; } catch {}
    if (d.wcId !== activeWcId) return;
    document.body.classList.toggle('mc-html-fullscreen', !!d.fullscreen);
  });
  mc.on('stats-update', s => { state.stats = s; refreshStats(); });
  mc.on('auth-session-updated', () => {
    // No forzar el regreso a la página anterior mientras Google/X están en
    // medio del OAuth. Esa re-dirección interrumpe la petición de login del
    // segundo usuario y provoca el 400. Dejar que el provider complete el flujo
    // es la única acción segura.
  });
  mc.on('new-tab',      ()=> addTab());
  mc.on('external-url', url => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) loadUrl(url);
  });
  mc.on('open-new-tab',  url => addTab(url));
  mc.on('page-extract-results', showExtractor);
  mc.on('ai-element-selected', element => {
    const ai = window.AI || (typeof AI !== 'undefined' ? AI : null);
    if (!ai) {
      addSidebarLog('blocked', '[AI] Módulo IA no disponible para diagnosticar el elemento');
      return;
    }
    if (element?.error) {
      if (!document.getElementById('ai-sidebar')?.classList.contains('open')) ai.toggle();
      setTimeout(() => ai.appendMsg('system', 'No se pudo investigar el elemento: ' + element.error), 300);
      return;
    }
    const details = JSON.stringify(element, null, 2);
    if (!document.getElementById('ai-sidebar')?.classList.contains('open')) ai.toggle();
    const isAdblock = element?.mode === 'adblock-diagnosis';
    const prompt = isAdblock
      ? `Diagnóstico de elemento molesto para pulir el adblock de MC Browser.

Analiza SOLO con los datos JSON adjuntos (DOM, estilos, recursos, señales sospechosas). Responde en español con esta estructura:

1. **Qué es** — tipo de elemento, función probable (banner, overlay, popup, tracker, widget, anti-adblock, etc.)
2. **Cómo está incrustado** — iframe/shadow DOM, scripts cercanos, atributos clave, estilos que lo ocultan o flotan
3. **Riesgo / molestia** — tracking, click fraud, redirección, autoplay, etc.
4. **Bloqueo recomendado** — propón reglas concretas para MC Browser:
   - dominio/URL a bloquear en webRequest (si aplica)
   - selector CSS cosmetic (si aplica)
   - regla tipo uBlock/AdGuard si encaja (\`||dominio^\`, \`##selector\`, etc.)
5. **Prueba** — cómo verificar que el bloqueo no rompe contenido legítimo

No ejecutes código. Si falta información, dilo y sugiere qué inspeccionar en DevTools.

Datos del elemento:
${details}`
      : `Investiga este elemento del DOM de la página. Explica qué función cumple, qué contenido representa, si contiene enlaces, formularios, publicidad, tracking o datos sensibles, y qué riesgos o acciones relevantes ves. No ejecutes código ni supongas información que no esté en los datos.

${details}`;
    setTimeout(() => ai.send(prompt), 300);
  });
  mc.on('cosmetic-block-result', result => {
    if (result?.ok) {
      addSidebarLog('blocked', '[ELEMENT] Bloqueado: ' + (result.rule || result.selector || 'selector'));
      if (state.cfg) {
        state.cfg.userCosmeticRules = Array.isArray(state.cfg.userCosmeticRules) ? state.cfg.userCosmeticRules : [];
        if (result.rule && !state.cfg.userCosmeticRules.includes(result.rule)) {
          state.cfg.userCosmeticRules.push(result.rule);
        }
      }
      renderCosmeticRules();
      reapplyCosmeticFilters();
    } else {
      addSidebarLog('blocked', '[ELEMENT] No se pudo bloquear: ' + (result?.error || 'error'));
    }
  });
  mc.on('cosmetic-unblock-result', result => {
    if (result?.ok && result.rule && state.cfg) {
      state.cfg.userCosmeticRules = (state.cfg.userCosmeticRules || []).filter(r => r !== result.rule);
      renderCosmeticRules();
      addSidebarLog('allowed', '[ELEMENT] Desbloqueado: ' + result.rule);
    }
  });
  mc.on('close-tab',    ()=> closeTab({stopPropagation(){}}, state.activeTab));
  mc.on('clear-all',   ()=> clearAll());
  mc.on('show-media',  ()=> { toggleDlOverlay(); });
  mc.on('export-session-menu', ()=> exportSession());
  mc.on('import-session-menu', ()=> importSession());
  mc.on('ua-rotated', d => { addSidebarLog('modified','[UA] Rotado → '+d.ua); });
  mc.on('ytdlp-log', msg => {
    addSidebarLog('info', '[yt-dlp] ' + msg);
    const ytLog = $('ytdlp-log');
    if (ytLog) ytLog.innerHTML += escapeHtml(msg) + '<br>';
  });

  // load initial state
  state.cfg   = await mc.getCfg();
  state.stats = await mc.getStats();
  syncCfgToUI();
  refreshStats();
  updateProtections();

  // sysinfo
  const info = await mc.getSysinfo();
  setText('ab-platform', info.platform+' '+info.arch);
  setText('ab-electron', info.electron);
  setText('ab-chrome',   info.chrome);
  setText('ab-node',     info.node);
  setText('ab-mem',      info.mem);
  setText('ab-datadir',  info.dataDir);
  const ab = info.build;
  if (ab && ab.version) setText('ab-version', ab.version);
  $('dl-dir').value = info.dlDir;

  // Real values for fingerprinting
  const real = await mc.getRealValues();
  const coresVal = $('val-cores');
  const memVal = $('val-memory');
  const pluginsVal = $('val-plugins');
  if (coresVal) coresVal.textContent = real.realCores || 'N/A';
  if (memVal) memVal.textContent = (real.realMemory || 'N/A') + ' GB';
  if (pluginsVal) pluginsVal.textContent = real.realPlugins || '0';

  // frame-less window: sync maximize button
  updateMaxBtn();
  window.addEventListener('resize', updateMaxBtn);
  // existing media
  const m = await mc.getMedia();
  m.forEach(addMediaItem);

  // clock
  tickClock();
  setInterval(tickClock, 1000);

  // boot logs
  ['[BOOT] MC Browser iniciado', '[BOOT] Motor de privacidad activo', '[BOOT] Listas: ads + trackers + crypto', '[DoH] DNS cifrado: '+(state.cfg.dohServer||'cloudflare'), '[FP] Anti-fingerprint activado'].forEach((m,i) =>
    setTimeout(()=>addSidebarLog('info', m), i*150)
  );

  checkYtDlpStatus();
})();

