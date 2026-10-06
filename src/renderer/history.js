'use strict';
// ── historial ───────────────────────────────────
function saveHistoryLS() {
  try { localStorage.setItem('mc_history', JSON.stringify(state.history)); } catch {}
}
async function loadHistoryLS() {
  try {
    const nativeHistory = await mc.historyList();
    if (nativeHistory.length) {
      state.history = nativeHistory.filter(entry => !isInternalHistoryUrl(entry?.url));
      saveHistoryLS();
      return;
    }
    const raw = localStorage.getItem('mc_history');
    const legacy = raw ? JSON.parse(raw) : [];
    if (Array.isArray(legacy) && legacy.length) {
      for (const entry of legacy.filter(item => !isInternalHistoryUrl(item?.url))) await mc.historyAdd(entry);
      state.history = await mc.historyList();
      saveHistoryLS();
    }
  } catch {
    try {
      const raw = localStorage.getItem('mc_history');
      if (raw) {
        state.history = JSON.parse(raw).filter(item => !isInternalHistoryUrl(item?.url));
        saveHistoryLS();
      }
    } catch {}
  }
}

function isInternalHistoryUrl(url) {
  return /^(?:data:text\/html|blob:|file:|about:|mc:|chrome:)/i.test(String(url || ''));
}

function addHistory(url) {
  if (!url || isInternalHistoryUrl(url)) return;
  const last = state.history[0];
  if (last && last.url === url) return;
  state.history.unshift({ url, title: url.replace(/https?:\/\//,'').split('/')[0], ts: Date.now() });
  if (state.history.length > 2000) state.history.length = 2000;
  renderHistory();
  mc.historyAdd(state.history[0]).catch(() => {});
  saveHistoryLS();
}
function renderHistory() {
  const lists = [$('history-list'), $('utility-history-list')].filter(Boolean);
  if (!lists.length) return;
  if (!state.history.length) {
    const empty = '<div style="color:var(--muted);font-size: 0.923rem;text-align:center;padding:24px;border:1px dashed var(--border);border-radius:var(--radius);">&#128203; Sin historial aún — navega para ver tus sitios visitados</div>';
    lists.forEach(list => { list.innerHTML = empty; });
    return;
  }
  const markup = state.history.map(h => {
    const t = new Date(h.ts).toLocaleTimeString();
    const safeUrl = String(h.url).replace(/"/g,'&quot;');
    return '<div style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px;align-items:center;cursor:pointer;" onclick="loadUrl(\''+safeUrl.replace(/'/g,"\\'")+'\')">'
         + '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;"><b>'+h.title+'</b><div style="color:var(--muted);font-size: 0.769rem;">'+safeUrl+'</div></div>'
         + '<span style="color:var(--muted);font-size: 0.769rem;">'+t+'</span></div>';
  }).join('');
  lists.forEach(list => { list.innerHTML = markup; });
}
async function clearHistory(mode = 'history') {
  const keepSessions = !!(
    document.getElementById('keep-sessions-clear')?.checked ||
    document.getElementById('keep-sessions-clear2')?.checked ||
    document.getElementById('keep-sessions-clear3')?.checked
  );

  const preset = {
    history: { history: true, cache: false, cookies: false, keepSessions },
    'history-cache': { history: true, cache: true, cookies: false, keepSessions },
    'history-cache-cookies': { history: true, cache: true, cookies: true, keepSessions },
  }[mode] || { history: true, cache: false, cookies: false, keepSessions };

  if (preset.history) {
    state.history = [];
    renderHistory();
  }

  const result = await mc.clearData(preset).catch(() => ({ ok: false }));
  if (result && result.ok) {
    try { localStorage.removeItem('mc_history'); } catch {}
    addSidebarLog('allowed', '[CLEAR] ' + (mode === 'history' ? 'historial' : mode === 'history-cache' ? 'historial + caché' : 'historial + caché + cookies') + (keepSessions ? ' (se conservaron sesiones)' : ''));
  }
}

function notifyNavIntent(wv) {
  try {
    if (!wv) return;
    const wcId = Number(wv.getWebContentsId?.()) || 0;
    if (wcId && typeof mc !== 'undefined' && typeof mc.navIntent === 'function') mc.navIntent({ wcId });
  } catch {}
}

function goBack()    { const wv=$('webview-' + state.activeTab); if (wv && wv.canGoBack && wv.canGoBack()) { notifyNavIntent(wv); wv.goBack(); } }
function goForward() { const wv=$('webview-' + state.activeTab); if (wv && wv.canGoForward && wv.canGoForward()) { notifyNavIntent(wv); wv.goForward(); } }
function reloadPage(){ const wv=$('webview-' + state.activeTab); if (wv && state.currentPanel==='webview' && wv.reload) { reloadTab(state.activeTab); } }
async function toggleMaximize() { await mc.maximize(); updateMaxBtn(); }
async function updateMaxBtn() {
  const max = await mc.isMaximized();
  const btn = $('maxbtn');
  if (btn) { btn.className = 'wbtn g' + (max ? ' maximized' : ''); btn.title = max ? 'Restaurar' : 'Maximizar'; }
}
function goHome()    {
  const tab = state.tabs.find(t => t.id === state.activeTab);
  if (tab) {
    tab.url = 'mc://newtab';
    tab.title = 'Nueva pestaña';
    const title = document.querySelector('#tab-' + state.activeTab + ' .tab-title');
    if (title) title.textContent = tab.title;
  }
  showPanel('newtab');
  $('urlinput').value = 'mc://newtab';
}

