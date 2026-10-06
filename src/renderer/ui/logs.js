'use strict';
let mediaLogEl = null;
function addSidebarLog(type, msg) {
  const log = $('sidebar-log');
  if (!log) return;

  // Solo actualiza el contador si es el mismo tipo de media
  if (msg.startsWith('[MEDIA]') && mediaLogEl) {
    mediaLogEl.querySelector('.log-text').textContent = msg;
    return;
  }

  const el = document.createElement('div');
  el.className = 'log-entry ' + type;
  el.innerHTML = '<span class="log-dot"></span><span class="log-text">'+msg+'</span>';
  log.insertBefore(el, log.firstChild);

  if (msg.startsWith('[MEDIA]')) mediaLogEl = el;

  while (log.children.length > 60) log.lastChild.remove();
}


// ── req log ─────────────────────────────────────
function addReqLog(type, color, msg) {
  state.reqLog.unshift({ type, color, msg, ts: new Date().toLocaleTimeString('es',{hour12:false}) });
  if (state.reqLog.length > 200) state.reqLog.pop();
  renderReqLog();
  setText('req-count-badge', state.reqLog.length + ' requests');
}

function renderReqLog() {
  const log = $('req-log');
  if (!log) return;
  const f = state.reqLogFilter;
  const filtered = f === 'all' ? state.reqLog : state.reqLog.filter(e => e.type === f);
  log.innerHTML = filtered.slice(0, 100).map(e =>
    '<div class="req-item">'
    + '<span class="req-method" style="color:'+e.color+';">'+e.type.toUpperCase().substring(0,7)+'</span>'
    + '<span class="req-url">'+escapeHtml(e.msg)+'</span>'
    + '<span class="req-status">'+e.ts+'</span>'
    + '</div>'
  ).join('');
}

function filterReqLog(f) { state.reqLogFilter = f; renderReqLog(); }
function openRequestLog(filter) {
  showPanel('network');
  state.reqLogFilter = filter;
  renderReqLog();
  document.querySelectorAll('#panel-settings details').forEach(details => {
    if (details.querySelector('#req-log')) details.open = true;
  });
  $('req-log')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function clearReqLog()   { state.reqLog = []; renderReqLog(); setText('req-count-badge','0 requests'); }


// ── cookie log ──────────────────────────────────
function addCookieLog(action, domain, cookie) {
  const log = $('cookie-log');
  // limpiar placeholder
  const ph = log.querySelector('div[style*="center"]'); if (ph) ph.remove();
  const labels = { blocked:'BLOQ', modified:'MOD', allowed:'OK' };
  const cls    = { blocked:'blocked', modified:'mod', allowed:'ok' };
  const el = document.createElement('div');
  el.className = 'ck-item';
  el.innerHTML = '<span class="ck-badge '+(cls[action]||'ok')+'">'+(labels[action]||'OK')+'</span>'
               + '<span class="ck-text">'+escapeHtml(domain)+' — '+escapeHtml((cookie||'').substring(0,100))+'</span>';
  log.insertBefore(el, log.firstChild);
  while (log.children.length > 50) log.lastChild.remove();
}
