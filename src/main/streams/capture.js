'use strict';
/**
 * MC Browser -- src/main/streams/capture.js
 *
 * Captura HLS de streams: el flag `streamHlsCaptureEnabled`, las tablas de
 * referers (player y entry), los finders, y los canales `streams:hls-capture`,
 * `streams:hls-player-referer` y `streams:entry-referer`.
 *
 * -----------------------------------------------------------------------------
 * LO QUE ESTA Y LO QUE NO
 * -----------------------------------------------------------------------------
 * Aqui: el estado y los helpers de referer, el flag de captura y los tres
 * handlers IPC.
 *
 * NO: el scanner (`streams:scan` + STREAM_SCAN_SCRIPT). Eso lista streams de una
 * pagina, no los captura. Sigue en `main.js` porque su flujo depende de que el
 * renderer lo invoque y del adblocker del renderer, y no cierra nada que haga
 * falta.
 *
 * Y no esta aqui `net/headers.js`: ese es el que CONSUME el flag y los
 * finders. Se los recibe por parametros (`deps`), y main.js los pasa sacados de
 * este modulo.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- el flag solo cambia cuando el parametro es booleano
 * -----------------------------------------------------------------------------
 * ```js
 * if (typeof active === 'boolean') streamHlsCaptureEnabled = active;
 * return streamHlsCaptureEnabled;
 * ```
 *
 * Al llamarlo con nada, o con un primitivo, devuelve el estado actual. Asi el
 * renderer puede preguntar sin togglearlo. Si cambiara a `streamHlsCaptureEnabled = !!active`
 * dejaria de ser asi, y todos los consumidores lo verian flippeando a `false`
 * al preguntar.
 *
 * Se deja para eso el GETTER `isStreamHlsCaptureEnabled`, que es el que consume
 * `net/headers.js`: lee la variable del modulo en cada llamada, no una copia.
 *
 * Y por defecto esta apagado (`false`). Si arrancara encendido, toda pagina con
 * `.m3u8` recibiría el redirect de captura sin que el usuario lo pidiera.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- los referers de ENTRADA son de uso unico, los de PLAYER no
 * -----------------------------------------------------------------------------
 * | Map | TTL | Se consume |
 * | --- | --- | --- |
 * | `streamEntryReferers` | 30 s | al primer request que lo usa (`consumeStreamEntryReferer`) |
 * | `streamPlayerReferers` | 15 min | se queda, para la proxima petition del player |
 *
 * La diferencia importa: un referer de entrada es para destrabar UNA peticion
 * puntual y ya no vale, porque las cookies de ese Referer ya la crean. Si se
 * quedara compartida, una respuesta de una pagina podria "hacerse pasar" por el
 * referer con permiso, y leediria el token de captura.
 *
 * Y el cap de 100 entradas es para que un usuario que vea muchas paginas no
 * infle el mapa: al llegar a 100 se borra el mas viejo (el orden de
 * `Map` es de insercion, asi que la primera key es equivalente a la mas vieja
 * segun inserción, no segun TTL. No es perfecto, es "suficientemente bueno").
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 3 -- el token de entrada es siempre `mchls` + un slug largo
 * -----------------------------------------------------------------------------
 * ```js
 * if (!/^mchls[a-z0-9-]{8,100}$/i.test(token || '') || !senderUrl.includes(token)) return false;
 * ```
 *
 * Sin una de las dos, el request falla y no se guarda: o no es de ESTE renderer
 * (la URL no contiene el token), o no es un token nuestro (sin `mchls` + alfa-
 * numerico). La idea es que solo el pagina del player pueda poner referers en
 * esta tabla, porque despues redes los usa para el redirect de captura.
 *
 * El check `senderUrl.includes(token)` es lo unico que distingue al jugador. Un
 * atacante desde otra pestana podria intentar poner el de otro, pero no conoce
 * el token fresco, que lleva expirando cada 30 s.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 4 -- los referers de PLAYER se renuevan por token
 * -----------------------------------------------------------------------------
 * Un mismo token puede ser emitido por el renderer anfitrion (el que tenga el
 * boton) o por el renderer del player (el webview que carga el video). El
 * `webContentsId` se guarda con el que relamento lo puso ultimo, y se
 * valida contra el siguiente remitente que lo reutiliza: si ya hay entry
 * valido con OTRO webContentsId, se ignoran las peticiones del nuevo.
 *
 * Y solo uno de los dos puede ser anfitrion-: `isHostRenderer` asume que la
 * ventana principal es quien linkea al player. Si MC tuviera mas de un
 * anfitrion o un popup separado pretendiera ser anfitrion, el check da por
 * sentado que `getMainWin()` es quien mira, que es la ventana host.
 */

const { ipcMain } = require('electron');
const { getMainWin } = require('../runtime');

let streamHlsCaptureEnabled = false;
const streamPlayerReferers = new Map();
const streamEntryReferers = new Map();

function findHlsPlayerEntry(details) {
  const webContentsId = Number(details?.webContentsId) || 0;
  const documentUrls = [details?.documentUrl, details?.webContentsURL, details?.frame?.url, details?.frame?.top?.url].filter(Boolean);
  if (webContentsId) {
    try {
      const currentUrl = require('electron').webContents.fromId(webContentsId)?.getURL();
      if (currentUrl) documentUrls.push(currentUrl);
    } catch {}
  }
  for (const [token, entry] of streamPlayerReferers) {
    if (entry.expiresAt <= Date.now()) {
      streamPlayerReferers.delete(token);
      continue;
    }
    if (documentUrls.some(url => url.includes(token)) && (!entry.webContentsId || entry.webContentsId === webContentsId)) return entry;
  }
  return null;
}

function findStreamEntryReferer(details) {
  let requestUrl;
  try {
    requestUrl = new URL(details?.url || '');
    requestUrl.hash = '';
  } catch { return null; }
  const key = requestUrl.href;
  const entry = streamEntryReferers.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    streamEntryReferers.delete(key);
    return null;
  }
  const webContentsId = Number(details?.webContentsId) || 0;
  if (entry.webContentsId && entry.webContentsId !== webContentsId) return null;
  const documentUrls = [details?.documentUrl, details?.webContentsURL, details?.frame?.url, details?.frame?.top?.url].filter(Boolean);
  if (webContentsId) {
    try {
      const currentUrl = require('electron').webContents.fromId(webContentsId)?.getURL();
      if (currentUrl) documentUrls.push(currentUrl);
    } catch {}
  }
  return documentUrls.some(url => url.includes(entry.token)) ? { key, entry } : null;
}

// Lo consume net/headers.js: el lookup y el borrado son una sola operacion,
// porque un referer de entrada se gasta en el primer request que lo usa.
function consumeStreamEntryReferer(details) {
  const match = findStreamEntryReferer(details);
  if (!match) return null;
  streamEntryReferers.delete(match.key);
  return match.entry;
}

function isStreamHlsCaptureEnabled() { return streamHlsCaptureEnabled; }

function registerStreamCaptureIpc() {
  ipcMain.handle('streams:hls-capture', (_e, active) => {
    if (typeof active === 'boolean') streamHlsCaptureEnabled = active;
    return streamHlsCaptureEnabled;
  });
  ipcMain.handle('streams:hls-player-referer', (event, { token, referer } = {}) => {
    if (!/^[a-z0-9-]{8,100}$/i.test(token || '')) return false;
    const normalizedReferer = String(referer || '').trim();
    if (normalizedReferer && !/^https?:\/\//i.test(normalizedReferer)) return false;
    const existing = streamPlayerReferers.get(token);
    const senderUrl = (() => { try { return event.sender.getURL(); } catch { return ''; } })();
    const isHostRenderer = event.sender === getMainWin()?.webContents;
    const isPlayerRenderer = senderUrl.includes(token);
    if (!isHostRenderer && !isPlayerRenderer) return false;
    if (isPlayerRenderer && existing?.webContentsId && existing.webContentsId !== event.sender.id) return false;
    streamPlayerReferers.set(token, {
      referer: normalizedReferer,
      webContentsId: isPlayerRenderer ? event.sender.id : (existing?.webContentsId || null),
      expiresAt: Date.now() + 15 * 60 * 1000
    });
    while (streamPlayerReferers.size > 100) streamPlayerReferers.delete(streamPlayerReferers.keys().next().value);
    return true;
  });
  ipcMain.handle('streams:entry-referer', (event, { token, url, referer } = {}) => {
    const senderUrl = (() => { try { return event.sender.getURL(); } catch { return ''; } })();
    if (!/^mchls[a-z0-9-]{8,100}$/i.test(token || '') || !senderUrl.includes(token)) return false;
    const targetUrl = String(url || '').trim();
    const targetReferer = String(referer || '').trim();
    let requestUrl, refererUrl;
    try {
      requestUrl = new URL(targetUrl);
      refererUrl = new URL(targetReferer);
      if (!/^https?:$/i.test(requestUrl.protocol) || !/^https?:$/i.test(refererUrl.protocol)) return false;
    } catch { return false; }
    requestUrl.hash = '';
    streamEntryReferers.set(requestUrl.href, {
      referer: refererUrl.href,
      token,
      webContentsId: event.sender.id,
      expiresAt: Date.now() + 30000
    });
    while (streamEntryReferers.size > 100) streamEntryReferers.delete(streamEntryReferers.keys().next().value);
    return true;
  });
}

module.exports = {
  findHlsPlayerEntry,
  findStreamEntryReferer,
  consumeStreamEntryReferer,
  isStreamHlsCaptureEnabled,
  registerStreamCaptureIpc
};