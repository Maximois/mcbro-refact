'use strict';
/**
 * MC Browser -- src/main/stats/tracker.js
 *
 * Contadores del navegador: que se pidio, que se bloqueo y por quien.
 * Es el dueno de STATS, de MEDIA_URLS y de blockedHostsByTab.
 *
 * -----------------------------------------------------------------------------
 * INVARIANTE -- STATS SE REASIGNA, IGUAL QUE CFG
 * -----------------------------------------------------------------------------
 * 'reset-stats' (este archivo) y 'sessions:clear-data' / 'history:clear'
 * (main.js, hasta que se extraigan) hacen STATS = { ...ceros... }: REASIGNAN, no
 * mutan.
 *
 * Por eso fuera de aqui NO se importa STATS directamente. Se usa getStats(), que
 * devuelve el objeto vivo, o los accesores de abajo.
 *
 *   const { STATS } = require('./tracker');   // MAL: queda congelado en el
 *   const t = require('./tracker');           // primer objeto y sigue contando
 *   t.getStats().detectedAds++;               // ahi, no en el nuevo.
 *
 * Es el mismo problema que CFG (docs/RESTRUCTURACION.md 2.1) y que
 * bookmarksStore.items / historyStore.items. Mismo patron, misma trampa.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- detected* y blocked* no son la misma cifra
 * -----------------------------------------------------------------------------
 * detected* cuenta lo que el MOTOR de adblock detecto y bloqueo. blocked* cuenta
 * el total de bloqueos de esa categoria, venga de donde venga.
 *
 * Antes se condicionaba detected* a que el clasificador NO coincidiera con el
 * tipo forzado, o sea se contaban las DISCREPANCIAS en vez de las detecciones, y
 * un bloqueo bien clasificado no sumaba nada. Ver recordBlockedRequest().
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- { ...STATS, uptime } esta escrito 6 veces
 * -----------------------------------------------------------------------------
 * Repetido literal en recordBlockedRequest, scheduleStatsUpdate,
 * recordObservedRequest, get-stats y en los dos emits de checkMedia. Se dejo tal
 * cual al mover; si se extrae a un statsSnapshot(), que sea en un commit con su
 * propia justificacion, no de paso.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 3 -- MEDIA_URLS se MUTA in situ
 * -----------------------------------------------------------------------------
 * A diferencia de los arrays de src/main/data/, aqui se hace push / splice /
 * length = 0: nunca se reasigna. Por eso getMediaUrls() puede devolver la
 * referencia sin riesgo. Tope de 500 entradas.
 *
 * blockedHostsByTab tiene dos topes sueltos: 500 hosts por pestana y 200
 * pestanas rastreadas a la vez. El segundo borra la MAS ANTIGUA por orden de
 * insercion del Map, no por uso.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 4 -- el IPC se registra al importar el modulo
 * -----------------------------------------------------------------------------
 * Los handlers se registran al hacer require(), no dentro de app.whenReady(),
 * igual que los de permissions/. Si nadie requiere este modulo, 'get-stats' no
 * existe.
 */

const { ipcMain } = require('electron');
const { getMainWin } = require('../runtime');
const { isAuthDomain, isAuthRedirectFlow } = require('../navigation/domains');
const { isTrustedResource } = require('../../../modules/adblocker/main');



// Stats
let STATS = { pagesLoaded: 0, totalRequests: 0, detectedAds: 0, detectedTrackers: 0, detectedThird: 0, blockedAds: 0, blockedTrackers: 0, blockedThird: 0, blockedCrypto: 0, detectedMedia: 0, requestsBlocked: 0, cookiesBlocked: 0, bytesDownloaded: 0, uptimeStart: Date.now() };
const MEDIA_URLS = [];
// webContentsId -> Set<host> bloqueado por el motor de adblock (ads/trackers/
// third-party/reglas custom) en la página actual de esa pestaña. Antes solo
// se avisaba al renderer de bloqueos de tipo 'script' (recordBlockedRequest);
// el panel de Permisos ("Hosts cargados") solo conocía sus reglas manuales
// (customBlocks/allowlist), así que un host bloqueado por las listas de
// filtros (el motor principal) se mostraba igual como "Activo". Se resetea
// por pestaña en cada navegación de frame principal (ver did-start-navigation).
const blockedHostsByTab = new Map();
function trackBlockedHost(webContentsId, url) {
  if (!webContentsId) return;
  let host;
  try { host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return; }
  if (!host) return;
  let set = blockedHostsByTab.get(webContentsId);
  if (!set) { set = new Set(); blockedHostsByTab.set(webContentsId, set); }
  if (set.size < 500) set.add(host);
  // Acotar cuántas pestañas se rastrean a la vez (memoria)
  if (blockedHostsByTab.size > 200) {
    const oldestKey = blockedHostsByTab.keys().next().value;
    if (oldestKey !== webContentsId) blockedHostsByTab.delete(oldestKey);
  }
}
ipcMain.handle('get-blocked-hosts', (_e, webContentsId) => Array.from(blockedHostsByTab.get(webContentsId) || []));
const REQ_LOG_TYPES = new Set(['main_frame', 'mainFrame', 'xmlhttprequest', 'fetch', 'websocket', 'manifest', 'script']);
const AD_REQUEST_RE = /doubleclick|googlesyndication|googleadservices|adservice|adsystem|adnxs|adsrvr|rubicon|criteo|pubmatic|openx|casalemedia|moatads|taboola|outbrain|popunder|popads|adserver|advertising|adskeeper|exoclick|adcash|monetag|trafficfactory|prebid|pagead|\/ads?(?:[/?#]|$)|\/advert(?:[/?#]|$)|\/banner(?:[/?#]|$)|\/vast(?:[/?#]|$)/i;
const TRACKER_REQUEST_RE = /analytics|google-analytics|googletagmanager|tracking|tracker|telemetry|pixel|beacon|scorecardresearch|quantserve|demdex|hotjar|clarity\.ms|facebook\.net\/tr|fingerprint|session-replay|fullstory|mouseflow|mixpanel|amplitude|matomo|segment\.io/i;
function classifyRequest(url, documentUrl) {
  if (/\.(?:m3u8|ts|m4s|mp4|aac|mp3|webm|mpd)(?:[?#]|$)|(?:segment|chunk|playlist|\/stream(?:\/|$))/i.test(url)) return 'media';
  if (AD_REQUEST_RE.test(url)) return 'ads';
  if (TRACKER_REQUEST_RE.test(url)) return 'trackers';
  if (documentUrl && !isTrustedResource(url, documentUrl)) return 'third';
  return 'request';
}
function shouldReportRequest(details) {
  try {
    const rawUrl = details?.url || '';
    const docUrl = details?.documentUrl || details?.referrer || '';
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const docHost = docUrl ? new URL(docUrl).hostname.toLowerCase() : '';
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return false;
    if (isAuthDomain(host) || isAuthDomain(docHost) || isAuthRedirectFlow(host, docHost)) return false;
    if (host.endsWith('.whatsapp.net') || host.endsWith('.whatsapp.com')) return false;
    if (details?.resourceType === 'image' || details?.resourceType === 'stylesheet' || details?.resourceType === 'font' || details?.resourceType === 'media') return false;
    return REQ_LOG_TYPES.has(details?.resourceType);
  } catch {
    return false;
  }
}

function recordBlockedRequest(details, forcedType) {
  const type = forcedType || classifyRequest(details.url, details.documentUrl || details.referrer || '');
  // Los contadores 'detected*' / 'blocked*': detected cuenta lo que el motor
  // detecto como publicidad (y que por tanto bloqueo), blocked cuenta el
  // total. Antes se condicionaba a que el clasificador NO coincidiera con el
  // tipo forzado, o sea se contaban las discrepancias en vez de las
  // detecciones, y un bloqueo bien clasificado no sumaba nada.
  if (forcedType && type === 'ads') STATS.detectedAds++;
  if (forcedType && type === 'trackers') STATS.detectedTrackers++;
  if (forcedType && type === 'third') STATS.detectedThird++;
  if (type === 'ads') STATS.blockedAds++;
  if (type === 'trackers') STATS.blockedTrackers++;
  if (type === 'third') STATS.blockedThird++;
  if (type === 'request') STATS.requestsBlocked++;
  // Para TODOS los tipos de recurso (antes solo se avisaba de 'script' vía
  // req-blocked) — así "Hosts cargados" en el panel de Permisos puede saber
  // qué hosts bloqueó de verdad el motor de adblock, no solo los que el
  // usuario bloqueó a mano.
  trackBlockedHost(details.webContentsId, details.url);
  if (getMainWin() && !getMainWin().isDestroyed()) {
    if (details?.resourceType === 'script') {
      getMainWin().webContents.send('req-blocked', { type: 'script', resourceType: details.resourceType, blocked: true, url: details.url, msg: details.url });
    }
    getMainWin().webContents.send('stats-update', { ...STATS, uptime: Date.now() - STATS.uptimeStart });
  }
}
// Evita inundar el IPC en paginas con cientos de requests: coalesce en un
// update por segundo como maximo.
let _statsUpdateTimer = null;
function scheduleStatsUpdate() {
  if (_statsUpdateTimer) return;
  _statsUpdateTimer = setTimeout(() => {
    _statsUpdateTimer = null;
    if (!getMainWin() || getMainWin().isDestroyed()) return;
    try { getMainWin().webContents.send('stats-update', { ...STATS, uptime: Date.now() - STATS.uptimeStart }); } catch {}
  }, 1000);
}
function recordObservedRequest(details) {
  STATS.totalRequests++;
  if (details.resourceType === 'main_frame' || details.resourceType === 'mainFrame') STATS.pagesLoaded++;
  const type = classifyRequest(details.url, details.documentUrl || details.referrer || '');
  if (type === 'ads') STATS.detectedAds++;
  if (type === 'trackers') STATS.detectedTrackers++;
  if (type === 'third') STATS.detectedThird++;
  // shouldReportRequest() filtra imagenes/CSS/fuentes/media, asi que antes el
  // contador de requests totales subia cientos de veces por pagina y la UI
  // nunca recibia el evento: 'totalRequests' se quedaba congelado salvo que
  // hubiera un bloqueo. Se manda un update con throttle (~1s) para que el
  // contador se mueva sin spamear el IPC en cada request.
  scheduleStatsUpdate();
  if (getMainWin() && !getMainWin().isDestroyed() && shouldReportRequest(details)) {
    const short = details.url.replace(/https?:\/\//, '').substring(0, 80);
    getMainWin().webContents.send('req-blocked', { type, resourceType: details.resourceType, blocked: false, url: details.url, msg: short });
    getMainWin().webContents.send('stats-update', { ...STATS, uptime: Date.now() - STATS.uptimeStart });
  }
}


// --- Acceso al estado. Ver el INVARIANTE de la cabecera. ---
function getStats() {
  return STATS;
}

function statsSnapshot() {
  return { ...STATS, uptime: Date.now() - STATS.uptimeStart };
}

// Reasigna STATS a cero y ADEMAS vacia MEDIA_URLS. Es lo que hace 'reset-stats'.
function resetStats() {
  STATS = { pagesLoaded: 0, totalRequests: 0, detectedAds: 0, detectedTrackers: 0, detectedThird: 0, blockedAds: 0, blockedTrackers: 0, blockedThird: 0, blockedCrypto: 0, detectedMedia: 0, requestsBlocked: 0, cookiesBlocked: 0, bytesDownloaded: 0, uptimeStart: Date.now() };
  MEDIA_URLS.length = 0;
  return { ...STATS };
}

// Reasigna STATS a cero pero NO toca MEDIA_URLS. Es lo que hacen
// 'sessions:clear-data' y 'history:clear': limpiar la sesion no borra el catalogo
// de medios detectados; resetear las estadisticas si. No unificar los dos.
function zeroStats() {
  STATS = { pagesLoaded: 0, totalRequests: 0, detectedAds: 0, detectedTrackers: 0, detectedThird: 0, blockedAds: 0, blockedTrackers: 0, blockedThird: 0, blockedCrypto: 0, detectedMedia: 0, requestsBlocked: 0, cookiesBlocked: 0, bytesDownloaded: 0, uptimeStart: Date.now() };
  return { ...STATS };
}

function bumpDetectedMedia() {
  STATS.detectedMedia++;
  return STATS.detectedMedia;
}

function addCookiesBlocked(cantidad) {
  STATS.cookiesBlocked += Number(cantidad) || 0;
  return STATS.cookiesBlocked;
}

// did-start-navigation lo llama en cada navegacion de frame principal, para que
// "Hosts cargados" refleje solo la pagina actual de esa pestana.
function clearBlockedHosts(webContentsId) {
  return blockedHostsByTab.delete(webContentsId);
}

function getBlockedHosts(webContentsId) {
  return Array.from(blockedHostsByTab.get(webContentsId) || []);
}

// El catalogo de medios vive aqui, no en media-detect.js: asi 'reset-stats'
// puede vaciarlo sin que media-detect sepa nada del IPC.
function getMediaUrls() {
  return MEDIA_URLS;
}

function recordDetectedMedia(entry) {
  MEDIA_URLS.push(entry);
  if (MEDIA_URLS.length > 500) MEDIA_URLS.splice(0, MEDIA_URLS.length - 500);
  return MEDIA_URLS.length;
}

function alreadyDetectedMedia(url) {
  return MEDIA_URLS.find(m => m.url === url);
}

// === IPC ===
// OJO: 'get-blocked-hosts' ya venia registrado en el bloque copiado, justo
// debajo de trackBlockedHost. No volver a registrarlo aqui: Electron lanza al
// arrancar si dos ipcMain.handle usan el mismo canal.
ipcMain.handle('get-stats', () => ({ ...STATS, uptime: Date.now() - STATS.uptimeStart }));
ipcMain.handle('reset-stats', () => resetStats());
// Media detected by the active browser session
ipcMain.handle('get-media', () => MEDIA_URLS);

module.exports = {
  getStats,
  statsSnapshot,
  resetStats,
  zeroStats,
  bumpDetectedMedia,
  addCookiesBlocked,
  clearBlockedHosts,
  getBlockedHosts,
  getMediaUrls,
  recordDetectedMedia,
  alreadyDetectedMedia,
  trackBlockedHost,
  classifyRequest,
  shouldReportRequest,
  recordBlockedRequest,
  recordObservedRequest,
};
