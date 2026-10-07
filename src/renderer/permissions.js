// ── Permissions & Cookies Panel ─────────────────
function normalizeDomainInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const cleaned = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').split('/')[0].replace(/^www\./i, '').toLowerCase();
  if (!cleaned) return '';
  try {
    return new URL('https://' + cleaned).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return cleaned;
  }
}

/** Verifica si un patrón de bloqueo (host bare, wildcard, o URL completa) coincide con un host dado. */
function patternMatchesHost(pattern, host) {
  if (!pattern || !host) return false;
  const p = String(pattern).toLowerCase();
  const h = String(host).toLowerCase();
  if (p === h) return true;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return h === base || h.endsWith('.' + base);
  }
  try {
    if (/^https?:\/\//i.test(p)) {
      const urlHost = new URL(p).hostname.replace(/^www\./i, '').toLowerCase();
      if (urlHost === h) return true;
      if (urlHost.startsWith('*.')) {
        const base = urlHost.slice(2);
        return h === base || h.endsWith('.' + base);
      }
    }
  } catch {}
  return false;
}

function getCurrentPageDomain() {
  if (window.Sessions?._wv && document.getElementById('session-sidebar')?.classList.contains('open')) {
    try { return normalizeDomainInput(window.Sessions._wv.getURL() || ''); } catch {}
  }
  const value = $('urlinput')?.value || '';
  const tab = state.tabs.find(t => t.id === state.activeTab);
  const source = value || tab?.url || '';
  return normalizeDomainInput(source);
}

function syncPermissionsDomainField() {
  const input = $('permission-domain');
  if (!input) return;
  const domain = getCurrentPageDomain();
  if (domain) input.value = domain;
}

async function collectPageRelatedHosts() {
  const wv = $('webview-' + state.activeTab);
  if (!wv || !wv.executeJavaScript) return [];
  try {
    const hosts = await wv.executeJavaScript(`(() => {
      const seen = new Set();
      const add = (value) => {
        if (!value) return;
        try {
          const raw = String(value).trim();
          const parsed = raw.startsWith('//') ? new URL(location.protocol + raw) : new URL(raw, location.href);
          const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
          if (host && host !== 'localhost' && /^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(host)) seen.add(host);
        } catch {}
      };
      const collectFromList = (list) => {
        for (const item of list || []) {
          if (!item) continue;
          if (typeof item === 'string') add(item);
          else {
            if (item.src) add(item.src);
            if (item.href) add(item.href);
            if (item.dataset && item.dataset.src) add(item.dataset.src);
          }
        }
      };
      const nodes = document.querySelectorAll('img[src], video[src], audio[src], source[src], iframe[src], script[src], link[href], a[href], object[data], embed[src], track[src]');
      nodes.forEach(node => {
        if (node.src) add(node.src);
        if (node.href) add(node.href);
        if (node.dataset && node.dataset.src) add(node.dataset.src);
        if (node.srcset) {
          node.srcset.split(',').forEach(part => {
            const url = part.trim().split(/\s+/)[0];
            add(url);
          });
        }
      });
      collectFromList(Array.from(document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]')).map(el => el.content));
      try {
        performance.getEntriesByType('resource').forEach(entry => add(entry.name));
      } catch {}
      return Array.from(seen);
    })()`);
    if (!Array.isArray(hosts)) return [];
    return hosts.map(host => normalizeDomainInput(host)).filter(Boolean);
  } catch {
    return [];
  }
}

function togglePermissionsPanel() {
  const panel = $('permissions-panel');
  const btn = $('permissions-toggle');
  if (!panel) return;
  const collapsed = panel.classList.toggle('collapsed');
  if (btn) btn.classList.toggle('open', !collapsed);
  try { localStorage.setItem('mc_permissions_collapsed', collapsed ? '1' : ''); } catch {}
  if (!collapsed) {
    const body = panel.querySelector('.perm-body');
    if (body) body.scrollTop = 0;
    syncPermissionsDomainField();
    renderPermissionsList().catch(error => addSidebarLog('blocked', '[PERM] No se pudo actualizar el panel: ' + (error.message || error)));
  }
}

function togglePermissionSection(summary) {
  const details = summary?.closest('details.perm-collapsible');
  if (details) details.open = !details.open;
}

function refreshPermissionsForActivePage() {
  syncPermissionsDomainField();
  renderPermissionsList().catch(error => addSidebarLog('blocked', '[PERM] No se pudo actualizar el panel: ' + (error.message || error)));
}

async function loadPermissionsList() {
  const list = $('permissions-list');
  const hostList = $('detected-hosts-list');
  if (!list) return;
  const perms = await mc.getPermissions().catch(() => ({}));
  const permissionOrigins = typeof mc.getPermissionOrigins === 'function'
    ? await mc.getPermissionOrigins().catch(() => [])
    : [];
  const activeDomain = normalizeDomainInput($('permission-domain')?.value || getCurrentPageDomain());
  const discoveredPageHosts = await collectPageRelatedHosts().catch(() => []);
  // Solo hosts relacionados con la página actual (DOM + hints del dominio
  // activo). La acumulación global de streams pertenece a su sección de
  // medios, no al panel de permisos.
  const hintedHosts = activeDomain ? (state.permissionHostHints[activeDomain] || []) : [];
  const allDiscoveredHosts = [...new Set([...discoveredPageHosts, ...hintedHosts, ...(activeDomain ? [activeDomain] : [])])];
  // Hosts que el motor de adblock (listas de filtros, no solo reglas
  // manuales) bloqueó de verdad en la página activa — antes "Hosts cargados"
  // solo miraba customBlocks/allowlist, así que algo bloqueado por las
  // listas (la mayoría de los bloqueos reales) se veía como "Activo".
  let engineBlockedHosts = new Set();
  try {
    const wvActive = $('webview-' + state.activeTab);
    const activeWcId = wvActive && wvActive.getWebContentsId ? wvActive.getWebContentsId() : null;
    if (activeWcId) engineBlockedHosts = new Set(await mc.getBlockedHosts(activeWcId));
  } catch {}
  const originsByPermission = new Map();
  for (const item of Array.isArray(permissionOrigins) ? permissionOrigins : []) {
    const target = normalizeDomainInput(item?.domain || '');
    const permission = String(item?.permission || '');
    const origin = normalizeDomainInput(item?.origin || '');
    if (!target || !permission || !origin) continue;
    const key = target + '|' + permission;
    if (!originsByPermission.has(key)) originsByPermission.set(key, new Set());
    originsByPermission.get(key).add(origin);
  }
  const permissionEntryVisible = (domain, rules) => Object.keys(rules || {}).some(permission => {
    const scopedOrigins = originsByPermission.get(domain + '|' + permission);
    if (scopedOrigins?.size) return !!activeDomain && scopedOrigins.has(activeDomain);
    return !!activeDomain && (domain === activeDomain || allDiscoveredHosts.includes(domain));
  });
  const domainMap = new Map();
  for (const [domain, rules] of Object.entries(perms || {})) {
    const normalized = normalizeDomainInput(domain) || String(domain || '').trim().replace(/^\.+/, '').toLowerCase();
    if (!normalized) continue;
    if (!domainMap.has(normalized)) domainMap.set(normalized, { raw: domain, rules: rules && typeof rules === 'object' ? rules : {} });
  }
  for (const host of allDiscoveredHosts) {
    if (!host) continue;
    if (!domainMap.has(host)) domainMap.set(host, { raw: host, rules: {} });
  }
  const entries = Array.from(domainMap.entries())
    // "Reglas guardadas" es una vista de gestión: muestra TODO lo que hay
    // guardado, sin importar la página en la que estés (antes del commit
    // 3891819 era así; después empezó a ocultar cualquier dominio no
    // relacionado con la pestaña activa, dejando el panel casi siempre
    // vacío). originsByPermission/permissionEntryVisible ahora se usan más
    // abajo solo para afinar el badge "Relacionado", no para ocultar filas.
    .filter(([, value]) => Object.keys(value.rules || {}).length > 0)
    .map(([domain, value]) => ({ domain, raw: value.raw || domain, rules: value.rules || {} }));

  const activeDomainCard = $('permissions-active-domain');
  const activeStatus = $('permissions-active-statuses');
  const blockedSummary = $('permissions-blocked-summary');
  if (blockedSummary) {
    const blockedTotal = Number(state.stats?.blockedAds || 0) + Number(state.stats?.blockedTrackers || 0) + Number(state.stats?.blockedThird || 0) + Number(state.stats?.blockedCrypto || 0);
    blockedSummary.textContent = blockedTotal ? blockedTotal + ' elementos bloqueados' : 'Protección activa';
  }
  if (activeDomainCard) activeDomainCard.textContent = activeDomain || '—';
  const blockLight = $('perm-block-light');
  const blockPermanent = $('perm-block-permanent');
  const blockGlobal = $('perm-block-global');
  const saveSession = $('perm-save-session');
  if (saveSession) saveSession.checked = activeDomain && state.cfg?.allowlist?.[activeDomain] === 'allow';
  if (blockLight) blockLight.checked = activeDomain && state.cfg?.allowlist?.[activeDomain] === 'session';
  if (blockPermanent) blockPermanent.checked = activeDomain && state.customBlocks.some(b => patternMatchesHost(b, activeDomain));
  if (blockGlobal) blockGlobal.checked = activeDomain && state.customBlocks.some(b => patternMatchesHost(b, '*.' + activeDomain));
  if (activeStatus) {
    const activeRules = activeDomain && perms && (perms[activeDomain] || perms[activeDomain.replace(/^www\./i, '')]) ? (perms[activeDomain] || perms[activeDomain.replace(/^www\./i, '')]) : {};
    const badges = [];
    if (activeDomain) badges.push('<span class="status-pill active">Activo</span>');
    if (allDiscoveredHosts.length) badges.push('<span class="status-pill muted">' + allDiscoveredHosts.length + ' hosts detectados</span>');
    if (Object.keys(activeRules).length) {
      const allowCount = Object.values(activeRules).filter(v => v === 'allow').length;
      const denyCount = Object.values(activeRules).filter(v => v === 'deny' || v === 'block').length;
      if (allowCount) badges.push('<span class="status-pill allow">' + allowCount + ' permitidos</span>');
      if (denyCount) badges.push('<span class="status-pill deny">' + denyCount + ' bloqueados</span>');
      if (!allowCount && !denyCount) badges.push('<span class="status-pill muted">Reglas vacías</span>');
    } else if (activeDomain) {
      badges.push('<span class="status-pill muted">Sin reglas</span>');
    } else {
      badges.push('<span class="status-pill muted">Sin dominio</span>');
    }
    activeStatus.innerHTML = badges.join('');
  }

  if (hostList) {
    const hostRows = [...new Set(allDiscoveredHosts)].filter(Boolean).sort((a, b) => a.localeCompare(b));
    if (!hostRows.length) {
      hostList.innerHTML = '<div class="bp-empty"><div class="bp-empty-icon">&#128279;</div><div>Sin hosts detectados</div></div>';
    } else {
      hostList.innerHTML = hostRows.map(host => {
        const safeHost = String(host).replace(/'/g, "\\'");
        const matchedPatterns = state.customBlocks.filter(b => patternMatchesHost(b, host));
        const hasGlobalBlock = matchedPatterns.some(b => !state.siteBlockMap[b]);
        const currentSite = normalizeDomainInput(getCurrentPageDomain());
        const hasSiteBlock = currentSite && matchedPatterns.some(b => state.siteBlockMap[b] === currentSite);
        const blockedByEngine = engineBlockedHosts.has(host);
        const isBlocked = hasGlobalBlock || hasSiteBlock || blockedByEngine || state.cfg?.allowlist?.[host] === 'block' || state.cfg?.allowlist?.[host] === 'session';
        const blockPill = isBlocked ? (hasGlobalBlock ? 'Bloqueado' : hasSiteBlock ? 'Bloqueado aquí' : blockedByEngine ? 'Bloqueado (adblock)' : 'Bloqueado aquí') : 'Activo';
        const currentSiteLabel = currentSite ? escapeHtml(currentSite) : '';
        return '<div class="perm-domain"><div class="perm-domain-head"><strong>' + escapeHtml(host) + '</strong><span class="status-pill ' + (isBlocked ? 'deny' : 'muted') + '">' + blockPill + '</span></div>' +
          '<div class="perm-host-actions">' +
          '<button class="mini-btn" onclick="choosePermissionDomain(\'' + safeHost + '\')">Permisos</button>' +
          '<button class="mini-btn danger" onclick="blockHost(\'' + safeHost + '\', \'domain\')">Bloquear</button>' +
          '<button class="mini-btn warn" onclick="blockHostSite(\'' + safeHost + '\')" title="Bloquear solo en ' + currentSiteLabel + '">En sitio</button>' +
          '<button class="mini-btn" onclick="blockHost(\'' + safeHost + '\', \'subdomain\')">Subdominios</button>' +
          '<button class="mini-btn ghost" onclick="unblockHost(\'' + safeHost + '\')">' + (isBlocked ? 'Permitir' : 'Desbloquear') + '</button>' +
          '</div></div>';
      }).join('');
    }
  }

  if (!entries.length) {
    list.innerHTML = '<div class="bp-empty"><div class="bp-empty-icon">&#128274;</div><div>Sin reglas guardadas</div><small style="display:block;margin-top:4px;color:var(--muted2);">Usa “Agregar permiso” para crear una.</small></div>';
    return;
  }
  const relatedHosts = new Set(allDiscoveredHosts);
  entries.sort((a, b) => {
    const aPriority = (a.domain === activeDomain ? 0 : relatedHosts.has(a.domain) ? 1 : 2);
    const bPriority = (b.domain === activeDomain ? 0 : relatedHosts.has(b.domain) ? 1 : 2);
    if (aPriority !== bPriority) return aPriority - bPriority;
    return a.domain.localeCompare(b.domain);
  });

  list.innerHTML = entries.map(({ domain, raw, rules }) => {
    const host = normalizeDomainInput(domain) || domain;
    const isActive = !!activeDomain && normalizeDomainInput(domain) === activeDomain;
    // "Relacionado" combina los hosts detectados en la página (isRelated
    // simple) con el rastreo de origen más preciso (permissionEntryVisible):
    // una regla que se otorgó específicamente desde esta página, aunque el
    // dominio en sí no aparezca entre los hosts detectados ahora mismo.
    const isRelated = !!host && (relatedHosts.has(host) || permissionEntryVisible(domain, rules));
    const items = Object.entries(rules).map(([permission, mode]) => {
      const label = permission === 'camera' ? 'Cámara' : permission === 'microphone' ? 'Micrófono' :
        permission === 'notifications' ? 'Notificaciones' : permission === 'geolocation' ? 'Ubicación' :
        permission === 'images' ? 'Imágenes' : permission === 'audio' ? 'Audio' :
        permission === 'javascript' ? 'JavaScript' : permission === 'site' ? 'Sitio confiable' :
        permission === 'media' ? 'Media (legacy)' : permission;
      const safeDomain = String(raw || domain).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const safePermission = String(permission).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const modeName = mode === 'allow' ? 'Permitir' : mode === 'deny' || mode === 'block' ? 'Bloquear' : 'Denegar';
      const permClass = mode === 'allow' ? 'allow' : mode === 'deny' || mode === 'block' ? 'deny' : 'block';
      return `
        <div class="perm-row">
          <span class="perm-name">${escapeHtml(label)}</span>
          <div style="display:flex;align-items:center;gap:6px;">
            <span class="perm-state ${permClass}">${modeName}</span>
            <button class="rule-del" onclick="removePermissionRule('${safeDomain}', '${safePermission}')" title="Eliminar">&#215;</button>
          </div>
        </div>`;
    }).join('');
    const safeDomain = String(raw || domain).replace(/'/g, "\\'");
    let domainStatus = '<span class="status-pill muted">Permiso</span>';
    if (isActive) domainStatus = '<span class="status-pill active">Activo</span>';
    else if (isRelated) domainStatus = '<span class="status-pill muted">Relacionado</span>';
    return '<div class="perm-domain ' + (isActive ? 'is-active' : '') + '"><div class="perm-domain-head"><strong>'+escapeHtml(String(raw || domain))+'</strong><button class="rule-del" onclick="removeDomainPermission(' + JSON.stringify(safeDomain) + ')" title="Eliminar dominio">&#215;</button></div><div class="perm-domain-meta">' + domainStatus + '</div>' + (items || '<div class="perm-row"><span class="perm-name">Sin reglas</span></div>') + '</div>';
  }).join('');
}

function choosePermissionDomain(domain) {
  const input = $('permission-domain');
  if (!input || !domain) return;
  input.value = normalizeDomainInput(domain);
  input.focus();
  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function showPermissionHosts() {
  const details = document.querySelector('#permissions-panel .perm-details');
  if (details) details.open = true;
  const hosts = $('detected-hosts-list');
  if (hosts) hosts.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function renderPermissionsList() {
  await loadPermissionsList();
  await renderSiteScripts();
  await refreshPageCookies().catch(() => {
    const list = $('page-cookies-list');
    if (list) list.innerHTML = '<div class="bp-empty"><div class="bp-empty-icon">&#127850;</div><div>No se pudieron cargar las cookies ahora</div></div>';
  });
  renderCosmeticRules();
}

async function renderSiteScripts() {
  const list = $('site-script-list');
  const count = $('permissions-script-count');
  if (!list) return;
  const activeDomain = normalizeDomainInput($('permission-domain')?.value || getCurrentPageDomain());
  if (!activeDomain) {
    list.innerHTML = '<div class="bp-empty"><div class="bp-empty-icon">&#128196;</div><div>Sin dominio activo</div></div>';
    if (count) count.textContent = '0 detectados';
    return;
  }
  const rules = await mc.getResourceRules().catch(() => []);
  const related = host => host === activeDomain || host.endsWith('.' + activeDomain) || activeDomain.endsWith('.' + host);
  const scripts = new Map();
  for (const item of state.blockedScripts) {
    const url = String(item?.url || '');
    const host = normalizeDomainInput(url);
    if (url && related(host)) scripts.set(url, { url, observedBlocked: item.blocked === true });
  }
  for (const rule of Array.isArray(rules) ? rules : []) {
    const url = String(rule?.url || '');
    const host = normalizeDomainInput(url);
    if (url && rule.resourceType === 'script' && related(host)) scripts.set(url, { url });
  }
  const rows = Array.from(scripts.values()).sort((a, b) => a.url.localeCompare(b.url));
  if (count) count.textContent = rows.length + ' scripts · ' + new Set(rows.map(row => normalizeDomainInput(row.url))).size + ' orígenes';
  if (!rows.length) {
    list.innerHTML = '<div class="bp-empty"><div class="bp-empty-icon">&#128196;</div><div>Aún no se detectaron scripts</div></div>';
    return;
  }
  const ruleMap = new Map((Array.isArray(rules) ? rules : []).filter(rule => rule?.resourceType === 'script').map(rule => [rule.url, rule.action]));
  const groups = new Map();
  rows.forEach(row => {
    const host = normalizeDomainInput(row.url) || 'origen desconocido';
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(row);
  });
  const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
    const aActive = a[0] === activeDomain ? 0 : 1;
    const bActive = b[0] === activeDomain ? 0 : 1;
    return aActive - bActive || a[0].localeCompare(b[0]);
  });
  const renderScriptRow = ({ url, observedBlocked }) => {
    const action = ruleMap.get(url) || '';
    const encoded = JSON.stringify(url);
    const status = action === 'allow' ? 'Permitido' : action === 'block' ? 'Bloqueado' : observedBlocked ? 'Bloqueado por protección' : 'Sin regla';
    const statusClass = action === 'allow' ? 'allow' : action === 'block' || observedBlocked ? 'deny' : 'muted';
    return '<div class="perm-script-row">'
      + '<div><span class="perm-script-url" title="' + escapeHtml(url) + '">' + escapeHtml(url.replace(/^https?:\/\//i, '')) + '</span>'
      + '<span class="perm-script-host"><span class="perm-state ' + statusClass + '">' + status + '</span></span></div>'
      + '<div class="perm-script-actions"><button class="mini-btn ' + (action === 'allow' ? 'active-allow' : '') + '" onclick="setScriptRule(' + encoded + ', \'allow\')">Permitir</button>'
      + '<button class="mini-btn danger ' + (action === 'block' ? 'active-block' : '') + '" onclick="setScriptRule(' + encoded + ', \'block\')">Bloquear</button></div>'
      + '</div>';
  };
  list.innerHTML = sortedGroups.map(([host, group]) => {
    const isActive = host === activeDomain;
    const allowed = group.filter(row => ruleMap.get(row.url) === 'allow').length;
    const blocked = group.filter(row => ruleMap.get(row.url) === 'block' || row.observedBlocked).length;
    const stateLabel = allowed || blocked ? (allowed + ' permitidos · ' + blocked + ' bloqueados') : 'Sin reglas individuales';
    return '<details class="perm-script-group"><summary><span class="perm-script-group-icon">&#60;/&#62;</span><span class="perm-script-group-title"><strong>' + escapeHtml(host) + '</strong><span>' + (isActive ? 'Dominio activo · ' : 'Dominio relacionado · ') + stateLabel + '</span></span><span class="perm-script-group-count">' + group.length + ' scripts</span></summary><div class="perm-script-group-body">' + group.map(renderScriptRow).join('') + '</div></details>';
  }).join('');
}

async function setScriptRule(url, action) {
  if (!url || !['allow', 'block'].includes(action)) return;
  await mc.addResourceRule({ url, action, resourceType: 'script' });
  await renderSiteScripts();
  const wv = $('webview-' + state.activeTab);
  reloadTab(state.activeTab);
}

async function refreshPageCookies() {
  const list = $('page-cookies-list');
  if (!list) return;
  const domain = normalizeDomainInput($('permission-domain')?.value || getCurrentPageDomain());
  if (!domain) {
    list.innerHTML = '<div class="bp-empty"><div class="bp-empty-icon">&#127850;</div><div>Sin dominio activo</div></div>';
    return;
  }
  const cookies = await mc.getSiteCookies(domain).catch(() => []);
  const domainRule = state.cfg?.allowlist?.[domain] || state.cfg?.allowlist?.['.' + domain] || null;
  // 'allow'/'session' salen de la whitelist real. 'block' es una regla
  // explícita (el usuario tocó "Bloquear cookies" / bloqueo permanente o
  // global) — no tiene que ver con estar o no en la whitelist, así que no
  // se etiqueta como tal. Ausencia de regla (null) sí es el caso de
  // "no está en la whitelist" -> política de bloqueo por defecto.
  const policyLabel = domainRule === 'allow' ? 'Permitido por whitelist'
    : domainRule === 'session' ? 'Solo sesión'
    : domainRule === 'block' ? 'Bloqueado (regla explícita)'
    : 'Bloqueado por política por defecto (no está en la whitelist)';
  if (!Array.isArray(cookies) || !cookies.length) {
    const policyNote = domainRule === 'block'
      ? 'Bloqueaste las cookies de este dominio de forma explícita. Si el sitio las necesita para funcionar, podés revertirlo.'
      : 'La política actual bloquea cookies y almacenamiento persistente para los dominios que no están en la whitelist. Si el sitio necesita guardar cookies, puedes conceder ese permiso para este dominio.';
    const statusHtml = '<div class="perm-cookie-summary" style="margin-bottom:8px;">Estado del dominio: <strong>' + escapeHtml(policyLabel) + '</strong></div>'
      + '<div class="bp-empty"><div class="bp-empty-icon">&#127850;</div><div>No hay cookies persistentes para ' + escapeHtml(domain) + '</div></div>'
      + '<div class="perm-cookie-summary" style="margin-top:8px;">' + escapeHtml(policyNote) + '</div>'
      + '<div class="perm-cookie-actions" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">'
      + '<button class="mini-btn" onclick="allowCookie(' + JSON.stringify(domain) + ', ' + JSON.stringify('__site_permission__') + ', ' + JSON.stringify('/') + ')">Permitir cookies</button>'
      + '<button class="mini-btn danger" onclick="banCookieDomain(' + JSON.stringify(domain) + ')">Bloquear cookies</button>'
      + '</div>';
    list.innerHTML = statusHtml;
    return;
  }

  const scopeLabel = (cookieDomain, requestedDomain) => {
    const normalized = String(cookieDomain || requestedDomain || '').replace(/^\./, '').toLowerCase();
    const requested = String(requestedDomain || '').replace(/^\./, '').toLowerCase();
    if (!normalized) return 'dominio';
    if (normalized === requested) return 'mismo dominio';
    if (requested.endsWith('.' + normalized)) return 'subdominio asociado';
    if (normalized.endsWith('.' + requested)) return 'dominio raíz';
    return 'dominio relacionado';
  };

  const summary = '<div class="perm-cookie-summary" style="margin-bottom:8px;">' + cookies.length + ' datos encontrados para <strong>' + escapeHtml(domain) + '</strong>. Estado: <strong>' + escapeHtml(policyLabel) + '</strong></div>';
  const currentCookies = cookies.filter(cookie => normalizeDomainInput(cookie.domain || domain) === domain);
  const insertedCookies = cookies.filter(cookie => normalizeDomainInput(cookie.domain || domain) !== domain);
  const renderCookie = cookie => {
    const name = String(cookie.name || 'cookie').replace(/'/g, "\\'");
    const domainName = String(cookie.domain || domain).replace(/'/g, "\\'");
    const path = String(cookie.path || '/').replace(/'/g, "\\'");
    const cookieScope = scopeLabel(cookie.domain || domain, domain);
    const cookieHost = String(cookie.domain || domain).replace(/^\./, '');
    const allowArgs = [JSON.stringify(domainName), JSON.stringify(name), JSON.stringify(path)].join(', ');
    const deleteArgs = [JSON.stringify(domainName), JSON.stringify(name), JSON.stringify(path)].join(', ');
    return '<div class="perm-cookie-row">'
      + '<div class="perm-cookie-main">'
      + '<strong>'+escapeHtml(cookie.name || 'cookie')+'</strong>'
      + '<span>Dominio cookie: '+escapeHtml(cookieHost)+' · Ruta: '+escapeHtml(path)+'</span>'
      + '<small><span class="cookie-scope">'+escapeHtml(cookieScope)+'</span> · '+(cookie.session ? 'sesión' : 'persistente')+'</small>'
      + '<details class="perm-cookie-more"><summary>Ver datos insertados</summary><div class="perm-cookie-data">Valor: '+escapeHtml(cookie.value || '(vacío)')+'<br>Secure: '+(cookie.secure ? 'sí' : 'no')+' · HttpOnly: '+(cookie.httpOnly ? 'sí' : 'no')+' · SameSite: '+escapeHtml(cookie.sameSite || 'unspecified')+'<br>Expira: '+(cookie.expirationDate ? new Date(cookie.expirationDate * 1000).toLocaleString() : 'al cerrar la sesión')+'</div></details>'
      + '</div>'
      + '<div class="perm-cookie-actions">'
      + '<button class="mini-btn" onclick="allowCookie(' + allowArgs + ')">Permitir</button>'
      + '<button class="mini-btn" onclick="removeCookieRow(' + deleteArgs + ')">Borrar</button>'
      + '<button class="mini-btn danger" onclick="banCookieDomain(' + JSON.stringify(domainName) + ')">Bloquear cookies</button>'
      + '</div>'
      + '</div>';
  };
  const renderGroup = (title, group) => group.length ? '<div class="perm-cookie-group-title">' + title + ' (' + group.length + ')</div>' + group.map(renderCookie).join('') : '';
  list.innerHTML = summary + renderGroup('Datos del sitio', currentCookies) + renderGroup('Datos insertados por otros dominios', insertedCookies);
}

async function allowCookie(domain, name, path) {
  if (!domain || !name) return;
  await mc.setCookiePolicyForDomain(domain, 'allow');
  await refreshPageCookies();
}

async function removeCookieRow(domain, name, path) {
  if (!domain || !name) return;
  await mc.removeSiteCookie(domain, name, path || '/');
  await refreshPageCookies();
}

async function banCookieDomain(domain) {
  if (!domain) return;
  await mc.setCookiePolicyForDomain(domain, 'block');
  await refreshPageCookies();
  await renderPermissionsList();
}

async function blockHost(domain, mode = 'domain', site) {
  const host = normalizeDomainInput(domain);
  if (!host) return;
  const currentSite = normalizeDomainInput(getCurrentPageDomain());
  if (currentSite) await mc.setAdblockSiteAllowed(currentSite, false);
  await mc.setAdblockHostAllowed(host, false);
  const pattern = mode === 'subdomain' ? '*.' + host : host;
  // Verificar si ya existe esta regla (global o misma sitio)
  const exists = state.customBlocks.some(b => {
    if (!patternMatchesHost(b, host)) return false;
    if (site) return state.siteBlockMap[b] === site;
    return !state.siteBlockMap[b];
  });
  if (!exists) {
    state.customBlocks.push(pattern);
    if (site) state.siteBlockMap[pattern] = site;
    await mc.addBlockRule({ pattern, action: 'block', site: site || undefined });
  }
  await mc.setCookiePolicyForDomain(host, 'block');
  if (state.cfg) state.cfg.allowlist = { ...(state.cfg.allowlist || {}), [host]: 'block' };
  await renderPermissionsList();
  renderCustomBlocks();

  const wv = $('webview-' + state.activeTab);
  if (wv && typeof wv.reload === 'function') {
    reloadTab(state.activeTab);
    const scopeLabel = site ? ' (solo en ' + site + ')' : '';
    addSidebarLog('blocked', '[HOST] ' + host + ' bloqueado' + scopeLabel + ' — recargando página');
  }
}

async function blockHostSite(domain) {
  const host = normalizeDomainInput(domain);
  const site = normalizeDomainInput(getCurrentPageDomain());
  if (!host || !site || host === site) return;
  await blockHost(domain, 'domain', site);
}

async function unblockHost(domain) {
  const host = normalizeDomainInput(domain);
  if (!host) return;
  const currentSite = normalizeDomainInput(getCurrentPageDomain());
  // Remover todas las reglas que coincidan con este host (globales y site-scoped)
  const toRemove = state.customBlocks.filter(b => patternMatchesHost(b, host));
  for (const pattern of toRemove) {
    state.customBlocks = state.customBlocks.filter(v => v !== pattern);
    delete state.siteBlockMap[pattern];
    await mc.removeBlockRule(pattern);
  }
  await mc.setAdblockHostAllowed(host, true);
  if (currentSite) await mc.setAdblockSiteAllowed(currentSite, true);
  await mc.setCookiePolicyForDomain(host, 'allow');
  if (state.cfg) state.cfg.allowlist = { ...(state.cfg.allowlist || {}), [host]: 'allow' };
  await renderPermissionsList();
  renderCustomBlocks();

  const wv = $('webview-' + state.activeTab);
  if (wv && typeof wv.reload === 'function') {
    reloadTab(state.activeTab);
    addSidebarLog('allowed', '[HOST] ' + host + ' desbloqueado — recargando página');
  }
}

async function addPermissionRule() {
  const domain = normalizeDomainInput($('permission-domain')?.value || getCurrentPageDomain());
  const origin = normalizeDomainInput(getCurrentPageDomain());
  const permission = ($('permission-permission')?.value || 'camera');
  const mode = ($('permission-mode')?.value || 'allow');
  if (!domain) return;
  const result = await mc.setSitePermission(domain, permission, mode, origin);
  if (result && result.ok) {
    $('permission-domain').value = domain;
    const wv = $('webview-' + state.activeTab);
    if (wv && state.currentPanel === 'webview' && typeof wv.reload === 'function') reloadTab(state.activeTab);
    await loadPermissionsList();
  }
}

async function removePermissionRule(domain, permission) {
  if (!domain || !permission) return;
  const origin = normalizeDomainInput(getCurrentPageDomain());
  const target = normalizeDomainInput(domain);
  if (origin && target) {
    state.permissionHostHints[origin] = [...new Set([...(state.permissionHostHints[origin] || []), target])];
  }
  await mc.removeSitePermission(domain, permission);
  await loadPermissionsList();
}

async function removeDomainPermission(domain) {
  if (!domain) return;
  await mc.removePermission(domain);
  await loadPermissionsList();
}

// ── Domain block levels (light / permanent / global) ──
async function setDomainBlockLevel(level) {
  const domain = normalizeDomainInput($('permission-domain')?.value || getCurrentPageDomain());
  if (!domain) return;
  const light = $('perm-block-light');
  const permanent = $('perm-block-permanent');
  const global = $('perm-block-global');
  if (!light || !permanent || !global) return;

  if (level === 'none') {
    await clearDomainBlock();
    return;
  }

  // Reset all toggles, then set the selected one
  const saveSession = $('perm-save-session');
  if (saveSession) saveSession.checked = false;
  light.checked = false;
  permanent.checked = false;
  global.checked = false;
  if (level === 'light') light.checked = true;
  else if (level === 'permanent') permanent.checked = true;
  else if (level === 'global') global.checked = true;

  try {
    await clearDomainBlock(false);
    if (level === 'light') {
      // Bloqueo leve: solo cookies de sesión para este dominio
      await mc.setCookiePolicyForDomain(domain, 'session');
      if (state.cfg) state.cfg.allowlist = { ...(state.cfg.allowlist || {}), [domain]: 'session' };
      addSidebarLog('modified', '[PERM] '+domain+' → bloqueo leve (sesión)');
    } else if (level === 'permanent') {
      // Bloqueo permanente: bloquear cookies + regla de bloqueo para el dominio
      await mc.setCookiePolicyForDomain(domain, 'block');
      if (state.cfg) state.cfg.allowlist = { ...(state.cfg.allowlist || {}), [domain]: 'block' };
      if (!state.customBlocks.some(b => patternMatchesHost(b, domain))) {
        state.customBlocks.push(domain);
        await mc.addBlockRule({ pattern: domain, action: 'block' });
        renderCustomBlocks();
      }
      addSidebarLog('blocked', '[PERM] '+domain+' → bloqueo permanente');
    } else if (level === 'global') {
      // Bloqueo global: bloquear cookies + regla de bloqueo para dominio y subdominios
      await mc.setCookiePolicyForDomain(domain, 'block');
      if (state.cfg) state.cfg.allowlist = { ...(state.cfg.allowlist || {}), [domain]: 'block' };
      const wildcard = '*.' + domain;
      if (!state.customBlocks.some(b => patternMatchesHost(b, wildcard))) {
        state.customBlocks.push(wildcard);
        await mc.addBlockRule({ pattern: wildcard, action: 'block' });
        renderCustomBlocks();
      }
      addSidebarLog('blocked', '[PERM] '+domain+' → bloqueo global');
    }
    await renderPermissionsList();
  } catch (e) {
    addSidebarLog('blocked', '[PERM] Error al aplicar bloqueo: '+e.message);
  }
}

async function setSaveSession(save) {
  const domain = normalizeDomainInput($('permission-domain')?.value || getCurrentPageDomain());
  if (!domain) return;
  if (save) {
    await mc.setCookiePolicyForDomain(domain, 'allow');
    if (state.cfg) state.cfg.allowlist = { ...(state.cfg.allowlist || {}), [domain]: 'allow' };
    addSidebarLog('allowed', '[PERM] ' + domain + ' → cookies persistentes');
  } else {
    await mc.removeCookieRule(domain);
    if (state.cfg && state.cfg.allowlist) {
      const next = { ...state.cfg.allowlist };
      delete next[domain];
      state.cfg.allowlist = next;
    }
    addSidebarLog('modified', '[PERM] ' + domain + ' → política global de cookies');
  }
  await renderPermissionsList();
}

async function clearDomainBlock(refresh = true) {
  const domain = normalizeDomainInput($('permission-domain')?.value || getCurrentPageDomain());
  if (!domain) return;
  const saveSession = $('perm-save-session');
  const light = $('perm-block-light');
  const permanent = $('perm-block-permanent');
  const global = $('perm-block-global');
  if (saveSession) saveSession.checked = true; // clearDomainBlock → allow → cookies persistentes
  if (light) light.checked = false;
  if (permanent) permanent.checked = false;
  if (global) global.checked = false;
  // Remover todas las reglas que coincidan con este dominio (incluye globales y site-scoped)
  const toRemove = state.customBlocks.filter(b => patternMatchesHost(b, domain));
  for (const pattern of toRemove) {
    state.customBlocks = state.customBlocks.filter(v => v !== pattern);
    delete state.siteBlockMap[pattern];
    await mc.removeBlockRule(pattern);
  }
  await mc.setCookiePolicyForDomain(domain, 'allow');
  if (state.cfg) state.cfg.allowlist = { ...(state.cfg.allowlist || {}), [domain]: 'allow' };
  renderCustomBlocks();
  if (refresh) {
    const wv = $('webview-' + state.activeTab);
    if (wv && state.currentPanel === 'webview' && typeof wv.reload === 'function') reloadTab(state.activeTab);
    await renderPermissionsList();
    addSidebarLog('allowed', '[PERM] ' + domain + ' → desbloqueado');
  }
}

// Refresh permissions when switching tabs or navigating
function hookPermissionsRefresh() {
  const origSwitchTab = window.switchTab;
  if (typeof origSwitchTab === 'function') {
    window.switchTab = function(...args) {
      const r = origSwitchTab.apply(this, args);
      setTimeout(() => {
        const panel = $('permissions-panel');
        if (panel && !panel.classList.contains('collapsed')) refreshPermissionsForActivePage();
      }, 100);
      return r;
    };
  }
  const origLoadUrl = window.loadUrl;
  if (typeof origLoadUrl === 'function') {
    window.loadUrl = function(...args) {
      const r = origLoadUrl.apply(this, args);
      setTimeout(() => {
        const panel = $('permissions-panel');
        if (panel && !panel.classList.contains('collapsed')) refreshPermissionsForActivePage();
      }, 800);
      return r;
    };
  }
}
hookPermissionsRefresh();
