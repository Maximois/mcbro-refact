'use strict';
/**
 * MC Browser -- src/main/net/headers.js
 *
 * Los tres interceptores de red que cuelgan de una sesion:
 *
 *   1. webRequest.onBeforeSendHeaders  -> referers, Accept-Language, aislamiento
 *                                        de cookies y User-Agent de Perchance.
 *   2. webRequest.onHeadersReceived    -> Set-Cookie segun politica, y el
 *                                        Access-Control-Allow-Origin para HLS.
 *   3. cookies.on('changed')           -> borra las cookies de JS que el
 *                                        interceptor 2 no pudo ver, y notifica
 *                                        a la ventana.
 *
 * -----------------------------------------------------------------------------
 * POR QUE ESTO NO CUBRE EL document.cookie DEL SITIO
 * -----------------------------------------------------------------------------
 * onHeadersReceived solo ve las cookies que viajan en Set-Cookie. Las que un
 * sitio se pone desde su propio JS nunca generan respuesta de red, asi que se
 * escapan. El tercer interceptor es la red de seguridad: borra la cookie en
 * cuanto Chromium la confirma. El bloqueo completo (sin existir ni un instante)
 * lo hace cookie-guard.js, que entra al mundo principal por CDP.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- los helpers de streams llegan por parametro
 * -----------------------------------------------------------------------------
 * findHlsPlayerEntry, findStreamEntryReferer y el flag streamHlsCaptureEnabled
 * son de streams/capture.js, que es el paso 21 y todavia no existe. Por eso
 * installHeaderInterceptors() los recibe en deps en vez de importarlos.
 *
 * OJO con el segundo: main.js hacia findStreamEntryReferer(d) y despues
 * streamEntryReferers.delete(match.key). El delete es parte del CONSUMO (un
 * referer se gasta una sola vez), asi que van juntos en consumeStreamEntryReferer().
 * Si se separaran, un segundo request del mismo token reutilizaria el referer.
 *
 * Cuando llegue el paso 21, deps pasa a salir del modulo y desaparece este
 * parametro. Hasta entonces, main.js es el dueno de esos helpers.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- el orden de las reglas de referer no es libre
 * -----------------------------------------------------------------------------
 * En onBeforeSendHeaders el Referer se toca tres veces y el ultimo que gana:
 *   1. CFG.refererPolicy (no-referrer / origin)
 *   2. el referer del stream guardado por entrada (si no expiro)
 *   3. el referer del player HLS (si la peticion es media y no mainFrame)
 * El (3) esta indentado con 4 espacios de mas en el original. No es un error de
 * copiado, se respeta tal cual.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 3 -- las excepciones por dominio cortan antes de filtrar
 * -----------------------------------------------------------------------------
 * Perchance (por host) y los dominios de auth (isAuthDomain /
 * isAuthRedirectFlow) hacen return temprano con las cabeceras intactas. Por eso
 * la particion de Perchance no recibe Accept-Language ni el aislamiento de
 * cookies: es lo que permite que Cloudflare/Turnstile funcione.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 4 -- onHeadersReceived tiene dos salidas
 * -----------------------------------------------------------------------------
 * El try devuelve responseHeaders; si algo revienta, el catch cae en cb({}), que
 * es "dejar pasar la respuesta tal cual". Un fallo de parseo NO bloquea la red.
 */

const { CFG } = require('../config');
const { ACTIONS, getMainWin } = require('../runtime');
const { isAuthDomain, isAuthRedirectFlow, isPerchanceHost, PERCHANCE_UA } = require('../navigation/domains');
const { getAllowlistPolicyForHost } = require('../permissions/adapters');
const { addCookiesBlocked } = require('../stats/tracker');
const { resolveCookieAction } = require('../../../lib/permissions');
const { isTrustedResource, isVideoHost } = require('../../../modules/adblocker/main');
const { cookieRemovalUrl } = require('./cookie-guard');

/**
 * Engancha los tres interceptores a una sesion.
 *
 * @param {Electron.Session} sess  sesion ya resuelta (no se llama session.fromPartition aqui)
 * @param {object} deps
 * @param {() => boolean} deps.isStreamHlsCaptureEnabled  flag de captura HLS (streams, paso 21)
 * @param {(details) => object|null} deps.consumeStreamEntryReferer  referer guardado por entrada, gastado al usarlo
 * @param {(details) => object|null} deps.findHlsPlayerEntry  entrada de player HLS registrada
 */
function installHeaderInterceptors(sess, deps) {
  const { isStreamHlsCaptureEnabled, consumeStreamEntryReferer, findHlsPlayerEntry } = deps;
  if (typeof isStreamHlsCaptureEnabled !== 'function' ||
      typeof consumeStreamEntryReferer !== 'function' ||
      typeof findHlsPlayerEntry !== 'function') {
    throw new Error('installHeaderInterceptors: deps incompleto');
  }

  // ── Live request log & cookie interception ──
    sess.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (d, cb) => {
      if (!/^https?:\/\//i.test(d.url || '')) return cb({ requestHeaders: d.requestHeaders });
      const playerDocumentUrl = d.documentUrl || d.webContentsURL || d.frame?.url || d.frame?.top?.url || '';
      if (isStreamHlsCaptureEnabled() && /\.m3u8(?:[?#]|$)/i.test(d.url)) {
        const requestHeaders = d.requestHeaders || {};
        const refererKey = Object.keys(requestHeaders).find(key => key.toLowerCase() === 'referer');
        const refererValue = refererKey ? requestHeaders[refererKey] : '';
        const referer = Array.isArray(refererValue) ? String(refererValue[0] || '') : String(refererValue || d.referrer || '');
        ACTIONS.emit('streams:hls-captured', {
          url: d.url,
          referer: referer || d.referrer || '',
          pageUrl: d.documentUrl || d.webContentsURL || d.referrer || '',
          webContentsId: d.webContentsId || null,
          detectedAt: Date.now()
        });
      }
      const headers = { ...d.requestHeaders };
      const isMediaRequest = d.resourceType === 'media' || /\.(?:m3u8|mpd|ts|m4s|mp4|aac|mp3|webm)(?:[?#]|$)|(?:segment|chunk|playlist|\/stream(?:\/|$))/i.test(d.url);
      const isMainFrame = d.resourceType === 'mainFrame' || d.resourceType === 'main_frame';
      const targetHost = new URL(d.url).hostname;
      const docHost = d.documentUrl ? new URL(d.documentUrl).hostname : '';
      if (isPerchanceHost(targetHost) || isPerchanceHost(docHost)) {
        headers['User-Agent'] = PERCHANCE_UA;
      }
      const isAuthDocument = !!docHost && isAuthDomain(docHost);
      if (isAuthDomain(targetHost) || isAuthDocument || isAuthRedirectFlow(targetHost, docHost)) {
        return cb({ requestHeaders: headers });
      }
      if (CFG.strictDomainIsolation && !isMainFrame && d.documentUrl && !isMediaRequest && !isTrustedResource(d.url, d.documentUrl)) {
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'cookie') delete headers[key];
        }
      }
      if (CFG.language) headers['Accept-Language'] = `${CFG.language},en;q=0.8`;
      if (CFG.refererPolicy === 'no-referrer' && !isMediaRequest) {
        delete headers.Referer;
        delete headers.referer;
      } else if (CFG.refererPolicy === 'origin' && headers.Referer) {
        try { headers.Referer = new URL(headers.Referer).origin + '/'; } catch {}
      }
      const entryReferer = consumeStreamEntryReferer(d);
      if (entryReferer && entryReferer.expiresAt > Date.now()) {
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'referer') delete headers[key];
        }
        headers.Referer = entryReferer.referer;
      }
      const hlsPlayerEntry = isMediaRequest && !isMainFrame ? findHlsPlayerEntry(d) : null;
      if (hlsPlayerEntry?.referer) {
          for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === 'referer') delete headers[key];
          }
          headers.Referer = hlsPlayerEntry.referer;
      }
      // WhatsApp (regla especial): alinear Client Hints con UA_WHATSAPP de navigation/domains.js (Chrome 140)
      // para evitar el error de "navegador no compatible"
      try {
        const host = new URL(d.url).hostname.toLowerCase();
        if (host === 'web.whatsapp.com' || host.endsWith('.whatsapp.com') || host.endsWith('.whatsapp.net')) {
          const setHdr = (name, value) => {
            for (const k of Object.keys(headers)) {
              if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
            }
            headers[name] = value;
          };
          setHdr('sec-ch-ua', '"Chromium";v="140", "Google Chrome";v="140", "Not=A?Brand";v="99"');
          setHdr('sec-ch-ua-full-version', '"140.0.0.0"');
          setHdr('sec-ch-ua-platform', '"Windows"');
          setHdr('sec-ch-ua-mobile', '?0');
        }
      } catch {}
      cb({ requestHeaders: headers });
    });
    sess.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (d, cb) => {
      if (!/^https?:\/\//i.test(d.url || '')) return cb({ responseHeaders: d.responseHeaders });
      try {
        const responseHeaders = { ...d.responseHeaders };
        const host = new URL(d.url).hostname.toLowerCase();
        const docHost = d.documentUrl ? new URL(d.documentUrl).hostname.toLowerCase() : '';
        const isMediaRequest = d.resourceType === 'media' || /\.(?:m3u8|mpd|ts|m4s|mp4|aac|mp3|webm)(?:[?#]|$)|(?:segment|chunk|playlist|\/stream(?:\/|$))/i.test(d.url);
        const hlsPlayerEntry = isMediaRequest ? findHlsPlayerEntry(d) : null;
        if (hlsPlayerEntry) {
          for (const key of Object.keys(responseHeaders)) {
            if (key.toLowerCase() === 'access-control-allow-origin') delete responseHeaders[key];
          }
          responseHeaders['Access-Control-Allow-Origin'] = ['*'];
        }
        const isSubFrame = d.resourceType === 'subFrame' || d.resourceType === 'subframe' || d.resourceType === 'object';
        if (isSubFrame && isVideoHost(host)) {
          for (const key of Object.keys(responseHeaders)) {
            if (/^x-frame-options$/i.test(key)) delete responseHeaders[key];
          }
          for (const key of Object.keys(responseHeaders)) {
            if (!/^content-security-policy$/i.test(key)) continue;
            const values = (Array.isArray(responseHeaders[key]) ? responseHeaders[key] : [responseHeaders[key]])
              .map(v => String(v).replace(/;\s*frame-ancestors[^;]*/gi, '').trim());
            responseHeaders[key] = values;
          }
        }
        // La partición dedicada de Perchance ya se prepara sin restricciones;
        // no se debe reintroducir una exception global por dominio aquí.
        if (isAuthDomain(host) || isAuthDomain(docHost) || isAuthRedirectFlow(host, docHost)) {
          return cb({ responseHeaders });
        }
        const cookieKey = responseHeaders['set-cookie'] ? 'set-cookie' : 'Set-Cookie';
        if (d.responseHeaders) {
          const setCookie = d.responseHeaders['set-cookie'] || d.responseHeaders['Set-Cookie'];
          if (setCookie) {
            const domain = host;
            const thirdParty = CFG.strictDomainIsolation && d.documentUrl && !isTrustedResource(d.url, d.documentUrl) && !isMediaRequest;
            const cookieAction = resolveCookieAction({ host: domain, thirdParty, cfg: CFG });
            const blocked = cookieAction === 'block';
            if (blocked && getMainWin() && !getMainWin().isDestroyed()) {
              for (const c of Array.isArray(setCookie) ? setCookie : [setCookie]) {
                getMainWin().webContents.send('cookie-intercepted', { action: 'blocked', domain, cookie: c });
              }
              addCookiesBlocked(Array.isArray(setCookie) ? setCookie.length : 1);
            }
            if (blocked) {
              // 'block' explicito (o 3ra parte con aislamiento) → el header
              // Set-Cookie no debe llegar nunca al navegador.
              delete responseHeaders[cookieKey];
            } else if (cookieAction === 'session') {
              const sessionCookies = (value) => String(value)
                .replace(/;\s*expires=[^;]*/gi, '')
                .replace(/;\s*max-age=[^;]*/gi, '');
              responseHeaders[cookieKey] = Array.isArray(setCookie)
                ? setCookie.map(sessionCookies)
                : sessionCookies(setCookie);
            }
          }
        }
        return cb({ responseHeaders });
      } catch (e) { /* ignore header parse errors */ }
      cb({});
    });
    sess.cookies.on('changed', (event, cookie, removed, cause) => {
      // Mitigacion parcial: onHeadersReceived solo ve cookies puestas via el
      // header HTTP Set-Cookie. Las que un sitio setea por JS (document.cookie)
      // no pasan por ahi y saltean la politica de bloqueo/sesion. No podemos
      // impedir que existan por un instante, pero sí borrarlas apenas Chromium
      // las confirma, para que la política de bloqueo se sostenga igual.
      if (!removed && cause === 'explicit') {
        const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
        const policy = getAllowlistPolicyForHost(domain);
        if (policy === 'block' && !isAuthDomain(domain)) {
          sess.cookies.remove(cookieRemovalUrl(cookie, domain), cookie.name).catch(() => {});
        }
      }
      if (!getMainWin() || getMainWin().isDestroyed()) return;
      const action = removed ? 'removed' : 'allowed';
      const summary = `${cookie.name || 'cookie'}=${cookie.value || ''}`.substring(0, 160);
      getMainWin().webContents.send('cookie-intercepted', {
        action,
        domain: cookie.domain || '',
        cookie: summary + (removed ? ` (${cause || 'removed'})` : '')
      });
    });
}


module.exports = {
  installHeaderInterceptors,
};
