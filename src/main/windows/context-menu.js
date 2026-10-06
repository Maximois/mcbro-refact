'use strict';
/**
 * MC Browser -- src/main/windows/context-menu.js
 *
 * El listener 'context-menu' de cada webContents: el menu del navegador
 * (navegacion, copiar, enlace, imagen, video, descargas, bloqueo cos 1).
 * El cuerpo se extrajo de main.js tal cual.
 *
 * Las dos funciones que necesita (saveBlobOrDataUrlToDownloads,
 * resolveCtxCssPoint) se quedan en main.js y se INYECTAN por deps. No se
 * movieron porque las dos son precisas para otros bloques que siguen en
 * main.js.
 */

const fs = require('fs');
const path = require('path');
const { app, Menu, clipboard, dialog } = require('electron');
const { ACTIONS, getMainWin } = require('../runtime');
const { CFG, saveCfg } = require('../config');
const Sessions = require('../sessions/partitions');

// Guard anti-reentrancia (Windows): si un popup anterior sigue abierto, lanzar
// otro `popup()` deja el menu congelado. Se libera en el callback que Electron
// invoca al cerrar el menu. Sin esta variable el `if` de mas abajo era un
// ReferenceError y el menu NUNCA aparecia.
let _ctxMenuPopupCount = 0;

// Corta una promesa que se cuelgue (executeJavaScript sobre una paginaRareza
// puede no responder nunca). Antes esto vivia en main.js; al extraer este
// bloque se quedo sin declarar y el try/catch silencioso se comia el error,
// dejando la deteccion de "elemento bloqueado" siempre a null.
function withTimeout(promise, ms, fallback) {
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

function installContextMenu(wc, deps = {}) {
  const { saveBlobOrDataUrlToDownloads, resolveCtxCssPoint } = deps;

  wc.on('context-menu', async (_contextEvent, params) => {
    if (Sessions.isWebchatSession(wc)) return;
    // Reglas cosméticas del usuario aplicables al dominio actual
    let pageDomain = '';
    try { pageDomain = new URL(wc.getURL()).hostname.replace(/^www\./i, '').toLowerCase(); } catch {}
    const allRules = (Array.isArray(CFG.userCosmeticRules) ? CFG.userCosmeticRules : [])
      .map(r => String(r || '').trim())
      .filter(r => r.includes('##'));
    const domainRules = allRules.filter(r => {
      const d = r.split('##')[0].trim().toLowerCase();
      return !d || pageDomain === d || pageDomain.endsWith('.' + d);
    });

    // Detectar si el elemento bajo el cursor ya está bloqueado por una regla cosmética
    let blockedRule = null;
    try {
      const selectors = domainRules.map(r => r.split('##')[1]);
      if (selectors.length) {
        const detect = (async () => {
          const pt = await resolveCtxCssPoint(wc, params);
          const selectorsJson = JSON.stringify(selectors)
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\$\{/g, '\\${');
          const match = await wc.executeJavaScript(`(() => {
          const px = ${pt.x};
          const py = ${pt.y};
          const el = document.elementFromPoint(px, py);
          if (!el) return null;
          const selectors = ${selectorsJson};
          let node = el;
          while (node && node.nodeType === 1) {
            for (const s of selectors) {
              try { if (node.matches(s)) return { selector: s }; } catch {}
            }
            node = node.parentElement;
          }
          return null;
        })()`);
          if (match?.selector) {
            return allRules.find(r => r.split('##')[1].trim() === match.selector) || null;
          }
          return null;
        })();
        blockedRule = await withTimeout(detect, 400, null);
      }
    } catch {}

    const template = [
      { label: 'Atrás', enabled: wc.canGoBack(), click: () => wc.goBack() },
      { label: 'Adelante', enabled: wc.canGoForward(), click: () => wc.goForward() },
      { label: 'Recargar', click: () => wc.reload() },
      { type: 'separator' },
      {
        label: 'Copiar',
        enabled: Boolean(params.selectionText),
        click: () => {
          const selectedText = String(params.selectionText || '');
          if (selectedText) clipboard.writeText(selectedText);
        }
      },
      { role: 'selectAll', label: 'Seleccionar todo', enabled: Boolean(params.isEditable || params.selectionText) },
    ];

    if (params.isEditable) {
      template.push(
        { type: 'separator' },
        { role: 'cut', label: 'Cortar' },
        { role: 'paste', label: 'Pegar' }
      );
    }
    if (params.linkURL) {
      template.push(
        { type: 'separator' },
        {
          label: 'Abrir enlace en nueva pestaña',
          click: () => getMainWin()?.webContents?.send('open-new-tab', params.linkURL)
        },
        {
          label: 'Copiar dirección del enlace',
          click: () => clipboard.writeText(params.linkURL)
        },
        {
          label: 'Descargar enlace',
          click: () => {
            const linkUrl = String(params.linkURL || '');
            if (/^https?:\/\//i.test(linkUrl)) wc.downloadURL(linkUrl);
            else if (/^(blob|data):/i.test(linkUrl)) {
              saveBlobOrDataUrlToDownloads(wc, linkUrl, params.linkText || 'descarga', params.frame)
                .then(result => { if (!result.ok) console.error('[blob-download]', result.error); });
            }
          }
        }
      );
    }
    template.push(
      { type: 'separator' },
      {
        label: 'Guardar página completa',
        click: async () => {
          if (!wc || wc.isDestroyed()) return;
          try {
            const pageUrl = params.pageURL || wc.getURL() || '';
            let title = wc.getTitle() || '';
            if (!title) {
              try { title = new URL(pageUrl).hostname; } catch {}
            }
            const safeTitle = String(title || 'pagina-web').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 100) || 'pagina-web';
            const dlDir = CFG.downloadDir || app.getPath('downloads');
            if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
            const save = await dialog.showSaveDialog(getMainWin(), {
              title: 'Guardar página completa',
              defaultPath: path.join(dlDir, safeTitle + '.mhtml'),
              filters: [{ name: 'Página web completa', extensions: ['mhtml'] }]
            });
            if (save.canceled || !save.filePath) return;
            const savedPath = await wc.savePage(save.filePath, 'MHTML');
            const filename = path.basename(savedPath || save.filePath);
            const filePath = savedPath || save.filePath;
            const sizeBytes = fs.statSync(filePath).size;
            const id = 'dl-page-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
            ACTIONS.emit('dl-native', { id, url: pageUrl, filename, totalBytes: sizeBytes, pageUrl, state: 'active' });
            ACTIONS.emit('dl-native-progress', { id, url: pageUrl, filename, received: sizeBytes, totalBytes: sizeBytes, pct: 100, state: 'progressing' });
            ACTIONS.emit('dl-native-done', { id, url: pageUrl, filename, file: filePath, size: (sizeBytes / 1048576).toFixed(1), state: 'completed', cancelled: false });
          } catch (error) {
            console.error('[save-page]', error.message || error);
          }
        }
      }
    );
    if (params.selectionText) {
      template.push({
        label: 'Buscar selección en nueva pestaña',
        click: () => getMainWin()?.webContents?.send(
          'open-new-tab',
          `https://duckduckgo.com/?q=${encodeURIComponent(params.selectionText)}`
        )
      });
    }
    if (params.mediaType === 'image' && params.srcURL) {
      template.push(
        {
          label: 'Copiar dirección de imagen',
          click: () => clipboard.writeText(params.srcURL)
        },
        {
          label: 'Descargar imagen',
          click: () => {
            if (/^https?:\/\//i.test(params.srcURL)) wc.downloadURL(params.srcURL);
            else if (/^(blob|data):/i.test(params.srcURL)) {
              saveBlobOrDataUrlToDownloads(wc, params.srcURL, 'imagen', params.frame)
                .then(r => { if (!r.ok) console.error('[blob-download]', r.error); });
            }
          }
        }
      );
    }
    const contextMediaUrl = String(params.srcURL || '');
    const isDirectContextMedia = /^https?:\/\//i.test(contextMediaUrl) &&
      /\.(?:m3u8|mpd|mp4|webm|mkv|m4v|mov|avi)(?:\?|#|$)/i.test(contextMediaUrl);
    const isContextHls = /\.m3u8(?:\?|#|$)/i.test(contextMediaUrl);
    const isContextDash = /\.mpd(?:\?|#|$)/i.test(contextMediaUrl);
    const isContextVideo = params.mediaType === 'video' ||
      /\.(?:mp4|webm|mkv|m4v|mov|avi)(?:\?|#|$)/i.test(contextMediaUrl);
    const contextMediaLabel = isContextHls ? 'Descargar playlist HLS'
      : isContextDash ? 'Descargar stream DASH'
      : /^(blob|data):/i.test(contextMediaUrl) && isContextVideo ? 'Guardar vídeo blob'
      : isContextVideo ? 'Descargar vídeo'
      : 'Descargar multimedia';
    if (params.srcURL && (params.mediaType !== 'none' || isDirectContextMedia)) {
      template.push(
        {
          label: 'Abrir recurso multimedia',
          click: () => getMainWin()?.webContents?.send('open-new-tab', params.srcURL)
        },
        {
          label: contextMediaLabel,
          click: () => {
            // Descargar desde el webContents que lanzó el menú, no desde
            // la ventana anfitriona: para un <video> incrustado en otro frame,
            // downloadURL desde la ventana principal no resuelve la URL.
            const target = (!wc || wc.isDestroyed()) ? getMainWin()?.webContents : wc;
            if (/^https?:\/\//i.test(params.srcURL)) target?.downloadURL(params.srcURL);
            else if (/^(blob|data):/i.test(params.srcURL)) {
              saveBlobOrDataUrlToDownloads(wc, params.srcURL, 'multimedia', params.frame)
                .then(r => { if (!r.ok) console.error('[blob-download]', r.error); });
            }
          }
        }
      );
    }
    if (blockedRule) {
      template.push(
        { type: 'separator' },
        {
          label: 'Desbloquear este elemento',
          click: async () => {
            CFG.userCosmeticRules = (CFG.userCosmeticRules || []).filter(r => r !== blockedRule);
            saveCfg();
            try { wc.reload(); } catch {}
            getMainWin()?.webContents?.send('cosmetic-unblock-result', { ok: true, rule: blockedRule });
          }
        }
      );
    }
    if (domainRules.length) {
      template.push(
        { type: 'separator' },
        {
          label: 'Desbloquear elemento...',
          submenu: domainRules.map(rule => ({
            label: rule.split('##')[1],
            click: () => {
              CFG.userCosmeticRules = (CFG.userCosmeticRules || []).filter(r => r !== rule);
              saveCfg();
              try { wc.reload(); } catch {}
              getMainWin()?.webContents?.send('cosmetic-unblock-result', { ok: true, rule });
            }
          }))
        }
      );
    }
    template.push(
      { type: 'separator' },
      {
        label: 'Bloquear este elemento',
        click: async () => {
          try {
            const pt = await resolveCtxCssPoint(wc, params);
            const px = pt.x;
            const py = pt.y;
            const info = await wc.executeJavaScript(`(() => {
              const px = ${px};
              const py = ${py};
              const isUsable = (e) => e && e.nodeType === 1 && e !== document.documentElement && e !== document.body;
              let el = document.elementFromPoint(px, py);
              if (!isUsable(el)) {
                const all = document.elementsFromPoint(px, py);
                for (const e of all) { if (isUsable(e)) { el = e; break; } }
              }
              // Refinar si el elemento es enorme (>40% del viewport): buscar iframes
              // cerca del punto (banners en blanco/colapsados o con pointer-events:none
              // que elementFromPoint ignora) o el elemento más pequeño en el punto
              if (isUsable(el)) {
                const r = el.getBoundingClientRect();
                const vw = window.innerWidth, vh = window.innerHeight;
                if (r.width * r.height > vw * vh * 0.4) {
                  let bestIframe = null, bestDist = Infinity;
                  for (const f of document.querySelectorAll('iframe')) {
                    const fr = f.getBoundingClientRect();
                    const w = fr.width || (parseInt(f.getAttribute('width'), 10) || 0);
                    const h = fr.height || (parseInt(f.getAttribute('height'), 10) || 0);
                    if (w < 8 || h < 8) continue;
                    const cx = Math.max(fr.left, Math.min(px, fr.right));
                    const cy = Math.max(fr.top, Math.min(py, fr.bottom));
                    const dist = Math.hypot(px - cx, py - cy);
                    if (dist < bestDist) { bestDist = dist; bestIframe = f; }
                  }
                  if (bestIframe && bestDist < 200) {
                    el = bestIframe;
                  } else {
                    const all = document.elementsFromPoint(px, py);
                    let best = null, bestArea = Infinity;
                    for (const e of all) {
                      if (!isUsable(e) || e === el) continue;
                      const er = e.getBoundingClientRect();
                      if (er.width < 24 || er.height < 24) continue;
                      if (er.width * er.height > vw * vh * 0.4) continue;
                      const area = er.width * er.height;
                      if (area < bestArea) { bestArea = area; best = e; }
                    }
                    if (best) el = best;
                  }
                }
              }
              if (!isUsable(el)) {
                let best = null, bestArea = Infinity, scanned = 0;
                const nodes = document.querySelectorAll('body *');
                for (const e of nodes) {
                  if (++scanned > 4000) break;
                  if (!isUsable(e)) continue;
                  const r = e.getBoundingClientRect();
                  if (r.width < 8 || r.height < 8) continue;
                  if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
                    const area = r.width * r.height;
                    if (area < bestArea) { bestArea = area; best = e; }
                  }
                }
                el = best;
              }
              if (!isUsable(el)) return null;
              const cssPath = (node) => {
                const parts = [];
                let cur = node;
                while (cur && cur.nodeType === 1 && parts.length < 6) {
                  let part = cur.tagName.toLowerCase();
                  if (cur.id) {
                    part += '#' + CSS.escape(cur.id).slice(0, 80);
                    parts.unshift(part);
                    break;
                  }
                  const parent = cur.parentElement;
                  if (parent) {
                    const siblings = [...parent.children].filter(c => c.tagName === cur.tagName);
                    if (siblings.length > 1) {
                      part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
                    }
                  }
                  if (cur.classList && cur.classList.length) {
                    part += '.' + [...cur.classList].slice(0, 3).map(c => CSS.escape(c)).join('.');
                  }
                  parts.unshift(part);
                  cur = cur.parentElement;
                }
                return parts.join(' > ');
              };
              const selector = cssPath(el);
              try {
                el.setAttribute('data-mc-blocked', '1');
                el.style.setProperty('display', 'none', 'important');
                el.style.setProperty('visibility', 'hidden', 'important');
                el.style.setProperty('height', '0', 'important');
                el.style.setProperty('max-height', '0', 'important');
                el.style.setProperty('overflow', 'hidden', 'important');
              } catch {}
              return {
                selector,
                tag: el.tagName.toLowerCase(),
                domain: location.hostname.replace(/^www\\./i, '').toLowerCase(),
                pageUrl: location.href
              };
            })()`);
            if (!info?.selector || !info?.domain) {
              getMainWin()?.webContents?.send('cosmetic-block-result', { ok: false, error: 'No se pudo identificar el elemento' });
              return;
            }
            const raw = `${info.domain}##${info.selector}`;
            if (!Array.isArray(CFG.userCosmeticRules)) CFG.userCosmeticRules = [];
            if (!CFG.userCosmeticRules.includes(raw)) {
              CFG.userCosmeticRules.push(raw);
              saveCfg();
            }
            try {
              await wc.insertCSS(`${info.selector}{display:none!important;visibility:hidden!important;height:0!important;max-height:0!important;overflow:hidden!important;margin:0!important;padding:0!important;}`);
            } catch {}
            getMainWin()?.webContents?.send('cosmetic-block-result', { ok: true, rule: raw, domain: info.domain, selector: info.selector });
          } catch (error) {
            getMainWin()?.webContents?.send('cosmetic-block-result', { ok: false, error: error.message || 'No se pudo bloquear el elemento' });
          }
        }
      },
      {
        label: 'Diagnosticar elemento con IA (adblock)',
        click: async () => {
          try {
            const pt = await resolveCtxCssPoint(wc, params);
            // NOTA DE ESCAPADO para todo lo que sigue: este bloque es un
            // TEMPLATE LITERAL, asi que cada `\\` del source llega a la pagina
            // como `\`. Por eso los regex de abajo estan escritos con doble
            // barra (`facebook\\.com\\/tr`, `replace(/\\s+/g,'')`) y NO es un
            // error: es obligatorio. Si se "simplifica" a un solo `\`, la
            // pagina recibe `s*` o un escape mal formado y la deteccion de
            // trackers/ads deja de funcionar silenciosamente.
            const element = await wc.executeJavaScript(`(() => {
              const px = ${pt.x};
              const py = ${pt.y};
              const el = document.elementFromPoint(px, py);
              if (!el) return null;

              const adTokens = /ad|ads|advert|banner|sponsor|promo|popunder|popup|interstitial|tracking|tracker|pixel|beacon|syndication|doubleclick|taboola|outbrain|criteo|exoclick|propeller|monetag|adsterra|popads|clickadu|adcash|juicyads|trafficjunky|zergnet|revcontent|mgid|adnxs|prebid|dfp|gpt|adsbygoogle|adserver|adframe|adslot|ad-container|ad_wrapper|adblock|sponsored/i;
              const trackerHosts = /doubleclick|googlesyndication|googleadservices|adnxs|adsrvr|rubicon|criteo|pubmatic|openx|taboola|outbrain|exoclick|propeller|monetag|adsterra|popads|hotjar|clarity|scorecardresearch|quantserve|facebook\\.com\\/tr|analytics|pixel|beacon/i;

              const short = (v, n = 300) => String(v || '').slice(0, n);
              const cssPath = (node) => {
                const parts = [];
                let cur = node;
                while (cur && cur.nodeType === 1 && parts.length < 10) {
                  let part = cur.tagName.toLowerCase();
                  if (cur.id) part += '#' + CSS.escape(cur.id).slice(0, 80);
                  else if (cur.classList.length) part += '.' + [...cur.classList].slice(0, 4).map(CSS.escape).join('.');
                  parts.unshift(part);
                  cur = cur.parentElement;
                }
                return parts.join(' > ');
              };

              const styleOf = (node) => {
                try {
                  const cs = getComputedStyle(node);
                  return {
                    display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
                    position: cs.position, zIndex: cs.zIndex, pointerEvents: cs.pointerEvents,
                    width: cs.width, height: cs.height, overflow: cs.overflow,
                    transform: short(cs.transform, 120), filter: short(cs.filter, 80)
                  };
                } catch { return {}; }
              };

              const rect = el.getBoundingClientRect();
              const attrs = Object.fromEntries([...el.attributes].slice(0, 40).map(a => [a.name, short(a.value, 400)]));
              const text = short((el.innerText || el.textContent || '').trim(), 800);
              const html = short(el.outerHTML, 5000);

              const parents = [];
              let node = el.parentElement;
              while (node && node.nodeType === 1 && parents.length < 8) {
                parents.push({
                  tag: node.tagName.toLowerCase(),
                  id: node.id || undefined,
                  classes: [...node.classList].slice(0, 6),
                  role: node.getAttribute('role') || undefined,
                  suspicious: adTokens.test((node.id || '') + ' ' + [...node.classList].join(' ') + ' ' + (node.getAttribute('data-ad') || ''))
                });
                node = node.parentElement;
              }

              const iframe = el.closest('iframe, frame, embed, object');
              const mediaEl = el.closest('video, audio, img, picture, source');
              const shadowHost = (() => {
                let n = el;
                while (n) {
                  if (n.host) return { tag: n.host.tagName?.toLowerCase(), selector: cssPath(n.host) };
                  n = n.parentNode;
                }
                return null;
              })();

              const relatedResources = (performance.getEntriesByType('resource') || [])
                .map(r => r.name)
                .filter(url => {
                  const u = url.toLowerCase();
                  const hints = [el.id, ...el.classList, el.getAttribute('src'), el.getAttribute('href'), el.getAttribute('data-src')].filter(Boolean).join(' ').toLowerCase();
                  return trackerHosts.test(u) || adTokens.test(u) || (hints && u.includes(short(hints, 40).replace(/\\s+/g, '')));
                })
                .slice(0, 20)
                .map(url => ({ url: short(url, 220), tracker: trackerHosts.test(url), adLike: adTokens.test(url) }));

              const scriptsNearby = [...document.scripts]
                .map(s => s.src || (s.textContent || '').trim().slice(0, 120))
                .filter(src => src && (trackerHosts.test(src) || adTokens.test(src)))
                .slice(0, 12);

              const suspiciousSignals = [];
              if (adTokens.test((el.id || '') + ' ' + [...el.classList].join(' ') + ' ' + Object.values(attrs).join(' '))) suspiciousSignals.push('id/class/atributos con tokens publicitarios');
              if (iframe) suspiciousSignals.push('dentro de iframe/embed/object');
              if (styleOf(el).position === 'fixed' || styleOf(el).position === 'absolute') suspiciousSignals.push('posicion flotante (' + styleOf(el).position + ', z-index ' + styleOf(el).zIndex + ')');
              if (parseFloat(styleOf(el).opacity) < 0.2) suspiciousSignals.push('opacidad muy baja');
              if (rect.width < 2 || rect.height < 2) suspiciousSignals.push('elemento casi invisible');
              if (el.tagName === 'IFRAME' && el.src && !el.src.startsWith(location.origin)) suspiciousSignals.push('iframe cross-origin: ' + short(el.src, 180));
              if (relatedResources.length) suspiciousSignals.push(relatedResources.length + ' recursos de red sospechosos');

              return {
                mode: 'adblock-diagnosis',
                tag: el.tagName.toLowerCase(),
                text,
                attributes: attrs,
                selector: cssPath(el),
                html,
                boundingRect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
                computedStyle: styleOf(el),
                parents,
                iframe: iframe ? { tag: iframe.tagName.toLowerCase(), src: short(iframe.src || iframe.getAttribute('src'), 300), sandbox: iframe.getAttribute('sandbox'), allow: iframe.getAttribute('allow') } : null,
                media: mediaEl ? { tag: mediaEl.tagName.toLowerCase(), src: short(mediaEl.currentSrc || mediaEl.src || mediaEl.getAttribute('src'), 300) } : null,
                shadowHost,
                suspiciousSignals,
                relatedResources,
                scriptsNearby,
                clickPoint: { x: px, y: py },
                pageUrl: location.href,
                pageTitle: document.title || location.hostname,
                viewport: { width: innerWidth, height: innerHeight }
              };
            })()`);
            if (element) getMainWin()?.webContents?.send('ai-element-selected', element);
          } catch (error) {
            getMainWin()?.webContents?.send('ai-element-selected', { error: error.message || 'No se pudo inspeccionar el elemento' });
          }
        }
      },
      { label: 'Inspeccionar elemento', click: () => wc.inspectElement(params.x, params.y) }
    );

    template.push({
      label: 'Extraer imágenes y enlaces directos',
      click: async () => {
        try {
          const resources = await wc.executeJavaScript(`(() => {
            try {
              const found = [];
              const add = (url, type, label) => {
                if (!url || !/^https?:\\/\\//i.test(url)) return;
                let absolute;
                try { absolute = new URL(url, location.href).href; } catch (e) { return; }
                if (!found.some(item => item.url === absolute)) found.push({ url: absolute, type, label });
              };
              document.querySelectorAll('img').forEach((el, index) => add(el.currentSrc || el.src, 'image', el.alt || 'Imagen ' + (index + 1)));
              document.querySelectorAll('video, audio').forEach((el, index) => {
                add(el.currentSrc || el.src, el.tagName.toLowerCase(), el.getAttribute('title') || el.getAttribute('aria-label') || el.tagName + ' ' + (index + 1));
                el.querySelectorAll('source').forEach(source => add(source.src, el.tagName.toLowerCase(), source.type || 'source'));
              });
              document.querySelectorAll('a[href]').forEach((el, index) => add(el.href, 'link', (el.innerText || el.textContent || '').trim().slice(0, 100) || 'Enlace ' + (index + 1)));
              document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach(el => add(el.content, 'image', 'Imagen social'));
              return { page: location.href, title: document.title || location.hostname, resources: found.slice(0, 500) };
            } catch (e) {
              return { page: location.href, title: document.title || location.hostname, resources: [], error: String(e && e.message || e) };
            }
          })()`);
          getMainWin()?.webContents?.send('page-extract-results', resources);
        } catch (error) {
          getMainWin()?.webContents?.send('page-extract-results', { error: error.message || 'No se pudo extraer la página' });
        }
      }
    });
    // Guard anti-reentrancia (Windows): si un popup anterior aún no terminó de
    // cerrarse, lanzar otro `popup()` deja el menú congelado. Se libera en el
    // callback de popup, que Electron invoca al cerrar el menú.
    if (_ctxMenuPopupCount > 0) return;
    _ctxMenuPopupCount++;
    try {
      Menu.buildFromTemplate(template).popup({
        window: getMainWin(),
        callback: () => { _ctxMenuPopupCount = 0; }
      });
    } catch {
      _ctxMenuPopupCount = 0;
    }
  });
}

module.exports = { installContextMenu };
