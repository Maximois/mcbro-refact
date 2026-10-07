'use strict';
// ── media ───────────────────────────────────────
const seenMedia = new Set();
function addMediaItem(entry) {
  if (seenMedia.has(entry.url)) return;
  seenMedia.add(entry.url);
  const list = $('media-list');
  const ph = list.querySelector('div[style*="dashed"]'); if (ph) ph.remove();
  const isHLS = entry.type==='HLS', isMP4 = entry.type==='MP4';
  const icon = isHLS ? '🎞' : isMP4 ? '🎬' : '📡';
  const tag  = isHLS ? '<span class="badge blue">HLS</span>' : isMP4 ? '<span class="badge warn">MP4</span>' : '<span class="badge purple">DASH</span>';
  const dom  = entry.url.replace(/https?:\/\//,'').split('/')[0];
  const short= entry.url.length > 75 ? entry.url.substring(0,75)+'…' : entry.url;
  const id = 'mi-'+Date.now()+Math.floor(Math.random()*1000);
  const safeUrl = entry.url.replace(/'/g,"\\'");
  const safePage = (entry.pageUrl || '').replace(/'/g,"\\'");
  const el = document.createElement('div');
  el.className='media-item'; el.id=id;
  el.innerHTML =
    '<div style="font-size: 2.462rem;flex-shrink:0;">🌐</div>'
   +'<div class="media-info">'
   +  '<div class="media-type-row"><span class="media-type-lbl">'+entry.type+' Stream</span>'+tag+'</div>'
   +  '<div class="media-url-lbl">'+escapeHtml(short)+'</div>'
   +  '<div class="media-meta">'+escapeHtml(dom)+' • detectado ahora</div>'
   +'</div>'
   +'<div class="media-actions">'
   +  '<button class="btn ghost btn-sm" onclick="copyUrl(\''+safeUrl+'\')">📋</button>'
   +  '<button class="btn warn btn-sm" onclick="dlMedia(\''+safeUrl+'\',\''+entry.type+'\',\''+safePage+'\')">⬇ DL</button>'
   +'</div>';
  list.insertBefore(el, list.firstChild);
  while (list.children.length > 100) list.lastElementChild.remove();
  setText('media-count-badge', seenMedia.size + ' streams');
}

function clearMedia() {
  seenMedia.clear();
  state.mediaItems.clear();
  renderMedia();
  setText('media-count-badge','0 streams');
  addSidebarLog('info', '[MEDIA] Lista limpiada');
}

// ── Stream Hunter ─────────────────────────────────────────────────────────────
const MC_HOST_LABELS = [
  ['mega.nz', 'Mega'], ['mega.io', 'Mega'], ['filemoon', 'Filemoon'], ['streamtape', 'Streamtape'],
  ['doodstream', 'DoodStream'], ['dood.', 'DoodStream'], ['voe.sx', 'VOE'], ['voe-unblock', 'VOE'],
  ['streamwish', 'StreamWish'], ['vidhide', 'VidHide'], ['mixdrop', 'MixDrop'], ['upstream', 'UpStream'],
  ['uqload', 'Uqload'], ['clicknupload', 'ClicknUpload'], ['vidoza', 'Vidoza'], ['mp4upload', 'MP4Upload'],
  ['lulustream', 'LuluStream'], ['savefiles', 'SaveFiles'], ['streamruby', 'StreamRuby'],
  ['supervideo', 'SuperVideo'], ['vidguard', 'VidGuard'], ['embeds', 'Embed'], ['workers.dev', 'Worker'],
  ['x.com', 'X'], ['twitter.com', 'X']
];
let _mcStreamSeq = 0;

function detectStreamContainer(pageUrl) {
  const src = String(pageUrl || '').toLowerCase();
  if (!src) return '';
  for (const [needle, label] of MC_HOST_LABELS) {
    if (src.includes(needle)) return label;
  }
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./i, '').toLowerCase();
    const parts = host.split('.').filter(Boolean);
    const skip = new Set(['com','net','org','io','sx','to','me','tv','cc','xyz','cdn','co','uk','de','app']);
    for (let i = parts.length - 2; i >= 0; i--) {
      const p = parts[i];
      if (p && p.length > 2 && !skip.has(p) && !/^\d+$/.test(p) && !p.includes('cloud')) return p.charAt(0).toUpperCase() + p.slice(1);
    }
  } catch {}
  return '';
}

function detectStreamOrigin(pageUrl) {
  // La etiqueta es la URL literal de la barra, pero sin protocolo para que quede legible.
  if (typeof pageUrl !== 'string' || !/^https?:\/\//i.test(pageUrl)) return '';
  return pageUrl.replace(/^https?:\/\//i, '');
}

function classifyStreamUrl(url) {
  const u = String(url || '').toLowerCase();
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return u; } })();
  if (/master[\w.-]*\.m3u8/.test(path) || /\/master\.m3u8/.test(u)) return 'master';
  if (/\.m3u8(\?|#|$)/.test(u)) return 'playlist';
  if (/\.mpd(\?|#|$)/.test(u)) return 'dash';
  if (/\.ts(\?|#|$)/.test(u)) return 'segment';
  if (/\.(mp4|webm|mkv|mov)(\?|#|$)/.test(u)) return 'file';
  return 'other';
}

// Detectar fragmentos de streaming (ruido): segmentos HLS/DASH que el reproductor
// descarga continuamente mientras reproduce. No abren nada por sí solos.
function isStreamFragment(url) {
  const u = String(url || '').toLowerCase();
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return u; } })();
  // Segmentos .ts y .m4s (DASH)
  if (/\.ts(\?|#|$)/.test(u)) return true;
  if (/\.m4s(\?|#|$)/.test(u)) return true;
  // Segmento init (init.mp4 / init.m4s)
  if (/init[\w.-]*\.(mp4|m4s)(\?|#|$)/.test(path)) return true;
  // Fragmentos numerados: seg-0.mp4, chunk-1.mp4, part-2.mp4, frag-3.mp4, etc.
  if (/\/(?:seg|chunk|part|frag|fragment|segment|piece|media)[\w.-]*[-_]\d+\.(?:mp4|m4s|ts)(\?|#|$)/i.test(path)) return true;
  // Archivos numerados sueltos: /0.mp4, /1.mp4, /2.mp4
  if (/\/\d+\.(?:mp4|m4s|ts)(\?|#|$)/.test(path)) return true;
  // Parámetros de rango (byte ranges)
  if (/[?&](?:range|byterange|start|end)=/i.test(u)) return true;
  return false;
}

function shouldShowStreamItem(item) {
  const role = classifyStreamUrl(item.url);
  if (role === 'segment') return false;
  // Segmentos .m4s (DASH) nunca son útiles por sí solos
  if (/\.m4s(\?|#|$)/i.test(item.url)) return false;
  // Rangos MP4 parciales del reproductor tampoco son descargables completos.
  if (isStreamFragment(item.url)) return false;
  return true;
}

function getActivePageUrl() {
  if (window.Sessions?._wv && document.getElementById('session-sidebar')?.classList.contains('open')) {
    try {
      const url = window.Sessions._wv.getURL();
      if (/^https?:\/\//i.test(url)) return url;
    } catch {}
  }
  const wv = $('webview-' + state.activeTab);
  try {
    if (wv && wv.getURL && /^https?:\/\//i.test(wv.getURL())) return wv.getURL();
  } catch {}
  const tab = state.tabs?.find(t => t.id === state.activeTab);
  return tab?.url && /^https?:\/\//i.test(tab.url) ? tab.url : '';
}

function enrichStreamItem(item) {
  const activePage = getActivePageUrl();
  item.pageUrl = (item.pageUrl && /^https?:/i.test(item.pageUrl)) ? item.pageUrl : activePage;
  if (activePage && /^https?:/i.test(activePage)) item.pageUrl = activePage;
  const literalPage = detectStreamOrigin(item.pageUrl) || item.pageUrl || 'URL no disponible';
  const role = classifyStreamUrl(item.url);
  item.container = '';
  item.origin = literalPage;
  item.displayName = literalPage;
  item.subtitle = literalPage;
  item.hlsRole = role;
  if (!item.detectedAt) item.detectedAt = Date.now();
  return item;
}

function clearStreams() {
  state.streamItems.clear();
  renderStreams();
  renderSidebarStreams();
  setText('streams-count-badge','0 streams');
  // Limpiar también el caché de detección del webview para que el próximo escaneo detecte desde cero
  const wv = $('webview-' + state.activeTab);
  if (wv && wv.executeJavaScript) {
    wv.executeJavaScript('try{window.__mcFound=[];}catch(e){}').catch(() => {});
  }
  addSidebarLog('info', '[STREAM] Lista limpiada — vuelve a escanear para redetectar');
}

function getActiveHlsCaptureWebContentsId() {
  if (window.Sessions?._wv && document.getElementById('session-sidebar')?.classList.contains('open')) {
    try { return Number(window.Sessions._wv.getWebContentsId()) || 0; } catch {}
  }
  const wv = $('webview-' + state.activeTab);
  try { return Number(wv?.getWebContentsId?.()) || 0; } catch { return 0; }
}

function updateHlsCaptureUi() {
  const status = $('hls-capture-status');
  const button = $('hls-capture-toggle');
  if (status) {
    status.textContent = state.hlsCaptureActive ? 'Activa' : 'Inactiva';
    status.className = 'badge ' + (state.hlsCaptureActive ? 'green' : 'gray');
  }
  if (button) button.textContent = state.hlsCaptureActive ? 'Detener captura' : 'Iniciar captura';
}

function renderCapturedHls() {
  const list = $('hls-captured-list');
  if (!list) return;
  if (!state.hlsCaptureItems.size) {
    list.className = 'streams-empty';
    list.textContent = 'Sin enlaces HLS capturados';
    return;
  }
  list.className = '';
  list.innerHTML = Array.from(state.hlsCaptureItems.entries()).reverse().map(([key, item]) => {
    const referer = item.referer
      ? '<div style="display:flex;align-items:flex-start;gap:8px;margin-top:7px;flex-wrap:wrap;"><span style="color:var(--muted);">Referer:</span><code style="flex:1;min-width:180px;overflow-wrap:anywhere;">' + escapeHtml(item.referer) + '</code><button class="btn ghost btn-sm" data-copy-hls-value="' + escapeHtml(item.referer) + '">Copiar referer</button></div>'
      : '<div style="margin-top:7px;color:var(--muted);">La petición no incluyó Referer</div>';
    return '<div class="stream-row" style="align-items:flex-start;flex-wrap:wrap;"><div style="flex:1;min-width:220px;"><div style="font-weight:700;margin-bottom:5px;">Playlist HLS</div><code style="display:block;overflow-wrap:anywhere;">' + escapeHtml(item.url) + '</code>' + referer + '<div style="margin-top:6px;color:var(--muted);font-size:.72rem;">Página: ' + escapeHtml(item.pageUrl || 'No disponible') + '</div></div><span class="stream-actions"><button class="btn ghost btn-sm" data-copy-hls-value="' + escapeHtml(item.url) + '">Copiar URL</button><button class="btn warn btn-sm" data-open-hls-key="' + escapeHtml(key) + '">Abrir MC Player</button></span></div>';
  }).join('');
}

function addCapturedHlsItem(item) {
  if (!state.hlsCaptureActive || !item?.url) return;
  const activeId = getActiveHlsCaptureWebContentsId();
  const eventId = Number(item.webContentsId) || 0;
  if (activeId && eventId && activeId !== eventId) return;
  const pageUrl = item.pageUrl || '';
  const activePage = getActivePageUrl();
  if ((!activeId || !eventId) && pageUrl && activePage) {
    try {
      if (new URL(pageUrl).origin !== new URL(activePage).origin) return;
    } catch {}
  }
  const key = item.url + '|' + pageUrl;
  const existing = state.hlsCaptureItems.get(key);
  if (existing) {
    if (!existing.referer && item.referer) existing.referer = item.referer;
  } else {
    state.hlsCaptureItems.set(key, {
      url: item.url,
      referer: item.referer || '',
      pageUrl,
      detectedAt: item.detectedAt || Date.now()
    });
  }
  while (state.hlsCaptureItems.size > 100) state.hlsCaptureItems.delete(state.hlsCaptureItems.keys().next().value);
  renderCapturedHls();
}

async function toggleHlsCapture() {
  const button = $('hls-capture-toggle');
  if (button) button.disabled = true;
  try {
    state.hlsCaptureActive = await mc.setHlsCapture(!state.hlsCaptureActive);
    updateHlsCaptureUi();
    addSidebarLog('info', state.hlsCaptureActive ? '[STREAM] Captura HLS de red activada' : '[STREAM] Captura HLS de red detenida');
  } catch {
    addSidebarLog('blocked', '[STREAM] No se pudo cambiar la captura HLS');
  } finally {
    if (button) button.disabled = false;
  }
}

function clearCapturedHls() {
  state.hlsCaptureItems.clear();
  renderCapturedHls();
}

async function openCapturedHlsInPlayer(key) {
  const item = state.hlsCaptureItems.get(key);
  if (!item) return;
  const referer = item.referer || (/live\.getcirca\.run/i.test(item.url) ? 'https://www.snt.com.py/' : '');
  const token = 'mchls' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  try {
    if (!await mc.setHlsPlayerReferer(token, referer)) throw new Error('No se pudo registrar el Referer');
    openStreamResource(item.url, 'HLS', item.pageUrl, token, referer);
  } catch {
    addSidebarLog('blocked', '[STREAM] No se pudo preparar el Referer de MC Player');
  }
}

async function openManualStreamTarget() {
  const url = String($('hls-manual-url')?.value || '').trim();
  const referer = String($('hls-manual-referer')?.value || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    addSidebarLog('blocked', '[STREAM] Introduce una URL HTTP(S) válida');
    return;
  }
  if (referer && !/^https?:\/\//i.test(referer)) {
    addSidebarLog('blocked', '[STREAM] El Referer debe ser una URL HTTP(S)');
    return;
  }
  if (!/\.m3u8(?:[?#].*)?$/i.test(url)) {
    const token = 'mchls' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    openStreamResource(url, 'CONTAINER', referer, token, referer);
    addSidebarLog('info', '[STREAM] Abriendo el contenedor dentro de MC Player con su Referer');
    return;
  }
  const token = 'mchls' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  try {
    if (!await mc.setHlsPlayerReferer(token, referer)) throw new Error('No se pudo registrar el Referer');
    openStreamResource(url, 'HLS', referer, token, referer);
  } catch {
    addSidebarLog('blocked', '[STREAM] No se pudo preparar la configuración de MC Player');
  }
}

$('hls-captured-list')?.addEventListener('click', async event => {
  const button = event.target.closest('[data-copy-hls-value], [data-open-hls-key]');
  if (!button) return;
  if (button.dataset.openHlsKey) {
    await openCapturedHlsInPlayer(button.dataset.openHlsKey);
    return;
  }
  try {
    await navigator.clipboard.writeText(button.dataset.copyHlsValue || '');
    addSidebarLog('info', '[STREAM] Valor HLS copiado');
  } catch {
    addSidebarLog('blocked', '[STREAM] No se pudo copiar el valor HLS');
  }
});

if (window.mc?.on) mc.on('streams:hls-captured', addCapturedHlsItem);
mc.setHlsCapture().then(active => {
  state.hlsCaptureActive = active === true;
  updateHlsCaptureUi();
}).catch(() => {});

function addStreamItem(item) {
  const activePage = getActivePageUrl();
  const currentPage = (activePage && /^https?:/i.test(activePage)) ? activePage : (item.pageUrl && /^https?:/i.test(item.pageUrl) ? item.pageUrl : '');
  item.pageUrl = currentPage || item.pageUrl || '';
  item.displayName = currentPage || item.displayName || item.pageUrl || '';
  const key = item.url + '|' + currentPage;
  const existing = state.streamItems.get(key) || state.streamItems.get(item.url);
  if (existing) {
    if (currentPage && existing.pageUrl !== currentPage) {
      existing.pageUrl = currentPage;
      existing.displayName = currentPage;
      enrichStreamItem(existing);
      renderStreams();
      renderSidebarStreams();
      addSidebarLog('modified', '[STREAM] Origen actualizado → ' + (existing.displayName || existing.subtitle) + ' [' + existing.pageUrl + ']');
    }
    return;
  }
  enrichStreamItem(item);
  if (!shouldShowStreamItem(item)) return;
  state.streamItems.set(key, item);
  while (state.streamItems.size > 200) state.streamItems.delete(state.streamItems.keys().next().value);
  renderStreams();
  renderSidebarStreams();
  setText('streams-count-badge', state.streamItems.size + ' streams');
  addSidebarLog('modified', '[STREAM] ' + (item.displayName || item.subtitle) + ' [' + (item.pageUrl || '') + ']: ' + item.url.substring(0, 40) + '...');
}

function describeResource(url, type, ctx) {
  const pageUrl = (ctx && ctx.pageUrl) || '';
  const displayName = ctx && ctx.displayName;
  const literalTitle = detectStreamOrigin(pageUrl) || (typeof displayName === 'string' && /^https?:\/\//i.test(displayName) ? displayName : '');
  if (literalTitle) {
    return {
      title: literalTitle,
      host: literalTitle,
      badges: type ? [{ text: type, className: '' }] : [],
      expiry: null
    };
  }
  if (displayName) {
    const origin = (ctx && ctx.origin) || detectStreamOrigin(pageUrl);
    const container = (ctx && ctx.container) || detectStreamContainer(pageUrl);
    return {
      title: displayName,
      host: origin || container || 'Stream detectado',
      badges: type ? [{ text: type, className: '' }] : [],
      expiry: null
    };
  }
  try {
    const parsed = new URL(url);
    const file = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname);
    const cleanName = file.replace(/\.(m3u8|mpd|mp4|webm|mkv|avi|mov)$/i, '').replace(/[_-]+/g, ' ').trim();
    const params = new URLSearchParams(parsed.search);
    const tokenKeys = ['k', 'token', 'auth', 'signature', 'sign', 'sig', 'hash', 'key', 'hdnea'];
    const hasToken = tokenKeys.some(key => params.has(key));
    const expRaw = params.get('exp') || params.get('expires') || params.get(' Expires'.trim());
    const expSeconds = expRaw && /^\d{9,13}$/.test(expRaw) ? (expRaw.length > 10 ? Number(expRaw) / 1000 : Number(expRaw)) : 0;
    const badges = [];
    let state = 'Fijo';
    if (expSeconds) {
      const expiry = new Date(expSeconds * 1000);
      const remaining = expiry.getTime() - Date.now();
      state = remaining > 0 ? 'Temporal' : 'Fecha indicada pasada';
      badges.push({ text: state, className: 'warn' });
      badges.push({ text: remaining > 0 ? `Expira ${formatExpiry(remaining, expiry)}` : `Fecha indicada: ${expiry.toLocaleString('es')}`, className: 'warn' });
    } else {
      badges.push({ text: state, className: 'good' });
    }
    if (hasToken) badges.push({ text: 'Requiere token', className: 'warn' });
    if (type) badges.push({ text: type, className: '' });
    const origin = detectStreamOrigin(pageUrl);
    const container = detectStreamContainer(pageUrl);
    const role = classifyStreamUrl(url);
    let title = cleanName || parsed.hostname;
    if (/^(master|index|playlist|stream|video|media|seg|segment|chunk|part)$/i.test(title) || title.length < 3) {
      const label = origin || container;
      title = label
        ? (role === 'master' ? label + ' — Principal' : role === 'playlist' ? label + ' — Calidad' : label + ' — Video')
        : ('mcdownload-' + (++_mcStreamSeq));
    }
    return { title, host: origin || container || parsed.hostname.replace(/^www\./i, ''), badges, expiry: expSeconds ? new Date(expSeconds * 1000) : null };
  } catch {
    return { title: 'Recurso detectado', host: '', badges: type ? [{ text: type, className: '' }] : [] };
  }
}

function formatExpiry(remaining, expiry) {
  const minutes = Math.floor(remaining / 60000);
  if (minutes < 1) return 'en menos de 1 min';
  if (minutes < 60) return `en ${minutes} min`;
  if (minutes < 1440) return `en ${Math.floor(minutes / 60)} h`;
  return expiry.toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatStreamTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return ''; }
}

function renderSidebarStreamItemHtml(item) {
  const icon = item.type === 'HLS' ? '📺' : item.type === 'DASH' ? '💾' : '🎥';
  const info = describeResource(item.url, item.type, item);
  const visibleTitle = item.pageUrl || item.origin || info.title || item.url || 'URL no disponible';
  const label = visibleTitle.length > 36 ? visibleTitle.substring(0, 33) + '...' : visibleTitle;
  const host = item.pageUrl || item.origin || info.host || '';
  const badges = info.badges.map(b => '<span class="resource-badge '+b.className+'">'+escapeHtml(b.text)+'</span>').join('');
  const fragBadge = isStreamFragment(item.url) ? '<span class="resource-badge warn">Frag</span>' : '';
  const timeBadge = item.detectedAt ? '<span class="resource-badge" title="Detectado a las ' + formatStreamTime(item.detectedAt) + '">🕐 ' + formatStreamTime(item.detectedAt) + '</span>' : '';
  const safeUrl = item.url.replace(/'/g,"\\'");
  const dlName = friendlyFileName(item.url, item.type, item.pageUrl || item.origin || item.displayName, visibleTitle).replace(/'/g, "\\'");
  return '<div class="stream-row">' +
    '<span style="flex-shrink:0;">' + icon + '</span>' +
    '<span class="resource-summary"><span class="resource-name">' + escapeHtml(label) + '</span>' +
    (host ? '<span class="resource-host" style="display:block;font-size: 0.615rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="'+escapeHtml(item.pageUrl||'')+'">' + escapeHtml(host) + '</span>' : '') +
    '<span class="resource-details">' + badges + fragBadge + timeBadge + '</span></span>' +
    '<span class="stream-actions"><button class="btn ghost btn-sm" onclick="openStreamResource(\'' + safeUrl + '\',\'' + (item.type||'') + '\',\'' + (item.pageUrl||'').replace(/'/g,"\\'") + '\')" title="Abrir recurso">Abrir</button>' +
    '<button class="btn warn btn-sm" onclick="dlMedia(\'' + safeUrl + '\',\'' + (item.type||'MP4') + '\',\'' + (item.pageUrl||'').replace(/'/g,"\\'") + '\',\'' + dlName + '\')" title="Descargar">DL</button>' +
    '<button class="btn ghost btn-sm" onclick="askStreamToAI(\'' + safeUrl + '\',\'' + (item.type||'Stream') + '\')" title="Analizar con IA">MC-AI</button></span>' +
  '</div>';
}

function renderSidebarStreams() {
  const containers = [$('resources-streams-list')].filter(Boolean);
  if (!containers.length) return;
  if (state.streamItems.size === 0) {
    containers.forEach(container => { container.innerHTML = '<div class="streams-empty"><div style="font-size:1.2rem;margin-bottom:7px;opacity:.7;">◌</div>Sin streams detectados</div>'; });
    return;
  }
  const items = Array.from(state.streamItems.values()).reverse();
  const primary = items.filter(i => /^(HLS|DASH)$/i.test(i.type || '') || /\.(m3u8|mpd)(\?|#|$)/i.test(i.url));
  let markup = primary.map(renderSidebarStreamItemHtml).join('');
  if (!markup) markup = '<div class="streams-empty"><div style="font-size:1.2rem;margin-bottom:7px;opacity:.7;">◌</div>Sin streams reproducibles detectados</div>';
  containers.forEach(container => { container.innerHTML = markup; });
}

function openStreamResource(url, type, pageUrl, refererToken = '', refererValue = '') {
  if (!url) return;
  const isContainer = /^CONTAINER$/i.test(type || '');
  if (!isContainer && !/^(HLS|DASH)$/i.test(type || '') && !/\.(m3u8|mpd)(?:\?|#|$)/i.test(url)) {
    addTab(url, pageUrl);
    return;
  }
  const playbackUrl = url;
  const isAudio = /audio/i.test(type || '');
  const tag = isAudio ? 'audio' : 'video';
  const hls = !isContainer && (/\.(m3u8)(?:\?|#|$)/i.test(url) || /HLS/i.test(type || ''));
  const hlsScript = hls ? '<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"><\/script>' : '';
  const hlsPlayerToken = JSON.stringify(refererToken || '');
  const hlsInit = hls ? `<script>
    (() => {
      const video = document.getElementById('videoElement');
      const status = document.getElementById('status');
      const statusText = status.querySelector('span:last-child');
      const stage = document.getElementById('stage');
      const playerToken = ${hlsPlayerToken};
      const url = ${JSON.stringify(playbackUrl)};
      const referer = ${JSON.stringify(refererValue || '')};
      const setStatus = (text, kind) => {
        statusText.textContent = text;
        status.className = 'status' + (kind ? ' ' + kind : '');
      };
      video.addEventListener('canplay', () => { stage.classList.add('ready'); setStatus('Reproduciendo', 'ok'); });
      video.addEventListener('error', () => setStatus('No se pudo reproducir la fuente', 'error'));
      async function initPlayer() {
        if (!/^https?:\\/\\/.+\\.m3u8(?:[?#].*)?$/i.test(url)) {
          setStatus('Introduce una URL HLS .m3u8 válida', 'error');
          return;
        }
        setStatus('Aplicando Referer y conectando...', '');
        if (playerToken && window.__mcSelectionBridge?.setHlsReferer) {
          const applied = await window.__mcSelectionBridge.setHlsReferer(playerToken, referer);
          if (!applied) { setStatus('MC Browser no pudo aplicar el Referer', 'error'); return; }
        }
        if (window.hlsInstance) { window.hlsInstance.destroy(); window.hlsInstance = null; }
        stage.classList.remove('ready');
        if (window.Hls && Hls.isSupported()) {
          const hlsInstance = new Hls({
            debug: false,
            enableWorker: true,
            maxBufferLength: 60,
            maxMaxBufferLength: 120,
            maxBufferSize: 180 * 1000 * 1000
          });
          window.hlsInstance = hlsInstance;
          hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
            setStatus('Manifest cargado. Reproduciendo...', '');
            video.play().catch(() => setStatus('Manifest cargado. Pulsa play para reproducir.', ''));
          });
          hlsInstance.on(Hls.Events.ERROR, (_, data) => {
            if (!data.fatal) return;
            const code = data.response?.code ? ' HTTP ' + data.response.code : '';
            setStatus('Error HLS' + code + ': ' + (data.details || 'fuente no disponible'), 'error');
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hlsInstance.recoverMediaError();
          });
          hlsInstance.loadSource(url);
          hlsInstance.attachMedia(video);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
          setStatus('Reproducción HLS nativa', '');
        } else {
          setStatus('HLS.js no está disponible en este navegador', 'error');
        }
      }
      initPlayer();
    })();
  <\/script>` : isContainer ? `<script>
    (() => {
      const frame = document.getElementById('containerFrame');
      const status = document.getElementById('status');
      const statusText = status.querySelector('span:last-child');
      const stage = document.getElementById('stage');
      const token = ${hlsPlayerToken};
      const url = ${JSON.stringify(playbackUrl)};
      const referer = ${JSON.stringify(refererValue || '')};
      let targetNavigationStarted = false;
      frame.addEventListener('load', () => {
        if (!targetNavigationStarted) return;
        stage.classList.add('ready');
        statusText.textContent = 'Contenedor cargado';
      });
      frame.addEventListener('error', () => { statusText.textContent = 'No se pudo cargar el contenedor'; });
      (async () => {
        statusText.textContent = 'Aplicando Referer y cargando contenedor...';
        const applyReferer = window.__mcSelectionBridge?.setHlsEntryReferer;
        if (!token || !applyReferer) {
          status.classList.add('error');
          statusText.textContent = 'No se pudo preparar el Referer del contenedor';
          return;
        }
        const applied = await applyReferer(token, url, referer);
        if (!applied) {
          status.classList.add('error');
          statusText.textContent = 'MC Browser no pudo aplicar el Referer';
          return;
        }
        targetNavigationStarted = true;
        frame.src = url;
      })().catch(() => {
        status.classList.add('error');
        statusText.textContent = 'No se pudo preparar el contenedor';
      });
    })();
  <\/script>` : `<script>document.querySelector('#status span:last-child').textContent='Listo para reproducir';<\/script>`;
  const sourceAttr = hls || isContainer ? '' : ` src="${escapeHtml(playbackUrl)}"`;
  const mediaLabel = isAudio ? 'Audio' : 'Video';
  const streamLabel = isContainer ? 'Contenedor' : type || (hls ? 'HLS' : 'Stream');
  const playerElement = isContainer
    ? '<iframe id="containerFrame" title="Contenedor del canal" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>'
    : `<${tag} controls autoplay${sourceAttr}></${tag}>`;
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MC Player · ${escapeHtml(streamLabel)}</title><style>
    :root{color-scheme:dark;--bg:#0b0d11;--panel:#12161d;--panel-soft:#171c24;--line:#29313d;--text:#edf2f4;--muted:#8d98a6;--accent:#ffab4a;--accent-soft:rgba(255,171,74,.14);--good:#59d39b;--danger:#ff7373}
    *{box-sizing:border-box}body{position:relative;margin:0;min-height:100vh;overflow-x:hidden;background-color:var(--bg);background-image:linear-gradient(rgba(104,122,145,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(104,122,145,.045) 1px,transparent 1px),radial-gradient(circle at 50% -15%,#303743 0,#161b23 34%,var(--bg) 72%);background-size:32px 32px,32px 32px,100% 100%;color:var(--text);font:14px/1.45 "Segoe UI",system-ui,sans-serif;padding:clamp(18px,4vw,48px)}body:before{position:fixed;inset:0;pointer-events:none;content:"";background:linear-gradient(115deg,transparent 0 46%,rgba(255,171,74,.035) 46.1%,transparent 46.5% 100%);mask-image:linear-gradient(to bottom,rgba(0,0,0,.8),transparent 75%)}
    .player-shell{position:relative;width:min(1120px,100%);margin:0 auto;padding:clamp(16px,2.8vw,30px);background:linear-gradient(145deg,rgba(27,33,43,.94),rgba(10,13,18,.96));border:1px solid #333d4b;border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.46),inset 0 1px rgba(255,255,255,.055)}.player-shell:before,.player-shell:after{position:absolute;content:"";width:38px;height:38px;border-color:rgba(255,171,74,.5);pointer-events:none}.player-shell:before{top:-1px;left:-1px;border-top:2px solid;border-left:2px solid;border-radius:16px 0 0}.player-shell:after{right:-1px;bottom:-1px;border-right:2px solid;border-bottom:2px solid;border-radius:0 0 16px}
    .topbar{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:22px;padding:0 4px}.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.02em}.brand-mark{position:relative;width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 18px rgba(255,171,74,.7)}.brand-mark:after{position:absolute;inset:-5px;content:"";border:1px solid rgba(255,171,74,.35);border-radius:50%}.brand-name{font-size:15px}.brand-sub{color:#667383;font:10px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase}.stream-badge{display:inline-flex;align-items:center;gap:7px;border:1px solid #56402b;background:linear-gradient(135deg,rgba(255,171,74,.18),rgba(255,171,74,.06));border-radius:5px;color:#ffc477;font:700 10px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.1em;padding:7px 10px;text-transform:uppercase}.stream-badge i{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent)}
    .stage{position:relative;overflow:hidden;min-height:clamp(220px,55vw,620px);display:flex;align-items:center;justify-content:center;background:#050607;border:1px solid #3a4655;border-radius:10px;box-shadow:0 18px 45px rgba(0,0,0,.42),0 0 0 5px rgba(5,7,10,.35),inset 0 0 0 1px rgba(255,255,255,.025)}.stage:before{position:absolute;inset:0;content:"";pointer-events:none;background:linear-gradient(90deg,rgba(255,171,74,.08),transparent 18%,transparent 82%,rgba(255,171,74,.05)),repeating-linear-gradient(0deg,transparent 0 3px,rgba(255,255,255,.012) 4px);z-index:2}.stage:after{position:absolute;top:12px;right:12px;width:7px;height:7px;content:"";border-top:1px solid rgba(255,171,74,.75);border-right:1px solid rgba(255,171,74,.75);z-index:3}.stage video,.stage audio{display:block;width:100%;height:auto;max-height:calc(100vh - 260px);background:#050607;object-fit:contain}.stage iframe{position:absolute;inset:0;z-index:1;width:100%;height:100%;border:0;background:#050607}audio{width:min(680px,90%);margin:80px auto}.stage:has(audio){min-height:220px;background:linear-gradient(145deg,#17130e,#080a0d)}
    .stage-placeholder{position:absolute;display:grid;place-items:center;gap:12px;color:#7d8997;pointer-events:none;z-index:1;font:11px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase}.pulse{width:38px;height:38px;border:2px solid #3b424d;border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;box-shadow:0 0 18px rgba(255,171,74,.12)}@keyframes spin{to{transform:rotate(360deg)}}
    .stage:has(video) .stage-placeholder{z-index:0}.stage video,.stage audio{position:relative;z-index:1}.stage.ready .stage-placeholder{display:none}
    .player-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 5px 0}.status{display:flex;align-items:center;gap:8px;color:var(--muted);font:11px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.04em}.status-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px rgba(255,171,74,.55)}.status.ok{color:var(--good)}.status.ok .status-dot{background:var(--good);box-shadow:0 0 8px rgba(89,211,155,.55)}.status.error{color:var(--danger)}.status.error .status-dot{background:var(--danger)}
    details.source{margin-top:22px;border-top:1px solid #29323e;padding-top:15px}details.source summary{cursor:pointer;color:#778493;font:10px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.08em;list-style:none;text-transform:uppercase}details.source summary::-webkit-details-marker{display:none}details.source summary:before{content:"";display:inline-block;width:6px;height:6px;border-right:1px solid currentColor;border-bottom:1px solid currentColor;transform:rotate(-45deg);margin:0 9px 1px 2px}details.source[open] summary:before{transform:rotate(45deg);margin-bottom:3px}code{display:block;margin-top:12px;overflow-wrap:anywhere;color:#aab5c2;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;background:#0c1015;border:1px solid #29323e;border-radius:6px;padding:11px 13px}
    @media(max-width:600px){body{padding:16px}.topbar{margin-bottom:14px}.brand-sub{display:none}.player-footer{align-items:flex-start;flex-direction:column;gap:8px}.stage{border-radius:7px}}
  </style></head><body><main class="player-shell"><header class="topbar"><div class="brand"><span class="brand-mark"></span><span class="brand-name">MC Player</span><span class="brand-sub">/ ${mediaLabel}</span></div><span class="stream-badge"><i></i>${escapeHtml(streamLabel)}</span></header><section class="stage" id="stage"><div class="stage-placeholder"><span class="pulse"></span><span>Conectando con la señal</span></div>${playerElement}</section><footer class="player-footer"><div class="status" id="status"><span class="status-dot"></span><span>Preparando reproducción</span></div><span style="color:var(--muted);font-size:11px">MC Browser</span></footer><details class="source"><summary>Información de la fuente</summary><code>${escapeHtml(playbackUrl)}</code></details></main>${hlsScript}${hlsInit}</body></html>`;
  const sourceCode = '<code>' + escapeHtml(playbackUrl) + '</code></details>';
  const refererCode = '<code>' + escapeHtml(refererValue || 'No configurado') + '</code></details>';
  const sourceTitle = isContainer ? 'URL del contenedor' : 'Stream HLS URL';
  const sourceWithReferer = '<div style="color:#778493;font-size:10px;margin-top:14px;text-transform:uppercase;">' + sourceTitle + '</div><code>' + escapeHtml(playbackUrl) + '</code><div style="color:#778493;font-size:10px;margin-top:12px;text-transform:uppercase;">Referer</div>' + refererCode;
  let playerHtml = hls || isContainer
    ? html.replace(sourceCode, sourceWithReferer)
      .replace('<' + tag + ' controls autoplay', '<' + tag + ' id="videoElement" controls autoplay')
    : html;
  if (refererToken) playerHtml = playerHtml.replace('<body>', '<body data-mc-hls-player="' + escapeHtml(refererToken) + '">');
  addTab('data:text/html;charset=utf-8,' + encodeURIComponent(playerHtml), pageUrl);
}

function askStreamToAI(url, type) {
  if (typeof AI !== 'undefined' && AI && typeof AI.askMedia === 'function') {
    AI.askMedia(url, type);
  } else {
    addSidebarLog('blocked', '[AI] Módulo IA no cargado');
  }
}

function renderStreamItemHtml(item) {
  const icon = item.type === 'HLS' ? '📺' : item.type === 'DASH' ? '💾' : '🎥';
  const tag = item.via ? `<div class="media-via" title="${item.via}">via: ${item.via}</div>` : '';
  const info = describeResource(item.url, item.type, item);
  const visibleTitle = item.pageUrl || item.origin || info.title || item.url || 'URL no disponible';
  const badges = info.badges.map(b => `<span class="resource-badge ${b.className}">${escapeHtml(b.text)}</span>`).join('');
  const fragBadge = isStreamFragment(item.url) ? '<span class="resource-badge warn">Fragmento</span>' : '';
  const timeBadge = item.detectedAt ? `<span class="resource-badge" title="Detectado a las ${formatStreamTime(item.detectedAt)}">🕐 ${formatStreamTime(item.detectedAt)}</span>` : '';
  const dlName = friendlyFileName(item.url, item.type, item.pageUrl || item.origin || item.displayName, visibleTitle).replace(/'/g, "\\'");
  return `
    <div class="media-item">
      <div class="media-icon">${icon}</div>
      <div class="media-info">
        <div class="media-url-lbl">${escapeHtml(visibleTitle)}</div>
        <div class="resource-details">${badges}${fragBadge}${timeBadge}</div>
        <div class="media-meta" title="${escapeHtml(item.pageUrl || '')}">${escapeHtml(info.host)}</div>
        ${item.type ? `<div class="media-type-row"><span class="media-type-lbl">${item.type} Stream</span>${tag}</div>` : ''}
        <div class="media-actions">
          <button class="btn ghost btn-sm" onclick="openStreamResource('${item.url.replace(/'/g,"\\'")}','${item.type||''}','${(item.pageUrl||'').replace(/'/g,"\\'")}')">Abrir</button>
          <button class="btn warn btn-sm" onclick="dlMedia('${item.url.replace(/'/g,"\\'")}','${item.type||'MP4'}','${(item.pageUrl||'').replace(/'/g,"\\'")}','${dlName}')">⬇ DL</button>
        </div>
      </div>
    </div>
  `;
}

function renderStreams() {
  const list = $('streams-list');
  if (!list) return;
  
  if (state.streamItems.size === 0) {
    list.innerHTML = '<div style="color:var(--muted);font-size: 0.923rem;text-align:center;padding:24px;border:1px dashed var(--border);border-radius:var(--radius);">📡 Navega a una página con video para detectar streams automáticamente</div>';
    return;
  }
  
  const items = Array.from(state.streamItems.values()).reverse();
  const primary = items.filter(i => /^(HLS|DASH)$/i.test(i.type || '') || /\.(m3u8|mpd)(\?|#|$)/i.test(i.url));
  let html = primary.map(renderStreamItemHtml).join('');
  if (!html) html = '<div style="color:var(--muted);font-size: .923rem;text-align:center;padding:24px;border:1px dashed var(--border);border-radius:var(--radius);">No hay streams reproducibles detectados</div>';
  list.innerHTML = html;
}

function copyStreams() {
  const urls = Array.from(state.streamItems.values()).map(i => i.url).join('\n');
  navigator.clipboard.writeText(urls).then(() => {
    addSidebarLog('info', '[STREAM] URLs copiadas al portapapeles');
  }).catch(err => {
    console.error('[STREAM] Error al copiar:', err);
    addSidebarLog('blocked', '[STREAM] Error al copiar URLs');
  });
}

async function scanStreams() {
  const sessionWebContentsId = window.Sessions?._wv?.getWebContentsId?.();
  if (!state.activeTab && !sessionWebContentsId) return;
  state.streamItems.clear();
  renderStreams();
  renderSidebarStreams();
  addSidebarLog('info', '[STREAM] Escaneando streams...');
  try {
    const currentPage = getActivePageUrl();
    const scanTarget = sessionWebContentsId ? { webContentsId: sessionWebContentsId } : state.activeTab;
    const result = await mc.scanStreams(scanTarget);
    if (result && Array.isArray(result)) {
      result.forEach(item => {
        addStreamItem({
          url: item.url,
          via: item.via,
          pageUrl: currentPage || item.pageUrl || getActivePageUrl(),
          displayName: currentPage || item.displayName || item.pageUrl || getActivePageUrl(),
          author: item.author || null,
          type: item.url.includes('.m3u8') ? 'HLS' : item.url.includes('.mpd') ? 'DASH' : 'MP4'
        });
      });
    }
    if (!result?.length) {
      // Reintento tras un breve retardo (los recursos pueden tardar en registrarse)
      setTimeout(async () => {
        const retry = await mc.scanStreams(scanTarget).catch(() => []);
        if (Array.isArray(retry)) {
          const retryPage = getActivePageUrl();
          retry.forEach(item => addStreamItem({
            url: item.url, via: item.via, pageUrl: retryPage || item.pageUrl || getActivePageUrl(),
            displayName: retryPage || item.displayName || item.pageUrl || getActivePageUrl(),
            author: item.author || null,
            type: item.url.includes('.m3u8') ? 'HLS' : item.url.includes('.mpd') ? 'DASH' : 'MP4'
          }));
        }
        if (!retry?.length) addSidebarLog('info', '[STREAM] No se detectaron streams en esta página');
      }, 1500);
    } else {
      addSidebarLog('info', '[STREAM] ' + result.length + ' stream(s) detectado(s)');
    }
  } catch (err) {
    console.error('[STREAM] Error al escanear:', err);
    addSidebarLog('blocked', '[STREAM] Error al escanear streams');
  }
}

window.scanStreams = scanStreams;

// ── yt-dlp ──────────────────────────────────────
function checkYtDlpStatus() {
  const ind = $('ytdlp-indicator');
  const btn = $('ytdlp-install-btn');
  const log = $('ytdlp-log');
  if (!ind) return;
  ind.className = 'badge gray';
  ind.textContent = 'Verificando...';
  mc.ytdlpVersion().then(v => {
    if (v) {
      ind.className = 'badge green';
      ind.textContent = '✓ yt-dlp ' + v;
      if (btn) btn.textContent = '⬆ Actualizar';
      if (log) log.innerHTML = '✓ yt-dlp v' + v + ' instalado correctamente<br>';
    } else {
      mc.ytdlpCheck().then(r => {
        if (r) {
          ind.className = 'badge green';
          ind.textContent = '✓ yt-dlp instalado';
          if (btn) btn.textContent = '⬆ Actualizar';
        } else {
          ind.className = 'badge red';
          ind.textContent = '✗ No instalado';
          if (btn) btn.textContent = '⬇ Instalar yt-dlp';
        }
      }).catch(() => {
        ind.className = 'badge red';
        ind.textContent = '✗ No instalado';
      });
    }
  }).catch(() => {
    ind.className = 'badge red';
    ind.textContent = '✗ No instalado';
  });
}

function installYtDlp() {
  const btn = $('ytdlp-install-btn');
  const log = $('ytdlp-log');
  const ind = $('ytdlp-indicator');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Instalando...'; }
  if (log) log.innerHTML = 'Descargando yt-dlp...<br>';
  mc.ytdlpInstall().then(r => {
    if (r && r.ok) {
      if (log) log.innerHTML += '✓ yt-dlp instalado<br>';
    } else {
      if (log) log.innerHTML += '✗ Error: ' + (r?.error || 'desconocido') + '<br>';
      if (btn) { btn.disabled = false; btn.textContent = '⬇ Instalar yt-dlp'; }
      if (ind) { ind.className = 'badge red'; ind.textContent = '✗ Error'; }
    }
    checkYtDlpStatus();
  }).catch(e => {
    if (log) log.innerHTML += '✗ Error: ' + e + '<br>';
    if (btn) { btn.disabled = false; btn.textContent = '⬇ Instalar yt-dlp'; }
    if (ind) { ind.className = 'badge red'; ind.textContent = '✗ Error'; }
  });
}

window.checkYtDlpStatus = checkYtDlpStatus;
window.installYtDlp = installYtDlp;

function copyUrl(url) {
  if (navigator.clipboard) navigator.clipboard.writeText(url).catch(()=>{});
  addSidebarLog('info','[CLIP] URL copiada');
}

