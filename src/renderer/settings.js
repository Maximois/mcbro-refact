// ── elementos bloqueados (reglas cosméticas) ───
async function reapplyCosmeticFilters() {
  const wv = $('webview-' + state.activeTab);
  if (!wv || typeof wv.insertCSS !== 'function') return;
  try {
    const pageUrl = wv.getURL();
    if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) return;
    const result = await mc.adblockCosmetics(pageUrl);
    if (result?.ok && result.css) {
      await wv.insertCSS(result.css);
      addSidebarLog('modified', '[ELEMENT] Filtros cosméticos reaplicados (' + (result.count || 0) + ' reglas)');
    } else {
      addSidebarLog('info', '[ELEMENT] Sin filtros cosméticos que aplicar');
    }
  } catch {}
}

async function renderCosmeticRules() {
  // La fuente de verdad vive en main/adblocker; el estado local puede quedar
  // atrasado después de bloquear desde el menú contextual.
  try {
    const result = await mc.adblockListCosmetics();
    if (result?.ok && Array.isArray(result.rules)) {
      state.cfg = state.cfg || {};
      state.cfg.userCosmeticRules = result.rules;
    }
  } catch {}
  const allRules = Array.isArray(state.cfg?.userCosmeticRules) ? state.cfg.userCosmeticRules : [];
  // Obtener dominio de la página activa
  let currentDomain = '';
  try {
    const wv = $('webview-' + state.activeTab);
    if (wv && typeof wv.getURL === 'function') {
      const url = wv.getURL();
      if (url && /^https?:\/\//i.test(url)) {
        currentDomain = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
      }
    }
  } catch {}
  // Filtrar reglas aplicables al dominio actual
  const rules = allRules.filter(rule => {
    const domain = normalizeDomainInput(String(rule).split('##')[0].trim());
    if (!domain) return true; // reglas globales
    return currentDomain && (currentDomain === domain || currentDomain.endsWith('.' + domain));
  });
  // Panel de permisos (solo se muestra si hay página activa)
  const permList = $('permissions-cosmetic-list');
  if (permList) {
    const permCount = $('permissions-cosmetic-count');
    if (permCount) permCount.textContent = rules.length + ' elemento(s)';
    if (!rules.length) {
      permList.innerHTML = '<div class="bp-empty"><div class="bp-empty-icon">&#128683;</div><div>Sin elementos bloqueados en esta página</div></div>';
    } else {
      permList.innerHTML = rules.map((rule, i) => {
        const [domain, selector] = String(rule).split('##');
        const safeRule = escapeHtml(String(rule));
        const ruleArgument = escapeHtml(JSON.stringify(String(rule)));
        return '<div class="perm-cosmetic-row">'
          + '<div class="perm-cosmetic-main">'
          + '<strong title="' + safeRule + '">' + escapeHtml(selector || rule) + '</strong>'
          + '<span>' + escapeHtml(domain || 'todos los sitios') + '</span>'
          + '</div>'
          + '<div class="perm-cookie-actions"><button class="mini-btn danger" onclick="unblockCosmeticRule(' + ruleArgument + ')" title="Quitar este bloqueo">Desbloquear</button></div>'
          + '</div>';
      }).join('');
    }
  }
}

async function unblockCosmeticRule(rule) {
  const rules = Array.isArray(state.cfg?.userCosmeticRules) ? state.cfg.userCosmeticRules : [];
  const target = String(rule || '');
  if (!target || !rules.includes(target)) return;
  const r = await mc.adblockRemoveCosmetic({ raw: target });
  if (r?.ok) {
    state.cfg.userCosmeticRules = rules.filter(item => item !== target);
    await renderCosmeticRules();
    addSidebarLog('allowed', '[ELEMENT] Desbloqueado: ' + target);
    const wv = $('webview-' + state.activeTab);
    reloadTab(state.activeTab);
  } else {
    addSidebarLog('blocked', '[ELEMENT] No se pudo desbloquear: ' + (r?.error || 'error'));
  }
}

async function unblockAllCosmeticRules() {
  const rules = Array.isArray(state.cfg?.userCosmeticRules) ? [...state.cfg.userCosmeticRules] : [];
  if (!rules.length) return;
  let removed = 0;
  for (const rule of rules) {
    const r = await mc.adblockRemoveCosmetic({ raw: rule });
    if (r?.ok) removed++;
  }
  state.cfg.userCosmeticRules = [];
  renderCosmeticRules();
  addSidebarLog('allowed', '[ELEMENT] Desbloqueados ' + removed + ' elemento(s)');
  const wv = $('webview-' + state.activeTab);
  reloadTab(state.activeTab);
}
// ── stats ───────────────────────────────────────
function refreshStats() {
  const s = state.stats || {};
  // Sin fallback con '??': STATS siempre inicializa ambos campos, asi que
  // detectedAds es 0 (no undefined) y el camino blocked nunca se tomaba.
  setText('stat-ads',      s.detectedAds);
  setText('stat-trackers', s.detectedTrackers);
  setText('stat-third',    s.detectedThird);
  setText('stat-ads-blocked', s.blockedAds);
  setText('stat-trackers-blocked', s.blockedTrackers);
  setText('stat-third-blocked', s.blockedThird);
  setText('stat-media',    s.detectedMedia);
  setText('stat-req',      s.totalRequests);
  setText('nt-ads',        s.blockedAds);
  setText('nt-trackers',   s.blockedTrackers);
  setText('nt-media',      s.detectedMedia);
  setText('nt-req',        s.totalRequests);
  const total = (s.blockedAds || 0) + (s.blockedTrackers || 0) + (s.blockedThird || 0) + (s.blockedCrypto || 0);
  const pill = $('blocked-pill');
  if (pill) {
    pill.textContent = total + ' bloqueados';
    pill.className = 'blocked-pill' + (total > 50 ? ' danger' : '');
  }
}

async function resetStats() {
  state.stats = await mc.resetStats();
  refreshStats();
  state.reqLog = []; renderReqLog();
  addSidebarLog('info', '[RESET] Estadísticas reiniciadas');
}

// ── protections / config ────────────────────────
async function updateProtections() {
  const patch = {
    blockAds:         $('tog-ads').checked,
    blockTrackers:    $('tog-trackers').checked,
    blockThirdParty:  $('tog-third').checked,
    strictDomainIsolation: $('tog-third').checked,
    spoofUA:          $('tog-headers').checked,
    blockFingerprint: $('tog-fp').checked,
    cookiePolicy:     $('tog-cookies').checked ? 'session' : 'allow-all',
    dohEnabled:       $('tog-doh').checked,
    mediaDetect:      $('tog-media-detect') ? $('tog-media-detect').checked : false,
    httpsOnly:        $('tog-https') ? $('tog-https').checked : true,
  };
  state.cfg = await mc.updateCfg(patch);

  const active = [patch.blockAds, patch.blockTrackers, patch.blockThirdParty, patch.spoofUA, patch.blockFingerprint, patch.cookiePolicy==='session', patch.dohEnabled, patch.mediaDetect].filter(Boolean).length;
  const stEl = $('st-privacy');
  const shield = $('shield-icon');
  if (active === 8)      { stEl.textContent='Privacidad: MÁXIMA'; stEl.style.color=''; shield.textContent='🛡'; }
  else if (active >= 6)  { stEl.textContent='Privacidad: ALTA';   stEl.style.color='var(--warn)'; shield.textContent='⚠'; }
  else if (active >= 4)  { stEl.textContent='Privacidad: MEDIA';  stEl.style.color='var(--warn)'; shield.textContent='⚠'; }
  else                   { stEl.textContent='Privacidad: BAJA';   stEl.style.color='var(--danger)'; shield.textContent='⛔'; }
  $('dot-ads').style.background      = patch.blockAds      ? 'var(--success)' : 'var(--danger)';
  $('dot-trackers').style.background = patch.blockTrackers ? 'var(--success)' : 'var(--danger)';
}

function refreshGpuStatus() {
  const el = $('gpu-status');
  if (!el || !state.cfg) return;
  const configured = state.cfg.gpuAcceleration === true;
  const active = state.cfg.gpuAccelerationActive === true;
  const pending = state.cfg.gpuAccelerationPendingRestart === true;
  if (pending) {
    el.textContent = 'Estado: cambio pendiente — reinicia la app';
    el.style.color = 'var(--warn)';
    return;
  }
  el.textContent = active
    ? 'Estado: activa en esta sesión'
    : 'Estado: desactivada en esta sesión';
  el.style.color = active ? 'var(--success)' : 'var(--muted)';
}

async function updateGpuAcceleration() {
  const enabled = $('tog-gpu') ? $('tog-gpu').checked : false;
  const prev = state.cfg?.gpuAcceleration === true;
  state.cfg = await mc.updateCfg({ gpuAcceleration: enabled });
  refreshGpuStatus();
  if (prev !== enabled) {
    addSidebarLog('modified', '[GPU] Aceleración por GPU ' + (enabled ? 'activada' : 'desactivada') + ' — reinicia la app para aplicar');
  }
}

async function updateUA() {
  const currentUA = $('ua-select').value;
  // NOTA (pendiente, no es bug): 'rotateUA' viaja en este patch pero
  // sanitizeCfgPatch() (main.js, CFG_WRITABLE) no lo incluye en la whitelist,
  // así que se descarta en silencio. Hoy no importa: la rotación de UA está
  // desactivada a propósito porque Google OAuth solo funciona con el UA nativo
  // de Electron, y CFG.rotateUA ni siquiera se aplica (rotateIdentity() es un
  // stub y currentUA solo se guarda/displaya, no se aplica a la página).
  //
  // Cuando se implemente la rotación hay que hacer las DOS cosas:
  //   1. agregar 'rotateUA' a CFG_WRITABLE en main.js como 'bool' para que el
  //      campo deje de filtrarse en silencio;
  //   2. implementar de verdad rotateIdentity() — ojo con dos trampas ya
  //      identificadas en el código:
  //        - el UA efectivo se decide por partición/sesión, no por un toggle
  //          global, porque hay que mantener el UA nativo en la partición de
  //          login de Google;
  //        - applyFP() corre en el mundo aislado del preload y no alcanza la
  //          página, así que un UA por webContents tampoco sería observable
  //          desde el JS de la web sin pasar por otro mecanismo.
  state.cfg = await mc.updateCfg({ currentUA, rotateUA: false });
  setText('st-ua', 'UA: ' + (UA_LABELS[currentUA] || currentUA));
  refreshIdentity();
}
async function updateReferer() { state.cfg = await mc.updateCfg({ refererPolicy: $('referer-sel').value }); refreshIdentity(); }
async function updateLang()    { state.cfg = await mc.updateCfg({ language:      $('lang-sel').value });    refreshIdentity(); }
async function updateDoH(e) {
  // Leer del selector que disparó el evento, o del principal
  let sel;
  if (e && e.target) sel = e.target;
  else sel = document.getElementById('doh-server') || document.getElementById('doh-server-sidebar');
  if (!sel) return;
  const val = sel.value;
  state.cfg = await mc.updateCfg({ dohServer: val });
  // Sincronizar ambos selectores de DoH
  document.querySelectorAll('#doh-server, #doh-server-sidebar').forEach(el => { el.value = val; });
  const txt = sel.options[sel.selectedIndex]?.text || val;
  setText('st-doh', 'DoH: ' + txt);
}
async function updateProxy() {
  const result = await mc.proxySet({
    enabled: $('proxy-enabled').checked,
    type: $('proxy-type').value,
    host: $('proxy-host').value,
    port: Number($('proxy-port').value || 1080)
  });
  const status = $('proxy-status');
  if (result.ok) {
    state.cfg = await mc.getCfg();
    status.textContent = result.enabled ? `Activo: ${result.type}://${result.host}:${result.port}` : 'Desactivado';
    status.style.color = result.enabled ? 'var(--success)' : 'var(--muted)';
    addSidebarLog('allowed', result.enabled ? '[PROXY] Activado' : '[PROXY] Desactivado');
  } else {
    status.textContent = result.error || 'Error de proxy';
    status.style.color = 'var(--danger)';
  }
}

function refreshIdentity() {
  if (!state.cfg) return;
  const ua = state.cfg.currentUA;
  setText('id-ua',       UA_LABELS[ua] || ua);
  setText('id-platform', mc.platform);
  setText('id-lang',     state.cfg.language || 'en-US');
  setText('id-electron', mc.version);
  // header preview
  setText('hdr-ua-val',   UA_LABELS[ua] + ' (perfil visual; UA nativo de Chromium)');
  setText('hdr-ref-val',  state.cfg.refererPolicy === 'no-referrer' ? '[omitido — no-referrer]' : state.cfg.refererPolicy);
  setText('hdr-lang-val', (state.cfg.language || 'en-US') + ',en;q=0.8');
}

function rotateIdentity() {
  addSidebarLog('info', '[FP] Rotación de UA desactivada: el login de Google (OAuth) solo funciona bien con el UA nativo de Electron');
}

function copyIdentity() {
  const json = JSON.stringify({ ua: state.cfg?.currentUA, lang: state.cfg?.language, platform: mc.platform, electron: mc.version }, null, 2);
  if (navigator.clipboard) navigator.clipboard.writeText(json).catch(()=>{});
  addSidebarLog('info', '[CLIP] Identidad copiada');
}

let extractedResources = [];
let extractedFilter = 'all';
let extractedResourceFilter = 'all';
function showExtractor(data) {
  extractedResources = Array.isArray(data?.resources) ? data.resources : [];
  extractedFilter = 'all';
  extractedResourceFilter = 'all';
  openResourcesPanel('extract');
  renderExtractedResources(data?.error);
}
function filterExtractor(type) {
  extractedFilter = type;
  document.querySelectorAll('.extractor-filter').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === type));
  const list = $('extractor-list');
  if (!list) return;
  const items = extractedResources.map((item, index) => ({ item, index })).filter(({ item }) => type === 'all' || item.type === type);
  if (!items.length) { list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);">No se encontraron recursos de este tipo.</div>'; return; }
  list.innerHTML = items.map(({ item, index }) => `<div class="extractor-item"><span class="extractor-type">${escapeHtml(item.type)}</span><span class="extractor-url">${escapeHtml(item.label || describeResource(item.url, item.type).title)}</span><div class="extractor-actions"><button class="btn ghost btn-sm" onclick="openExtracted(${index})" title="Abrir en nueva pestaña">↗</button><button class="btn ghost btn-sm" onclick="copyExtracted(${index})" title="Copiar URL completa">⧉</button><button class="btn warn btn-sm" onclick="downloadExtracted(${index})" title="Descargar recurso">⬇</button></div></div>`).join('');
}
function openExtracted(index) {
  const item = extractedResources[index];
  if (!item?.url) return;
  addTab(item.url);
  addSidebarLog('info', '[EXTRACT] Abriendo: ' + item.url.substring(0, 60));
}
function copyExtracted(index) { const item = extractedResources[index]; if (item?.url) navigator.clipboard?.writeText(item.url); }
function downloadExtracted(index) {
  const item = extractedResources[index];
  if (!item?.url) return;
  const type = item.type === 'image' ? 'image' : item.type === 'video' ? 'video' : item.type === 'audio' ? 'audio' : 'file';
  const pageUrl = getActivePageUrl();
  dlMedia(item.url, type, pageUrl);
  addSidebarLog('info', '[EXTRACT] Descargando: ' + item.url.substring(0, 60));
}
function renderExtractedResources(error) {
  const list = $('resources-extract-list');
  if (!list) return;
  if (error) { list.innerHTML = `<div style="padding:12px;color:var(--danger);">${escapeHtml(error)}</div>`; return; }
  if (!extractedResources.length) { list.innerHTML = '<div style="padding:18px;text-align:center;color:var(--muted);">No se encontraron imágenes ni enlaces directos.</div>'; return; }
  filterResourceList($('resources-search')?.value || '');
}
function setResourceFilter(type) {
  extractedResourceFilter = type;
  document.querySelectorAll('.resource-category').forEach(button => {
    button.classList.toggle('active', button.dataset.resourceFilter === type);
  });
  filterResourceList($('resources-search')?.value || '');
}
function updateResourceCategoryCounts() {
  const counts = { all: extractedResources.length, image: 0, video: 0, link: 0, audio: 0 };
  extractedResources.forEach(item => {
    if (Object.prototype.hasOwnProperty.call(counts, item.type)) counts[item.type]++;
  });
  document.querySelectorAll('.resource-category').forEach(button => {
    const count = button.querySelector('span');
    if (count) count.textContent = counts[button.dataset.resourceFilter] || 0;
  });
}
function filterResourceList(query) {
  const list = $('resources-extract-list');
  if (!list) return;
  updateResourceCategoryCounts();
  const q = String(query || '').trim().toLowerCase();
  const items = extractedResources.map((item, index) => ({ item, index })).filter(({ item }) => {
    const matchesType = extractedResourceFilter === 'all' || item.type === extractedResourceFilter;
    const matchesSearch = !q || [item.type, item.label, item.url].some(value => String(value || '').toLowerCase().includes(q));
    return matchesType && matchesSearch;
  });
  if (!items.length) { list.innerHTML = '<div style="padding:18px;text-align:center;color:var(--muted);">No hay coincidencias.</div>'; return; }
  list.innerHTML = items.map(({ item, index }) => `<div class="resource-row" onmouseenter="previewResource(${index}, event)" onmouseleave="hideResourcePreview()"><span class="resource-kind">${escapeHtml(item.type)}</span><span class="resource-url">${escapeHtml(item.label || describeResource(item.url, item.type).title)}${item.dimensions ? '<span class="resource-meta">' + escapeHtml(item.dimensions) + '</span>' : ''}</span><div class="resource-actions"><button class="btn ghost btn-sm" onclick="openExtracted(${index})" title="Abrir en pestaña">↗</button><button class="btn ghost btn-sm" onclick="copyExtracted(${index})" title="Copiar URL completa">⧉</button><button class="btn warn btn-sm" onclick="downloadExtracted(${index})" title="Descargar recurso">⬇</button></div></div>`).join('');
}
function previewResource(index, event) {
  const item = extractedResources[index];
  if (!item || !['image', 'video'].includes(item.type) || !item.url) {
    hideResourcePreview();
    return;
  }
  let preview = $('resource-preview');
  if (!preview) { preview = document.createElement('div'); preview.id = 'resource-preview'; document.body.appendChild(preview); }
  preview.replaceChildren();
  const mediaUrl = item.preview || item.url;
  const media = document.createElement(item.type === 'image' ? 'img' : 'video');
  media.src = mediaUrl;
  media.alt = item.label || '';
  media.loading = 'eager';
  media.referrerPolicy = 'no-referrer-when-downgrade';
  if (item.type === 'video') {
    media.muted = true;
    media.autoplay = true;
    media.loop = true;
    media.playsInline = true;
  }
  media.addEventListener('error', () => {
    preview.replaceChildren();
    const message = document.createElement('span');
    message.textContent = 'Vista previa no disponible';
    message.style.cssText = 'display:block;padding:12px;color:var(--muted);font-size:.769rem;text-align:center;';
    preview.appendChild(message);
  }, { once: true });
  preview.appendChild(media);
  const rect = event.currentTarget.getBoundingClientRect();
  preview.style.left = Math.min(window.innerWidth - 270, Math.max(8, rect.right + 8)) + 'px';
  preview.style.top = Math.min(window.innerHeight - 230, Math.max(8, rect.top)) + 'px';
  preview.style.display = 'block';
}
function hideResourcePreview() { const preview = $('resource-preview'); if (preview) preview.style.display = 'none'; }
function setResourcesTab(tab) {
  document.querySelectorAll('.resources-tab').forEach(button => button.classList.toggle('active', button.dataset.resourcesTab === tab));
  document.querySelectorAll('.resources-view').forEach(view => view.classList.toggle('active', view.dataset.resourcesView === tab));
  if (tab === 'streams') renderSidebarStreams();
}
function openResourcesPanel(tab = 'streams') {
  const panel = $('resources-panel');
  if (!panel) return;
  panel.classList.remove('collapsed');
  $('resources-toggle')?.classList.add('open');
  setResourcesTab(tab);
}
function toggleResourcesPanel() {
  const panel = $('resources-panel');
  if (!panel) return;
  const collapsed = panel.classList.toggle('collapsed');
  $('resources-toggle')?.classList.toggle('open', !collapsed);
}
function openResourceExtractor() {
  const panel = $('resources-panel');
  if (panel && !panel.classList.contains('collapsed')) {
    toggleResourcesPanel();
    hideResourcePreview();
    return;
  }
  openResourcesPanel('extract');
  extractPageResources();
}
async function extractPageResources() {
  const wv = $('webview-' + state.activeTab);
  if (!wv || !wv.executeJavaScript) { renderExtractedResources('No hay una página web activa.'); return; }
  try {
    const data = await wv.executeJavaScript(`(() => {
      try {
        const found = [];
        const add = (url, type, label, dimensions) => {
          if (!url || !/^https?:\\/\\//i.test(url)) return;
          let absolute;
          try { absolute = new URL(url, location.href).href; } catch (e) { return; }
          if (!found.some(item => item.url === absolute)) found.push({ url: absolute, type, label, dimensions: dimensions || '' });
        };
        document.querySelectorAll('img').forEach((el, i) => {
          const width = el.naturalWidth || el.width;
          const height = el.naturalHeight || el.height;
          // Ignorar iconos, avatares y miniaturas pequeñas; conservar banners
          // o imágenes panorámicas si al menos una dimensión llega al umbral.
          if (width && height && Math.max(width, height) < 400) return;
          const dimensions = width && height ? width + ' × ' + height + ' px' : '';
          add(el.currentSrc || el.src, 'image', el.alt || 'Imagen ' + (i + 1), dimensions);
        });
        document.querySelectorAll('video, audio').forEach((el, i) => {
          const width = el.videoWidth || el.width;
          const height = el.videoHeight || el.height;
          const dimensions = el.tagName.toLowerCase() === 'video' && width && height ? width + ' × ' + height + ' px' : '';
          add(el.currentSrc || el.src, el.tagName.toLowerCase(), el.getAttribute('title') || el.tagName + ' ' + (i + 1), dimensions);
          el.querySelectorAll('source').forEach(source => add(source.src, el.tagName.toLowerCase(), source.type || 'source'));
        });
        document.querySelectorAll('a[href]').forEach((el, i) => add(el.href, 'link', (el.innerText || el.textContent || '').trim().slice(0, 100) || 'Enlace ' + (i + 1)));
        document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach(el => add(el.content, 'image', 'Imagen social'));
        return { title: document.title || location.hostname, resources: found.slice(0, 500) };
      } catch (e) {
        return { title: location.hostname || '', resources: [], error: String(e && e.message || e) };
      }
    })()`);
    showExtractor(data);
  } catch (error) { showExtractor({ error: error.message || 'No se pudo extraer la página' }); }
}
function clearExtractedResources() { extractedResources = []; renderExtractedResources(); }
function closeExtractor() {
  const overlay = $('extractor-overlay');
  if (overlay) overlay.classList.remove('open');
  hideResourcePreview();
}

// ── privacy levels ──────────────────────────────
function setPrivacyLevel(lvl) {
  const map = {
    custom:   { ads:true,  trackers:true,  third:false, headers:false, fp:false, cookies:false, doh:false, media:true,  https:true  },
    high:     { ads:true,  trackers:true,  third:false, headers:true,  fp:false, cookies:true,  doh:true,  media:true,  https:true  },
    max:      { ads:true,  trackers:true,  third:true,  headers:true,  fp:true,  cookies:true,  doh:true,  media:true,  https:true  },
    paranoid: { ads:true,  trackers:true,  third:true,  headers:true,  fp:true,  cookies:true,  doh:true,  media:true,  https:true  },
  };
  const v = map[lvl] || map.max;
  $('tog-ads').checked         = v.ads;
  $('tog-trackers').checked    = v.trackers;
  $('tog-third').checked       = v.third;
  $('tog-headers').checked     = v.headers;
  $('tog-fp').checked          = v.fp;
  $('tog-cookies').checked     = v.cookies;
  $('tog-doh').checked         = v.doh;
   const mediaDetectToggle = $('tog-media-detect');
   if (mediaDetectToggle) mediaDetectToggle.checked = v.media;
  if ($('tog-https')) $('tog-https').checked = v.https;
  if (lvl === 'paranoid') { $('ua-select').value = 'win-chrome'; updateUA(); }
  updateProtections();
  const desc = { custom:'Personalizado — configura manualmente', high:'Alto — ads + trackers bloqueados', max:'Máximo — todas las protecciones', paranoid:'Paranoico — máximas protecciones con UA estable' };
  $('privacy-level-desc').innerHTML = 'Modo actual: <span style="color:var(--accent);">'+(desc[lvl]||desc.max)+'</span>';
}

// ── custom blocks ───────────────────────────────
async function addCustomBlock() {
  const v = $('custom-block-input').value.trim();
  if (!v || state.customBlocks.some(b => patternMatchesHost(b, v))) return;
  state.customBlocks.push(v);
  await mc.addBlockRule({ pattern: v, action: 'block' });
  $('custom-block-input').value = '';
  renderCustomBlocks();
  addSidebarLog('blocked', '[RULE+] '+v);
}
async function removeCustomBlock(v) {
  state.customBlocks = state.customBlocks.filter(b => b !== v);
  delete state.siteBlockMap[v];
  await mc.removeBlockRule(v);
  renderCustomBlocks();
}
function renderCustomBlocks() {
  const list = $('custom-block-list');
  if (!state.customBlocks.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size: 0.846rem;text-align:center;padding:12px 0;">Sin reglas custom aún</div>';
    return;
  }
  list.innerHTML = state.customBlocks.map(b => {
    const site = state.siteBlockMap && state.siteBlockMap[b];
    const siteTag = site ? ' <span class="badge orange" title="Solo en '+escapeHtml(site)+'">'+escapeHtml(site)+'</span>' : ' <span class="badge red">global</span>';
    return '<div class="rule-item"><span class="ri-name">'+escapeHtml(b)+'</span>' + siteTag + '<button class="rule-del" onclick="removeCustomBlock(\''+b.replace(/'/g,"\\'")+'\')">&#215;</button></div>';
  }).join('');
}

// ── cookie rules ────────────────────────────────
async function addCookieRule() {
  const dom = $('ck-domain').value.trim();
  if (!dom) return;
  const pol = $('ck-policy').value;
  state.cookieRules[dom] = pol;
  await mc.addCookieRule(dom, pol);
  $('ck-domain').value = '';
  renderCookieRules();
  addSidebarLog('modified', '[CK] '+dom+' → '+pol);
}
async function removeCookieRule(dom) {
  delete state.cookieRules[dom];
  await mc.removeCookieRule(dom);
  renderCookieRules();
}
function renderCookieRules() {
  const tbody = $('cookie-allow-body');
  const labels = { session:'<span class="badge green">Solo sesión</span>', allow:'<span class="badge blue">Permitir</span>', block:'<span class="badge red">Bloquear</span>' };
  tbody.innerHTML = Object.entries(state.cookieRules).map(([d,p]) =>
    '<tr><td>'+escapeHtml(d)+'</td><td>'+(labels[p]||p)+'</td><td><button class="rule-del" onclick="removeCookieRule(\''+d.replace(/'/g,"\\'")+'\')">&#215;</button></td></tr>'
  ).join('');
}

// ── DoH test ────────────────────────────────────
async function testDoH() {
  const host = $('doh-test').value.trim();
  if (!host) return;
  const button = document.querySelector('[onclick="testDoH()"]');
  if (button?.disabled) return;
  if (button) button.disabled = true;
  $('doh-result').textContent = '⏳ Resolviendo...';
  const started = performance.now();
  try {
    const r = await mc.resolveDoH(host);
    const elapsed = Math.round(performance.now() - started);
    if (r && r.ok) {
      $('doh-result').textContent = '✓ '+host+' → '+r.ip+' ('+elapsed+' ms)';
      $('doh-result').style.color = 'var(--success)';
    } else {
      $('doh-result').textContent = '✗ '+host+': '+(r && r.error ? r.error : 'no resuelto');
      $('doh-result').style.color = 'var(--danger)';
    }
  } finally {
    if (button) button.disabled = false;
  }
}

// ── clear / data ────────────────────────────────
async function clearCookies() {
  const keepSessions = !!(document.getElementById('keep-sessions-clear')?.checked || document.getElementById('keep-sessions-clear2')?.checked || document.getElementById('keep-sessions-clear3')?.checked);
  const result = await mc.clearData({ history: false, cache: false, cookies: true, keepSessions }).catch(error => ({ ok: false, error: error?.message || 'error desconocido' }));
  if (result && result.ok) addSidebarLog('allowed', '[CK] cookies eliminadas' + (keepSessions ? ' (se conservaron sesiones)' : ''));
  else addSidebarLog('blocked', '[CK] no se pudieron eliminar: ' + (result?.error || 'error desconocido'));
}
async function clearCache()   {
  const result = await mc.clearData({ history: false, cache: true, cookies: false, keepSessions: false }).catch(error => ({ ok: false, error: error?.message || 'error desconocido' }));
  if (result && result.ok) addSidebarLog('allowed','[CACHE] limpio');
  else addSidebarLog('blocked', '[CACHE] no se pudo limpiar: ' + (result?.error || 'error desconocido'));
}
async function clearAll() {
  if (!confirm('Borrar TODOS los datos (cookies, caché, storage, stats)?')) return;
  const result = await mc.clearAll().catch(error => ({ ok: false, error: error?.message || 'error desconocido' }));
  if (!result?.ok) {
    addSidebarLog('blocked', '[CLEAR] no se pudieron borrar todos los datos: ' + (result?.error || 'error desconocido'));
    return;
  }
  state.history = [];
  renderHistory();
  try { localStorage.removeItem('mc_history'); } catch {}
  state.stats = await mc.getStats();
  refreshStats();
  state.reqLog = []; renderReqLog();
  clearMedia();
  // Recargar la pestaña activa para que el storage limpiado surta efecto
  // (p. ej. el historial local de YouTube vive en localStorage/IndexedDB y
  // la página en memoria lo seguiría mostrando sin recargar)
  const wv = state.activeTab >= 0 ? $('webview-' + state.activeTab) : null;
  if (wv && wv.reload) { try { reloadTab(state.activeTab); } catch {} }
  addSidebarLog('allowed','[CLEAR] todos los datos eliminados');
}

// ── session export/import ───────────────────────
async function exportSession() {
  const r = await mc.exportSession();
  if (r) addSidebarLog('allowed', '[SESSION] Exportada: '+r);
}
async function importSession() {
  const r = await mc.importSession();
  if (r && r.ok) {
    addSidebarLog('allowed', '[SESSION] Importada ('+r.exported+')');
    state.cfg = await mc.getCfg();
    syncCfgToUI();
  } else if (r) addSidebarLog('blocked', '[SESSION] Error: '+r.error);
}

// ── sync cfg → UI ───────────────────────────────
function syncCfgToUI() {
  if (!state.cfg) return;
  $('tog-ads').checked          = state.cfg.blockAds;
  $('tog-trackers').checked     = state.cfg.blockTrackers;
  $('tog-third').checked        = state.cfg.strictDomainIsolation !== false;
  $('tog-headers').checked      = state.cfg.spoofUA;
  $('tog-fp').checked           = state.cfg.blockFingerprint;
  $('tog-cookies').checked      = state.cfg.cookiePolicy === 'session';
  $('tog-doh').checked          = state.cfg.dohEnabled;
  $('tog-media-detect').checked = state.cfg.mediaDetect;
  if ($('tog-gpu')) $('tog-gpu').checked = state.cfg.gpuAcceleration === true;
  refreshGpuStatus();
  if ($('proxy-enabled')) $('proxy-enabled').checked = state.cfg.proxyEnabled === true;
  if ($('proxy-type')) $('proxy-type').value = state.cfg.proxyType || 'socks5';
  if ($('proxy-host')) $('proxy-host').value = state.cfg.proxyHost || '';
  if ($('proxy-port')) $('proxy-port').value = state.cfg.proxyPort || 1080;
  if ($('proxy-status')) {
    $('proxy-status').textContent = state.cfg.proxyEnabled && state.cfg.proxyHost
      ? `Activo: ${state.cfg.proxyType}://${state.cfg.proxyHost}:${state.cfg.proxyPort}` : 'Desactivado';
    $('proxy-status').style.color = state.cfg.proxyEnabled ? 'var(--success)' : 'var(--muted)';
  }
  if ($('tog-https')) $('tog-https').checked = state.cfg.httpsOnly;
  if ($('ua-select')) $('ua-select').value = state.cfg.currentUA || 'win-chrome';
  if ($('referer-sel')) $('referer-sel').value = state.cfg.refererPolicy || 'no-referrer';
  if ($('lang-sel'))    $('lang-sel').value    = state.cfg.language       || 'en-US';
  if ($('doh-server')) {
    $('doh-server').value  = state.cfg.dohServer      || 'cloudflare';
    // Sincronizar con el selector del sidebar
    if ($('doh-server-sidebar')) $('doh-server-sidebar').value = state.cfg.dohServer || 'cloudflare';
    // Actualizar la barra de estado con el nombre legible del servidor
    const sel = $('doh-server');
    const txt = sel.options[sel.selectedIndex]?.text || sel.value;
    setText('st-doh', 'DoH: ' + txt);
  }
  state.customBlocks = (state.cfg.customRules || []).map(r => r.pattern);
  state.siteBlockMap = {};
  for (const r of (state.cfg.customRules || [])) {
    if (r.pattern && r.site) state.siteBlockMap[r.pattern] = r.site;
  }
  renderCustomBlocks();
  state.cookieRules = { ...(state.cfg.allowlist || {}) };
  renderCookieRules();
  refreshIdentity();
  renderCosmeticRules();
  applyNtSizes();
  applyUiTextSize();
}

// ── clock ───────────────────────────────────────
function tickClock() { setText('st-time', new Date().toLocaleTimeString('es',{hour12:false})); }

