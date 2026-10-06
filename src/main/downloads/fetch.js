'use strict';
/**
 * MC Browser -- src/main/downloads/fetch.js
 *
 * El transporte de las descargas: como se pide un bytes al servidor con las
 * cookies de la sesion principal.
 *
 * -----------------------------------------------------------------------------
 * POR QUE NO BASTA CON `fetch`
 * -----------------------------------------------------------------------------
 * Una descarga se pide desde el proceso main, pero las cookies estan en la
 * sesion de Electron (`persist:mc`), no en Node. Un `fetch` de Node no las ve:
 * la descarga de un archivo que exige iniciar sesion daria 401 o 403.
 *
 * Por eso se prefiere `session.fetch()`, que es el de Chromium: usa el
 * `cookieStore` real, con todas las cookies, sin construir cabeceras a mano.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- `sessionFetch` se resuelve UNA vez, al cargar el modulo
 * -----------------------------------------------------------------------------
 * ```js
 * const sessionFetch = getSessionFetch();   // <- al requerir, no por peticion
 * ```
 *
 * Si Electron no tiene `session.fetch` (anterior a 28) devuelve `null` y TODAS
 * las descargas de la sesion usan el fallback de Node con las cookies montadas a
 * mano. No es un problema en la practica: el proceso main vive mas que la
 * version de Electron, asi que "comprobarlo por peticion" y "comprobarlo al
 * arrancar" dan el mismo resultado.
 *
 * Se documenta porque es lo unico del modulo que depende del ENTORNO y no del
 * codigo, y porque por eso no hay forma de testearlo sin arrancarlo de verdad:
 * los tests de este repo lo comprueban leyendo el fuente.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- `Referer` se rellena solo si no viene
 * -----------------------------------------------------------------------------
 * Muchos servidores de media rechazan la peticion sin `Referer`. Si la pagina
 * que lanzo la descarga no lo pasa, se deduce de la propia URL:
 *
 * ```js
 * if (!headers['Referer']) try { headers['Referer'] = new URL(url).origin + '/'; }
 * ```
 *
 * Solo si no viene. Si la pagina lo pasa, ese gana: es el referer real, y el de
 * la URL seria una mentira que algunos CDNs comprueban.
 *
 * El `try` sin `catch` es a proposito: si la URL no es parseable se deja sin
 * Referer y ya esta. Fallar aqui seria impedir descargar algo que talvez si
 * funciona.
 *
 * -----------------------------------------------------------------------------
 * LO QUE NO ESTA
 * -----------------------------------------------------------------------------
 * `downloadSegment()` con su reintento y su backoff, y `resolveUrl()`, son de
 * HLS y se van al paso 16 con el resto. Aqui solo el transporte, que es lo que
 * comparten el HLS, el archivo directo y yt-dlp.
 */

const { session } = require('electron');

// Available desde Electron 28+. Si no existe, se devuelve null y el llamante
// usa el fallback. Ver TRAMPA 1.
function getSessionFetch() {
  try {
    const ses = session.fromPartition('persist:mc');
    if (typeof ses.fetch === 'function') return (url, opts) => ses.fetch(url, opts);
  } catch {}
  return null;
}

const sessionFetch = getSessionFetch();

// Cabeceras minimas para que un servidor de media acepte la peticion.
// El Referer es lo importante; ver TRAMPA 2.
function mediaRequestHeaders(pageUrl, fallbackUrl) {
  const headers = {};
  if (pageUrl) headers.Referer = pageUrl;
  try { headers.Origin = new URL(pageUrl || fallbackUrl).origin; } catch {}
  return headers;
}

// El UA del fallback. Solo se usa si no hay `session.fetch`: con Chromium
// nativo el UA lo pone el navegador y no hace falta mentirlo.
const UA_FALLBACK = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function chromiumFetch(url, extraHeaders = {}, signal) {
  // Camino bueno: el fetch de Chromium, con todas las cookies de la sesion.
  if (sessionFetch) {
    const headers = { ...extraHeaders };
    if (!headers['Referer']) try { headers['Referer'] = new URL(url).origin + '/'; } catch {}
    return sessionFetch(url, { headers, method: 'GET', credentials: 'include', signal });
  }

  // Fallback: fetch de Node, montando las cookies a mano. Hay dos ramas y no es
  // un descuido: si `cookies.get` falla (URL invalida, sesion destruida) se
  // reintenta sin cookies en vez de rendirse. Un archivo publico se descarga
  // igual; solo se pierde la sesion.
  try {
    const cookies = await session.fromPartition('persist:mc').cookies.get({ url });
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const headers = { 'User-Agent': UA_FALLBACK, ...extraHeaders };
    if (!headers['Referer']) try { headers['Referer'] = new URL(url).origin + '/'; } catch {}
    if (cookieStr) headers['Cookie'] = cookieStr;
    return fetch(url, { headers, signal });
  } catch {
    const headers = { 'User-Agent': UA_FALLBACK, ...extraHeaders };
    return fetch(url, { headers, signal });
  }
}

module.exports = { chromiumFetch, mediaRequestHeaders, getSessionFetch };