'use strict';
// ── downloads ───────────────────────────────────
let dlActive = 0;
function setUtilityPanelTab(tab) {
  const panel = $('dl-overlay');
  if (!panel) return;
  panel.querySelectorAll('[data-utility-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.utilityTab === tab);
  });
  panel.querySelectorAll('[data-utility-view]').forEach(view => {
    view.classList.toggle('active', view.dataset.utilityView === tab);
  });
  if (tab === 'history') renderHistory();
}
function openUtilityPanel(tab) {
  const ov = $('dl-overlay');
  if (!ov) return;
  ov.classList.add('open');
  const btn = $('utility-toggle');
  if (btn) btn.classList.add('open');
  setUtilityPanelTab(tab);
}
function toggleUtilityPanel() {
  const ov = $('dl-overlay');
  if (!ov) return;
  const open = ov.classList.toggle('open');
  const btn = $('utility-toggle');
  if (btn) btn.classList.toggle('open', open);
  if (open) setUtilityPanelTab('downloads');
}
function toggleDlOverlay() {
  openUtilityPanel('downloads');
}
// Extraer un nombre de archivo legible de una URL multimedia
function friendlyFileName(url, type, pageUrl, displayName) {
  // Prioridad: nombre especifico que da la pagina -> ruta de la barra de URLs
  // -> ruta + dominio si la ruta no es utilizable. La URL del fetch (url) NO se
  // usa para nombrar: da nombres y dominios distintos a los de la barra.
  const clean = s => String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };

  // 1) Nombre explicito que aporta Stream Hunter, cuando no es una URL.
  if (typeof displayName === 'string' && displayName.trim() && !/^https?:\/\//i.test(displayName)) {
    return clean(displayName).slice(0, 80) || 'media';
  }

  // 2-3) Ruta de la barra de URLs. Sin pageUrl no hay contexto de pagina: se
  // devuelve la marca en vez de inventar un nombre desde la URL del fetch.
  if (typeof pageUrl !== 'string' || !/^https?:\/\//i.test(pageUrl)) return 'media';

  try {
    const parsed = new URL(pageUrl);
    const host = parsed.hostname.replace(/^www\./i, '').replace(/^vww\./i, '');
    const path = parsed.pathname.split('/').filter(Boolean).map(safeDecode).join('_');
    const generic = !path || path.length < 3
      || /^(index|home|ver|v\/?$|watch|watch\/?$|player|play|video|videos|stream|streaming|live|hls|m3u8|master|playlist|media|seg|segment|chunk|part)$/i.test(path);
    if (!generic) return clean(path).slice(0, 100) || 'media';
    return clean(host + (path ? '_' + path : '')).slice(0, 100) || 'media';
  } catch {
    return 'media';
  }
}

function startMediaDownload(dlId, url, type, name, pageUrl) {
  if (type === 'DASH' || /\.mpd(\?|#|$)/i.test(url)) {
    const item = document.getElementById(dlId);
    const meta = $('meta-' + dlId);
    if (meta) meta.textContent = 'DASH — usando yt-dlp...';
    mc.ytdlpCheck().then(installed => {
      if (!installed) {
        addSidebarLog('blocked', '[DL] yt-dlp no instalado — necesario para DASH (.mpd)');
        if (item) {
          item.dataset.state = 'error';
          setDlButtons(item, 'error');
          const p = $('pct-' + dlId);
          if (p) { p.textContent = '✗ Sin yt-dlp'; p.style.color = 'var(--danger)'; }
        }
        return;
      }
      mc.ytdlpDownload({ url, pageUrl }).then(result => {
        if (!item) return;
        if (result.ok) {
          item.dataset.state = 'done';
          const p = $('pct-' + dlId);
          const f = $('fill-' + dlId);
          if (p) { p.textContent = '✓ Listo'; p.style.color = 'var(--success)'; }
          if (f) f.style.width = '100%';
          if (meta) meta.textContent = result.path || 'Descargado';
          addSidebarLog('info', '[DL] DASH descargado: ' + (result.path || url));
        } else {
          item.dataset.state = 'error';
          setDlButtons(item, 'error');
          const p = $('pct-' + dlId);
          if (p) { p.textContent = '✗ Error'; p.style.color = 'var(--danger)'; }
          addSidebarLog('blocked', '[DL] DASH: ' + (result.error || 'error'));
        }
        dlActive = Math.max(0, dlActive - 1);
        setText('dl-count-badge', dlActive + ' activas');
      });
    });
    return;
  }
  if (type === 'HLS' || /\.m3u8(\?|#|$)/i.test(url)) mc.downloadHLS(dlId, url, name, pageUrl);
  else mc.downloadFile(dlId, url, name, pageUrl);
}

// ── Persistencia del historial de descargas ──
function saveDownloadsLS() {
  try { localStorage.setItem('mc_downloads', JSON.stringify(state.downloads)); } catch {}
}
function loadDownloadsLS() {
  try {
    const raw = localStorage.getItem('mc_downloads');
    if (raw) state.downloads = JSON.parse(raw);
    if (!Array.isArray(state.downloads)) state.downloads = [];
    let recovered = false;
    state.downloads.forEach(download => {
      if (download.state === 'active' || download.state === 'paused') {
        download.state = 'interrupted';
        recovered = true;
      }
    });
    if (recovered) saveDownloadsLS();
  } catch { state.downloads = []; }
}
function trackDownload(entry) {
  // Actualiza o añade una entrada al historial persistente
  const idx = state.downloads.findIndex(d => d.id === entry.id);
  if (idx >= 0) state.downloads[idx] = { ...state.downloads[idx], ...entry };
  else state.downloads.unshift(entry);
  if (state.downloads.length > 500) state.downloads.length = 500;
  saveDownloadsLS();
}
function trackPerchanceDownload(event) {
  if (!event?.id) return;
  const previous = state.downloads.find(download => download.id === event.id);
  const received = Math.max(0, Number(event.receivedBytes) || 0);
  const total = Math.max(0, Number(event.totalBytes) || 0);
  const isDone = event.type === 'done';
  const completed = isDone && event.success === true;
  const cancelled = isDone && event.state === 'cancelled';
  const downloadState = !isDone ? 'active' : completed ? 'done' : cancelled ? 'cancelled' : 'error';
  const progress = total > 0 ? Math.min(100, Math.round(received / total * 100)) : 0;
  if (event.type === 'start' && !previous) {
    dlActive++;
    setText('dl-count-badge', dlActive + ' activas');
    const dot = $('dl-badge-dot'); if (dot) dot.style.display = 'block';
  }
  trackDownload({
    id: event.id, url: event.url || '', type: 'FILE', page: event.pageUrl || '',
    name: event.filename || 'descarga', filename: event.filename || 'descarga',
    file: completed ? (event.path || '') : '', size: (received / 1048576).toFixed(1),
    received, total, progress, state: downloadState, native: true, perchance: true,
    error: completed ? '' : (event.state || ''), ts: Date.now()
  });

  let item = document.getElementById(event.id);
  if (isDone) {
    if (previous?.state === 'active') dlActive = Math.max(0, dlActive - 1);
    item?.remove();
    renderPersistedDownloads();
    item = document.getElementById(event.id);
    const queue = $('download-queue');
    if (item && queue) queue.insertBefore(item, queue.firstChild);
    setText('dl-count-badge', dlActive + ' activas');
    const dot = $('dl-badge-dot'); if (dot) dot.style.display = dlActive > 0 ? 'block' : 'none';
    return;
  }
  if (!item) {
    renderPersistedDownloads();
    item = document.getElementById(event.id);
    const queue = $('download-queue');
    if (item && queue) queue.insertBefore(item, queue.firstChild);
  }
  if (item) {
    const fill = $('fill-' + event.id); if (fill) fill.style.width = progress + '%';
    const pct = $('pct-' + event.id); if (pct) pct.textContent = total > 0 ? progress + '%' : 'Descargando';
    const meta = $('meta-' + event.id); if (meta) meta.textContent = fmtBytes(received) + ' / ' + fmtBytes(total);
  }
}
window.trackPerchanceDownload = trackPerchanceDownload;
function renderPersistedDownloads() {
  // Renderiza el historial persistente en la cola de descargas
  const queue = $('download-queue');
  if (!queue) return;
  const ph = queue.querySelector('.dl-empty-msg') || queue.querySelector('div[style*="center"]'); if (ph) ph.remove();
  // Solo renderizar las que no están ya en el DOM (las activas se renderizan en vivo)
  state.downloads.forEach(d => {
    if (document.getElementById(d.id)) return;
    // Las activas se renderizan en vivo SOLO durante la sesion en la que
    // arrancaron. Una 'active' sin item en el DOM viene de una sesion previa
    // (app cerrada a mitad de una descarga grande, p.ej. video): hay que
    // mostrarla igual, si no queda invisible en el historial para siempre.
    const el = document.createElement('div');
    el.className = 'dl-item'; el.id = d.id;
    el.draggable = false;
    el.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
    // Sin item en vivo no hay progreso real: el DownloadItem de Electron
    // murio con la sesion anterior. Se muestra como interrumpida para que
    // ofrezca 'Reanudar' en vez de un 0% que nunca avanza.
    const isStaleActive = d.state === 'active' && !d.perchance;
    const shownState = isStaleActive ? 'interrupted' : (d.state || 'done');
    el.dataset.url = d.url || '';
    el.dataset.type = d.type || 'MP4';
    el.dataset.page = d.page || '';
    el.dataset.name = d.name || '';
    el.dataset.state = shownState;
    el.dataset.file = d.file || '';
    el.dataset.perchance = d.perchance ? 'true' : 'false';
    el.dataset.native = d.native || String(d.id).startsWith('dl-native-') ? 'true' : 'false';
    const dom = (d.url || '').replace(/https?:\/\//, '').split('/')[0] || '';
    const fullName = shownState === 'done' && d.filename
      ? d.filename
      : (d.name ? d.name.replace(/_\d+$/, '') : (d.filename || 'descarga'));
    const friendly = compactDownloadName(fullName);
    const stateLabel = shownState === 'done' ? '✓ ' + (d.size || '') + ' MB' :
               shownState === 'active' ? (d.total > 0 ? (d.progress || 0) + '%' : 'Descargando') :
                       shownState === 'error' ? '✗ ERROR' :
                       shownState === 'cancelled' ? '✕ Cancelado' :
                       shownState === 'interrupted' ? '↻ Interrumpida' : '—';
    const stateColor = shownState === 'done' ? 'var(--success)' :
               shownState === 'active' ? 'var(--accent)' :
                       shownState === 'error' ? 'var(--danger)' :
                       shownState === 'cancelled' ? 'var(--danger)' : 'var(--warn)';
    const metaHtml = shownState === 'done' && d.file
      ? '<a href="#" onclick="openDlFile(\'' + d.id + '\');return false;" style="color:var(--accent);text-decoration:underline;">Abrir archivo</a> &middot; <a href="#" onclick="mc.openDlFolder();return false;" style="color:var(--accent);text-decoration:underline;">Abrir carpeta</a>'
      : shownState === 'active' && d.perchance
        ? fmtBytes(d.received || 0) + ' / ' + fmtBytes(d.total || 0)
        : escapeHtml(d.filename || friendly);
    el.innerHTML =
      '<div class="dl-header"><span class="dl-name" title="'+escapeHtml(fullName)+'">'+escapeHtml(friendly)+'</span><span class="dl-pct" id="pct-'+d.id+'" style="color:'+stateColor+'">'+stateLabel+'</span></div>'
    +'<div class="pbar"><div class="pfill" id="fill-'+d.id+'" style="width:'+(shownState==='done'?'100%':Math.min(100,Math.max(0,Number(d.progress)||0))+'%')+'"'+(shownState==='error'||shownState==='cancelled'?' class="error"':'')+'></div></div>'
    +'<div class="dl-meta"><span id="meta-'+d.id+'">'+metaHtml+'</span><span id="speed-'+d.id+'">'+(shownState === 'done' ? '' : '— KB/s')+'</span></div>'
     +'<div class="dl-actions">'
     +  (shownState === 'interrupted' && !d.perchance
       ? '<button class="dl-btn" data-act="resume" onclick="retryPersistedDownload(\''+d.id+'\')" title="Reanudar">▶</button><button class="dl-btn" data-act="pause" onclick="pausePersistedDownload(\''+d.id+'\')" title="Pausar" style="display:none">⏸</button><button class="dl-btn" data-act="cancel" onclick="cancelPersistedDownload(\''+d.id+'\')" title="Cancelar">✕</button>'
       : !d.perchance && (shownState === 'error' || shownState === 'cancelled')
         ? '<button class="dl-btn" data-act="retry" onclick="dlAction(\'retry\',\''+d.id+'\')" title="Reintentar">↻</button>'
         : '')
     +'</div>';
    queue.appendChild(el);
  });
}
function retryPersistedDownload(id) {
  const item = document.getElementById(id);
  if (!item) return;
  if (item.dataset.native !== 'true') { dlAction('retry', id); return; }
  // Interrumpida de una sesión anterior: reanudar NO debe reintentar desde cero
  // (downloadURL de Chromium arranca de nuevo). Se continúa el .crdownload.
  if (item.dataset.state === 'interrupted') dlNativeAction('resume', id);
  else dlNativeAction('retry', id);
}
function pausePersistedDownload(id) {
  const item = document.getElementById(id);
  if (item?.dataset.native === 'true') dlNativeAction('pause', id);
  else dlAction('pause', id);
}
function cancelPersistedDownload(id) {
  const item = document.getElementById(id);
  if (!item) return;
  item.dataset.state = 'cancelled';
  const pct = $('pct-' + id);
  if (pct) { pct.textContent = '✕ Cancelado'; pct.style.color = 'var(--danger)'; }
  const fill = $('fill-' + id);
  if (fill) { fill.style.width = '100%'; fill.classList.add('error'); }
  const actions = item.querySelector('.dl-actions');
  if (actions) actions.innerHTML = '';
  trackDownload({ id, state: 'cancelled', ts: Date.now() });
}
function clearDownloads() {
  state.downloads = state.downloads.filter(d => d.state === 'active' || d.state === 'paused');
  saveDownloadsLS();
  const queue = $('download-queue');
  if (queue) {
    queue.querySelectorAll('.dl-item').forEach(item => {
      if (item.dataset.state !== 'active' && item.dataset.state !== 'paused') item.remove();
    });
    if (!queue.querySelector('.dl-item')) queue.innerHTML = '<div class="dl-empty-msg">Sin descargas activas</div>';
  }
  setText('dl-count-badge', dlActive + ' activas');
  const dot = $('dl-badge-dot'); if (dot) dot.style.display = dlActive > 0 ? 'block' : 'none';
  addSidebarLog('info', '[DL] Historial de descargas limpiado');
}

function dlMedia(url, type, pageUrl, displayName) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    addSidebarLog('blocked', '[DL] URL multimedia inválida o vacía');
    return;
  }
  const resolvedPage = pageUrl || getActivePageUrl();
  // Abrir overlay si está cerrado
  const ov = $('dl-overlay');
  if (ov && !ov.classList.contains('open')) ov.classList.add('open');
  const queue = $('download-queue');
  const ph = queue.querySelector('.dl-empty-msg') || queue.querySelector('div[style*="center"]'); if (ph) ph.remove();
  const dlId = 'dl-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);
  const dom  = url.replace(/https?:\/\//,'').split('/')[0];
  const fullName = friendlyFileName(url, type, resolvedPage, displayName);
  const friendly = compactDownloadName(fullName);
  dlActive++;
  setText('dl-count-badge', dlActive+' activas');
  const dot = $('dl-badge-dot'); if (dot) dot.style.display = 'block';
  const el = document.createElement('div');
  el.className='dl-item'; el.id=dlId;
  el.draggable = false;
  el.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
  el.dataset.url = url;
  el.dataset.type = type;
  el.dataset.page = resolvedPage || '';
  el.dataset.name = fullName + '_' + Date.now();
  el.dataset.state = 'active';
  el.innerHTML =
    '<div class="dl-header"><span class="dl-name" title="'+escapeHtml(fullName)+'">'+escapeHtml(friendly)+'</span><span class="dl-pct" id="pct-'+dlId+'">0%</span></div>'
   +'<div class="pbar"><div class="pfill" id="fill-'+dlId+'" style="width:0%"></div></div>'
   +'<div class="dl-meta"><span id="meta-'+dlId+'">0 / ? segmentos</span><span id="speed-'+dlId+'">— KB/s</span></div>'
   +'<div class="dl-actions">'
   +  '<button class="dl-btn" data-act="pause" onclick="dlAction(\'pause\',\''+dlId+'\')" title="Pausar">⏸</button>'
   +  '<button class="dl-btn" data-act="resume" onclick="dlAction(\'resume\',\''+dlId+'\')" title="Reanudar" style="display:none">▶</button>'
   +  '<button class="dl-btn" data-act="cancel" onclick="dlAction(\'cancel\',\''+dlId+'\')" title="Cancelar">✕</button>'
   +  '<button class="dl-btn" data-act="retry" onclick="dlAction(\'retry\',\''+dlId+'\')" title="Reintentar" style="display:none">↻</button>'
   +'</div>';
  queue.insertBefore(el, queue.firstChild);

  const name = el.dataset.name;
  // Registrar en historial persistente
  trackDownload({
    id: dlId, url, type, page: resolvedPage || '', name,
    filename: friendly, state: 'active', ts: Date.now()
  });
  startMediaDownload(dlId, url, type, name, resolvedPage);
}

function setDlButtons(item, state) {
  if (!item) return;
  item.querySelectorAll('.dl-btn').forEach(b => {
    const act = b.dataset.act;
    b.style.display = 'none';
    if (state === 'active' && (act === 'pause' || act === 'cancel')) b.style.display = '';
    else if (state === 'paused' && (act === 'resume' || act === 'cancel')) b.style.display = '';
    else if ((state === 'cancelled' || state === 'error') && act === 'retry') b.style.display = '';
  });
}

async function dlAction(action, id) {
  const item = document.getElementById(id);
  if (!item) return;
  const url = item.dataset.url;
  const type = item.dataset.type;
  const page = item.dataset.page || '';
  const p = $('pct-'+id);
  const f = $('fill-'+id);
  if (action === 'pause') {
    await mc.dlPause(id);
    item.dataset.state = 'paused';
    setDlButtons(item, 'paused');
    if (p) { p.textContent = '⏸ Pausado'; p.style.color = 'var(--warn)'; }
    trackDownload({ id, state: 'paused', ts: Date.now() });
  } else if (action === 'resume') {
    await mc.dlResume(id);
    item.dataset.state = 'active';
    setDlButtons(item, 'active');
    if (p) { p.textContent = '0%'; p.style.color = 'var(--accent)'; }
    trackDownload({ id, state: 'active', ts: Date.now() });
  } else if (action === 'cancel') {
    await mc.dlCancel(id);
    item.dataset.state = 'cancelled';
    setDlButtons(item, 'cancelled');
    if (p) { p.textContent = '✕ Cancelado'; p.style.color = 'var(--danger)'; }
    if (f) { f.style.width='100%'; f.classList.add('error'); }
    trackDownload({ id, state: 'cancelled', ts: Date.now() });
    // El evento dl-error del proceso principal actualiza el contador
  } else if (action === 'retry') {
    item.dataset.state = 'active';
    setDlButtons(item, 'active');
    if (p) { p.textContent = '0%'; p.style.color = 'var(--accent)'; }
    if (f) { f.style.width='0%'; f.classList.remove('error'); }
    const m = $('meta-'+id); if (m) m.textContent = 'Reintentando...';
    const s = $('speed-'+id); if (s) s.textContent = '— KB/s';
    dlActive++;
    setText('dl-count-badge', dlActive+' activas');
    const dot = $('dl-badge-dot'); if (dot) dot.style.display = 'block';
    trackDownload({ id, state: 'active', ts: Date.now() });
    if (type === 'DASH' || /\.mpd(\?|#|$)/i.test(url)) startMediaDownload(id, url, type, item.dataset.name || '', page);
    else if (type === 'HLS' || /\.m3u8(\?|#|$)/i.test(url)) mc.downloadHLS(id, url, item.dataset.name || '', page);
    else mc.downloadFile(id, url, item.dataset.name || '', page);
  }
}

function bindDownloadEvents() {
  mc.on('dl-progress', d => {
    const item = document.getElementById(d.id);
    if (item && item.dataset.state === 'active') {
      const id = item.id;
      const f = $('fill-'+id); if (f) f.style.width = d.pct + '%';
      const p = $('pct-'+id); if (p) p.textContent = d.pct + '%';
      const m = $('meta-'+id);
      if (m) m.textContent = d.kind === 'file' ? fmtBytes(d.done)+' / '+fmtBytes(d.total) : d.done+' / '+d.total+' segmentos';
      const s = $('speed-'+id); if (s) s.textContent = d.speed+' KB/s';
      trackDownload({ id, progress: d.pct, received: d.done, total: d.total });
    }
  });
  mc.on('dl-complete', d => {
    const item = document.getElementById(d.id);
    if (item) {
      const id = item.id;
      item.dataset.file = d.file || '';
      item.dataset.state = 'done';
      setDlButtons(item, 'done');
      const fn = d.filename || (d.file ? d.file.split('\\').pop().split('/').pop() : '');
      const nameEl = item.querySelector('.dl-name');
      if (nameEl && fn) {
        nameEl.textContent = compactDownloadName(fn);
        nameEl.title = fn;
      }
      const p = $('pct-'+id); if (p){ p.textContent='✓ '+d.size+' MB'; p.style.color='var(--success)'; }
      const f = $('fill-'+id); if (f) f.style.width='100%';
      const meta = $('meta-'+id);
      if (meta) meta.innerHTML = '<a href="#" onclick="openDlFile(\'' + id + '\');return false;" style="color:var(--accent);text-decoration:underline;">Abrir archivo</a> &middot; <a href="#" onclick="mc.openDlFolder();return false;" style="color:var(--accent);text-decoration:underline;">Abrir carpeta</a>';
      const speed = $('speed-'+id); if (speed) speed.textContent = '';
    }
    // Persistir en historial
    trackDownload({
      id: d.id, url: d.url || '', file: d.file || '',
      filename: d.filename || (d.file ? d.file.split('\\').pop().split('/').pop() : ''),
      size: d.size, state: 'done', ts: Date.now()
    });
    dlActive = Math.max(0, dlActive-1);
    setText('dl-count-badge', dlActive+' activas');
    const dot = $('dl-badge-dot'); if (dot) dot.style.display = dlActive > 0 ? 'block' : 'none';
    addSidebarLog('allowed','[DL] Completado: '+d.size+' MB');
  });
  mc.on('dl-error', d => {
    const item = document.getElementById(d.id);
    if (item) {
      const id = item.id;
      const f = $('fill-'+id); if (f){ f.style.width='100%'; f.classList.add('error'); }
      const p = $('pct-'+id);
      if (p) {
        if (d.cancelled) { p.textContent='✕ Cancelado'; p.style.color='var(--danger)'; }
        else { p.textContent='✗ ERROR'; p.style.color='var(--danger)'; }
      }
      item.dataset.state = d.cancelled ? 'cancelled' : 'error';
      setDlButtons(item, item.dataset.state);
    }
    // Persistir en historial
    trackDownload({
      id: d.id, url: d.url || '',
      state: d.cancelled ? 'cancelled' : 'error',
      error: d.error || '', ts: Date.now()
    });
    dlActive = Math.max(0, dlActive-1);
    setText('dl-count-badge', dlActive+' activas');
    const dot = $('dl-badge-dot'); if (dot) dot.style.display = dlActive > 0 ? 'block' : 'none';
    addSidebarLog('blocked','[DL] '+(d.cancelled?'Cancelado: ':'Error: ')+d.error);
  });

  // ── Descargas nativas del navegador (will-download) ──
  mc.on('dl-native', d => {
    // Nueva descarga nativa iniciada
    const queue = $('download-queue');
    if (!queue) return;
    const ph = queue.querySelector('.dl-empty-msg') || queue.querySelector('div[style*="center"]'); if (ph) ph.remove();
    const ov = $('dl-overlay');
    if (ov && !ov.classList.contains('open')) ov.classList.add('open');
    setUtilityPanelTab('downloads');
    const dlId = d.id;
    const existing = document.getElementById(dlId);
    if (existing) {
      existing.dataset.state = 'active';
      setDlButtons(existing, 'active');
      const existingPct = $('pct-' + dlId);
      if (existingPct) { existingPct.textContent = '0%'; existingPct.style.color = 'var(--accent)'; }
      const existingFill = $('fill-' + dlId);
      if (existingFill) { existingFill.style.width = '0%'; existingFill.classList.remove('error'); }
      const existingMeta = $('meta-' + dlId);
      if (existingMeta) existingMeta.textContent = '0 B / ' + fmtBytes(d.totalBytes || 0);
      return;
    }
    const dom = (d.url || '').replace(/https?:\/\//, '').split('/')[0] || '';
    const fullName = d.filename || 'descarga';
    const friendly = compactDownloadName(fullName);
    dlActive++;
    setText('dl-count-badge', dlActive+' activas');
    const dot = $('dl-badge-dot'); if (dot) dot.style.display = 'block';
    const el = document.createElement('div');
    el.className = 'dl-item'; el.id = dlId;
    el.dataset.url = d.url || '';
    el.dataset.type = 'FILE';
    el.dataset.page = d.pageUrl || '';
    el.dataset.name = d.filename || 'descarga';
    el.dataset.state = 'active';
    el.dataset.native = 'true';
    el.innerHTML =
      '<div class="dl-header"><span class="dl-name" title="'+escapeHtml(fullName)+'">'+escapeHtml(friendly)+'</span><span class="dl-pct" id="pct-'+dlId+'">0%</span></div>'
     +'<div class="pbar"><div class="pfill" id="fill-'+dlId+'" style="width:0%"></div></div>'
     +'<div class="dl-meta"><span id="meta-'+dlId+'">0 B / '+fmtBytes(d.totalBytes||0)+'</span><span id="speed-'+dlId+'">— KB/s</span></div>'
     +'<div class="dl-actions">'
    +  '<button class="dl-btn" data-act="pause" onclick="dlNativeAction(\'pause\',\''+dlId+'\')" title="Pausar">⏸</button>'
    +  '<button class="dl-btn" data-act="resume" onclick="dlNativeAction(\'resume\',\''+dlId+'\')" title="Reanudar" style="display:none">▶</button>'
    +  '<button class="dl-btn" data-act="cancel" onclick="dlNativeAction(\'cancel\',\''+dlId+'\')" title="Cancelar">✕</button>'
    +  '<button class="dl-btn" data-act="retry" onclick="dlNativeAction(\'retry\',\''+dlId+'\')" title="Reintentar" style="display:none">↻</button>'
     +'</div>';
    queue.insertBefore(el, queue.firstChild);
    // Registrar en historial persistente
    trackDownload({
      id: dlId, url: d.url || '', type: 'FILE', page: d.pageUrl || '',
      name: d.filename || 'descarga', filename: d.filename || 'descarga',
      native: true, state: 'active', ts: Date.now()
    });
  });

  // Cerrar automáticamente la pestaña popup que solo sirvió para iniciar
  // una descarga (comportamiento de navegadores normales: la pestaña de
  // descarga se abre y se cierra sola). No afecta al flujo OAuth, que usa
  // ventanas nativas y nunca se convierte en pestaña.
  mc.on('dl-native-tab', ({ wcId }) => {
    if (!wcId) return;
    const wv = [...document.querySelectorAll('webview')].find(w => {
      try { return w.getWebContentsId() === wcId; } catch { return false; }
    });
    if (!wv) return;
    const tabId = Number((wv.id || '').replace('webview-', ''));
    if (!tabId) return;
    const tab = state.tabs.find(t => t.id === tabId);
    // Solo cerrar pestañas abiertas como popup recientemente (no las manuales)
    if (tab && tab.isPopup && Date.now() - (tab.popupAt || 0) < 30000) {
      closeTab(null, tabId);
    }
  });

  mc.on('dl-native-progress', d => {
    const item = document.getElementById(d.id);
    if (!item || item.dataset.state !== 'active') return;
    const id = item.id;
    const f = $('fill-'+id); if (f) f.style.width = d.pct + '%';
    const p = $('pct-'+id); if (p) p.textContent = d.pct + '%';
    const m = $('meta-'+id);
    if (m) m.textContent = fmtBytes(d.received||0)+' / '+fmtBytes(d.totalBytes||0);
    trackDownload({ id, progress: d.pct, received: d.received, total: d.totalBytes });
  });

  window.dlNativeFailText = (reason) => {
    return {
      'no-resume-support': 'Servidor sin soporte de reanudar (Range)',
      'mediafire-remint-fail': 'No se pudo renovar el enlace de MediaFire',
      'resume-http-error': 'Error HTTP al reanudar',
      'no-partial': 'Archivo parcial no disponible',
      'io-error': 'Error de disco al reanudar',
      'busy': 'Ya hay una descarga en curso con ese nombre'
    }[reason] || 'No se pudo reanudar';
  };

  window.dlNativeAction = async (action, id) => {
    const item = document.getElementById(id);
    if (!item) return;
    const pers = state.downloads.find(dd => dd.id === id) || {};
    let result;
    if (action === 'pause') result = await mc.dlNativePause(id);
    else if (action === 'resume') result = await mc.dlNativeResume(id, {
      url: item.dataset.url,
      filename: item.dataset.name,
      pageUrl: item.dataset.page,
      partition: 'persist:mc',
      total: Number(pers.total) || 0,
      received: Number(pers.received) || 0
    });
    else if (action === 'cancel') result = await mc.dlNativeCancel(id);
    else result = await mc.dlNativeRetry(id, {
      url: item.dataset.url,
      filename: item.dataset.name,
      pageUrl: item.dataset.page,
      partition: 'persist:mc'
    });
    if (!result?.ok) {
      if (action === 'resume' && result?.reason) {
        const meta = $('meta-'+id);
        const text = window.dlNativeFailText(result.reason);
        if (meta) meta.textContent = text;
        addSidebarLog('blocked', '[DL] Reanudar: ' + text);
        setDlButtons(item, 'error');
      }
      return;
    }
    const p = $('pct-' + id);
    if (action === 'pause') {
      item.dataset.state = 'paused'; setDlButtons(item, 'paused');
      if (p) { p.textContent = '⏸ Pausado'; p.style.color = 'var(--warn)'; }
      trackDownload({ id, state: 'paused', ts: Date.now() });
    } else if (action === 'resume') {
      item.dataset.state = 'active'; setDlButtons(item, 'active');
      if (p) { p.textContent = '0%'; p.style.color = 'var(--accent)'; }
      trackDownload({ id, state: 'active', ts: Date.now() });
    } else if (action === 'cancel') {
      item.dataset.state = 'cancelled'; setDlButtons(item, 'cancelled');
      if (p) { p.textContent = '✕ Cancelado'; p.style.color = 'var(--danger)'; }
      trackDownload({ id, state: 'cancelled', ts: Date.now() });
    } else {
      item.dataset.state = 'active'; setDlButtons(item, 'active');
      if (p) { p.textContent = '0%'; p.style.color = 'var(--accent)'; }
      const f = $('fill-' + id); if (f) { f.style.width = '0%'; f.classList.remove('error'); }
      trackDownload({ id, state: 'active', ts: Date.now() });
      dlActive++;
      setText('dl-count-badge', dlActive + ' activas');
    }
  };

  mc.on('dl-native-range-fail', d => {
    const item = document.getElementById(d.id);
    if (!item) return;
    const meta = $('meta-' + d.id);
    const text = window.dlNativeFailText(d.reason);
    if (meta) meta.textContent = text;
    item.dataset.state = 'error';
    setDlButtons(item, 'error');
    addSidebarLog('blocked', '[DL] Reanudar: ' + text);
  });

  mc.on('dl-native-note', d => {
    const item = document.getElementById(d.id);
    if (!item || !d.text) return;
    const meta = $('meta-' + d.id);
    if (meta) meta.textContent = d.text;
    addSidebarLog('info', '[DL] ' + d.text);
  });

  mc.on('dl-native-done', d => {
    // Persistir en historial PRIMERO: renderPersistedDownloads() dibuja desde
    // state.downloads, asi que tiene que existir antes de renderizar.
    trackDownload({
      id: d.id, url: d.url || '', file: d.file || '',
      filename: d.filename || '', size: d.size,
      // type/name los usa renderPersistedDownloads() para la etiqueta y el
      // icono. Sin ellos el video caia en el 'MP4' por defecto de L6638.
      type: (d.type || 'FILE'), name: d.name || d.filename || 'descarga',
      native: true,
      state: d.cancelled ? 'cancelled' : 'done', ts: Date.now()
    });

    let item = document.getElementById(d.id);
    // Si la descarga no nació en el panel (p. ej. se lanzó desde el menú
    // contextual de la página), nunca hubo item en la cola. Antes se guardaba
    // en el historial pero sin renderizarlo, así que quedaba invisible: la
    // entrada existía pero no se veía en ninguna parte.
    if (!item) {
      renderPersistedDownloads();
      item = document.getElementById(d.id);
      const queue = $('download-queue');
      if (item && queue) queue.insertBefore(item, queue.firstChild);
    }
    if (item) {
      const id = item.id;
      item.dataset.file = d.file || '';
      item.dataset.state = d.cancelled ? 'cancelled' : 'done';
      const f = $('fill-'+id); if (f) f.style.width = '100%';
      const p = $('pct-'+id);
      if (p) {
        if (d.cancelled) { p.textContent = '✕ Cancelado'; p.style.color = 'var(--danger)'; }
        else { p.textContent = '✓ '+d.size+' MB'; p.style.color = 'var(--success)'; }
      }
      if (!d.cancelled) {
        const nameEl = item.querySelector('.dl-name');
        if (nameEl && d.filename) {
          nameEl.textContent = compactDownloadName(d.filename);
          nameEl.title = d.filename;
        }
        const meta = $('meta-'+id);
        if (meta) meta.innerHTML = '<a href="#" onclick="openDlFile(\'' + id + '\');return false;" style="color:var(--accent);text-decoration:underline;">Abrir archivo</a> &middot; <a href="#" onclick="mc.openDlFolder();return false;" style="color:var(--accent);text-decoration:underline;">Abrir carpeta</a>';
        const speed = $('speed-'+id); if (speed) speed.textContent = '';
      }
      setDlButtons(item, d.cancelled ? 'cancelled' : 'done');
    }
    dlActive = Math.max(0, dlActive-1);
    setText('dl-count-badge', dlActive+' activas');
    const dot = $('dl-badge-dot'); if (dot) dot.style.display = dlActive > 0 ? 'block' : 'none';
    if (!d.cancelled) addSidebarLog('allowed', '[DL] Descarga nativa completada: ' + (d.filename || ''));
  });

  // Descargas resumibles que viven en el estado del proceso main (persistido
  // en disco): si no quedaron en el historial del renderer se muestran igual
  // como interrumpidas, para que ofrezcan 'Reanudar'.
  mc.dlNativeState().then(list => {
    if (!Array.isArray(list) || !list.length) return;
    let changed = false;
    list.forEach(d => {
      if (state.downloads.find(e => e.id === d.id)) return;
      trackDownload({ ...d, ts: d.ts || Date.now() });
      changed = true;
    });
    if (changed) renderPersistedDownloads();
  }).catch(() => {});

}

// Abre el archivo descargado con la app predeterminada del sistema
function openDlFile(id) {
  const el = document.getElementById(id);
  const file = el ? el.dataset.file : '';
  if (file) mc.openDlFile(file);
}

// Cancelar una descarga nativa del navegador
function dlNativeCancel(id) {
  // Las descargas nativas de Chromium no se pueden cancelar desde el renderer fácilmente;
  // marcamos el item como cancelado en la UI
  const item = document.getElementById(id);
  if (item) {
    item.dataset.state = 'cancelled';
    const p = $('pct-'+id); if (p) { p.textContent = '✕ Cancelado'; p.style.color = 'var(--danger)'; }
    const f = $('fill-'+id); if (f) { f.style.width = '100%'; f.classList.add('error'); }
  }
  trackDownload({ id, state: 'cancelled', ts: Date.now() });
  dlActive = Math.max(0, dlActive-1);
  setText('dl-count-badge', dlActive+' activas');
  const dot = $('dl-badge-dot'); if (dot) dot.style.display = dlActive > 0 ? 'block' : 'none';
}

async function chooseDir() {
  const d = await mc.chooseDlDir();
  if (d) $('dl-dir').value = d;
}

