'use strict';
/**
 * MC Browser -- src/main/net/cookie-guard.js
 *
 * La politica de cookies aplicada a lo que una pagina se pone con
 * document.cookie, que es el unico hueco que deja onHeadersReceived.
 *
 * -----------------------------------------------------------------------------
 * POR QUE CDP Y NO UN OVERRIDE DE document.cookie EN EL PRELOAD
 * -----------------------------------------------------------------------------
 * Con contextIsolation:true (como esta configurada esta app), el "document" que
 * ve preload.js es un wrapper de un mundo aislado, distinto del que ve el script
 * de la pagina: un Object.defineProperty(cookie) hecho ahi le seria INVISIBLE al
 * sitio. La forma confiable de meterse en el mundo principal antes de que corra
 * nada propio es Page.addScriptToEvaluateOnNewDocument, que es lo que hacen
 * Puppeteer y Playwright.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- tres WeakMap/WeakSet y para que cada uno
 * -----------------------------------------------------------------------------
 *   cookieGuardIds            wc -> identifier del script CDP registrado
 *   cookieGuardOwned          wc -> el debugger lo adjunto ESTE modulo
 *   cookieGuardLifecycleInstalled wc -> ya le pusimos los listeners de limpieza
 *   cookieGuardTasks          wc -> promise de la actualizacion en curso
 *
 * `cookieGuardOwned` es lo que impide que nos desconectemos el debugger de otro:
 * Perchance tambien usa CDP sobre las suyas (wc.debugger.attach en setupPerchanceNetwork).
 * Si nos desconectamos de un debugger que no era nuestro, le rompemos el panel.
 * Por eso detachCookieGuard() solo hace detach() si owned.
 *
 * WeakMap/WeakSet y no Map/Set a proposito: no retienen webContents destruidos.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- el filtro de sesiones lo decide sessions/partitions.js
 * -----------------------------------------------------------------------------
 * Solo se protegen los webviews de la sesion principal y de las aisladas, no los
 * de WebChat ni los del panel de Perchance. Ese filtro es
 * Sessions.esWebviewProtegido (main + aisladas), de sessions/partitions.js.
 *
 * Antes este filtro llegaba por parámetro porque el módulo no existía. Ya no:
 * se importa. NO reescribir el predicado aquí, que duplicaría la decisión y
 * acabaría discrepando del que usa el resto de la app.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 3 -- el script CDP se RE-REGISTRA en cada cambio de politica
 * -----------------------------------------------------------------------------
 * El override se queda en el mundo de la pagina actual, asi que cambiar CFG no
 * lo cambia en las pestanas abiertas. registerCookieGuardScript() quita el
 * anterior con Page.removeScriptToEvaluateOnNewDocument y pone el nuevo, que
 * aplica a la SIGUIENTE navegacion. Las cookies ya escritas en la pagina actual
 * no se tocan: para eso esta applyCookiePolicy(), que ademas borra del jar las
 * que ya persistieron y no deben existir.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 4 -- attach es idempotente pero el lifecycle no se repite
 * -----------------------------------------------------------------------------
 * installCookieGuardLifecycle() se guarda una sola vez por wc. attachCookieGuard()
 * puede llamado cuantas veces sea; solo attach() si no habia debugger.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 5 -- cookieRemovalUrl() vive aqui pero se usa desde 8 sitios de main.js
 * -----------------------------------------------------------------------------
 * Construye la URL que exige cookies.remove(). Se exporta desde aqui porque es
 * lo mas cercano a su unico uso, pero los llamadores incluyen el IPC de sesiones
 * (clear-cookies, add-cookie-rule...) que es del paso 14.
 *
 * Ojo con `secure`: el default es true (solo https), y `cookie?.secure !== false`
 * hace que un undefined cuente como seguro. Es a proposito: si no se sabe, se
 * asume la opcion restrictiva.
 */

const { session } = require('electron');
const { CFG } = require('../config');
const Permissions = require('../../../lib/permissions');
const { getAllowlistPolicyForHost } = require('../permissions/adapters');
const { isAuthDomain } = require('../navigation/domains');
const Sessions = require('../sessions/partitions');



function cookieRemovalUrl(cookie, fallbackHost) {
  const domain = String(cookie?.domain || fallbackHost || '').replace(/^\./, '');
  const cookiePath = String(cookie?.path || '/');
  const secure = cookie?.secure !== false;
  const scheme = secure ? 'https' : 'http';
  return `${scheme}://${domain}${cookiePath.startsWith('/') ? cookiePath : '/' + cookiePath}`;
}

// ── Cookie guard para document.cookie (vía CDP) ──────────────────────────
// onHeadersReceived (más abajo) solo ve cookies puestas por el header HTTP
// Set-Cookie. Las que un sitio setea desde su propio JS (document.cookie =
// "...") nunca generan esa respuesta de red, así que la política de
// bloqueo/sesión no se entera.
//
// Un Object.defineProperty(document, 'cookie', ...) hecho desde preload.js
// NO sirve acá: con contextIsolation:true (como está configurada esta app),
// el "document" que ve el preload es un wrapper de un mundo aislado,
// distinto del que ve el script de la propia página — el override quedaría
// invisible para ella.
//
// La forma confiable de intervenir el mundo principal de cada página, antes
// de que corra cualquier script propio, es CDP: Page.addScriptToEvaluateOnNewDocument
// (la misma técnica que usan Puppeteer/Playwright). Se re-registra cada vez
// que cambia la política de cookies para que quede al día.
const cookieGuardIds = new WeakMap(); // webContents -> identifier del script CDP registrado
const cookieGuardOwned = new WeakSet();
const cookieGuardLifecycleInstalled = new WeakSet();
const cookieGuardTasks = new WeakMap();

function buildCookieGuardScript() {
  const policySnapshot = { cookiePolicy: CFG.cookiePolicy, allowlist: CFG.allowlist || {} };
  return `(() => {
    try {
      const POLICY = ${JSON.stringify(policySnapshot)};
      const norm = (h) => String(h || '').replace(/^\\.+/, '').replace(/^www\\./i, '').toLowerCase();
      const policyFor = (host) => {
        const h = norm(host);
        if (!h) return null;
        if (POLICY.allowlist[h]) return POLICY.allowlist[h];
        const keys = Object.keys(POLICY.allowlist)
          .map(norm)
          .filter(k => k && (h === k || h.endsWith('.' + k)))
          .sort((a, b) => b.length - a.length);
        return keys.length ? POLICY.allowlist[keys[0]] : null;
      };
      const rule = policyFor(location.hostname);
      const effective = rule || (POLICY.cookiePolicy === 'session' ? 'session' : 'allow');
      if (effective === 'allow') return; // sin override: comportamiento nativo intacto
      const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
      if (!desc || !desc.get || !desc.set) return;
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        enumerable: true,
        get() { return desc.get.call(document); },
        set(value) {
          if (effective === 'block') return; // no-op: la cookie nunca llega a escribirse
          const stripped = String(value)
            .replace(/;\\s*expires=[^;]*/gi, '')
            .replace(/;\\s*max-age=[^;]*/gi, '');
          desc.set.call(document, stripped);
        }
      });
    } catch (e) { /* fail-open: nunca romper la página por esto */ }
  })();`;
}

async function registerCookieGuardScript(wc) {
  if (!wc || wc.isDestroyed() || !wc.debugger.isAttached()) return;
  try {
    const prevId = cookieGuardIds.get(wc);
    if (prevId != null) {
      await wc.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: prevId }).catch(() => {});
    }
    const { identifier } = await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: buildCookieGuardScript()
    });
    cookieGuardIds.set(wc, identifier);
  } catch (e) { console.error('[cookie-guard] registro fallido', e.message); }
}

function installCookieGuardLifecycle(wc) {
  if (cookieGuardLifecycleInstalled.has(wc)) return;
  cookieGuardLifecycleInstalled.add(wc);
  wc.debugger.on('detach', () => {
    cookieGuardIds.delete(wc);
    cookieGuardOwned.delete(wc);
  });
  wc.once('destroyed', () => {
    try {
      if (cookieGuardOwned.has(wc) && wc.debugger.isAttached()) wc.debugger.detach();
    } catch {}
    cookieGuardIds.delete(wc);
    cookieGuardOwned.delete(wc);
  });
}

async function attachCookieGuard(wc) {
  if (!wc || wc.isDestroyed()) return;
  installCookieGuardLifecycle(wc);
  if (!wc.debugger.isAttached()) {
    try {
      wc.debugger.attach('1.3');
      cookieGuardOwned.add(wc);
    } catch (e) {
      console.error('[cookie-guard] attach fallido', e.message);
      return;
    }
  }
  wc.debugger.sendCommand('Page.enable').catch(() => {});
  await registerCookieGuardScript(wc);
}

async function detachCookieGuard(wc) {
  if (!wc || wc.isDestroyed()) return;
  const owned = cookieGuardOwned.has(wc);
  const identifier = cookieGuardIds.get(wc);
  if (wc.debugger.isAttached() && identifier != null) {
    try {
      await wc.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    } catch {}
  }
  cookieGuardIds.delete(wc);
  if (owned && wc.debugger.isAttached()) {
    try { wc.debugger.detach(); } catch {}
  }
  cookieGuardOwned.delete(wc);
}

function updateCookieGuard(wc) {
  if (!wc || wc.isDestroyed()) return Promise.resolve();
  const previous = cookieGuardTasks.get(wc);
  const run = async () => {
    if (wc.isDestroyed()) return;
    if (Permissions.isCookieGuardNeeded(CFG)) await attachCookieGuard(wc);
    else await detachCookieGuard(wc);
  };
  const task = previous ? previous.catch(() => {}).then(run) : run();
  cookieGuardTasks.set(wc, task);
  return task;
}

// Se llama cada vez que cambia CFG.cookiePolicy o el allowlist por dominio,
// para que las pestañas ya abiertas apliquen la política nueva desde su
// próxima navegación (no reescribe cookies ya seteadas en la página actual).
function refreshCookieGuards() {
  try {
    for (const wc of require('electron').webContents.getAllWebContents()) {
      if (!wc.isDestroyed() && wc.getType() === 'webview' && Sessions.esWebviewProtegido(wc)) {
        updateCookieGuard(wc).catch(e => console.error('[cookie-guard] refresh fallido', e.message));
      }
    }
  } catch (e) { console.error('[cookie-guard] refresh fallido', e.message); }
}

function applyCookiePolicy(policy) {
  if (policy === 'session') {
    try {
      const s = session.fromPartition('persist:mc');
      s.cookies.get({}).then(cookies => {
        for (const c of cookies) {
          const host = String(c.domain || '').replace(/^\.+/, '').toLowerCase();
          const allowPolicy = getAllowlistPolicyForHost(host);
          if (isAuthDomain(host) || allowPolicy === 'allow') continue;
          if (c.session === false) {
            s.cookies.remove(cookieRemovalUrl(c), c.name).catch(() => {});
          }
        }
      }).catch(() => {});
    } catch (e) { console.error('[CK]', e.message); }
  }
}


module.exports = {
  cookieRemovalUrl,
  updateCookieGuard,
  refreshCookieGuards,
  applyCookiePolicy,
};
