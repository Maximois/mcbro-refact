'use strict';
/**
 * MC Browser -- modulo document-editor / spell.js
 *
 * Puente del corrector ortografico. Chromium solo entrega la palabra mal
 * escrita y las sugerencias en el evento `context-menu` del webContents, y ese
 * evento ni se emite si la pagina cancela el `contextmenu`. Por eso el editor
 * NO lo cancela: avisa con `doc:ctx-open` que el clic derecho es suyo, el main
 * deja de mostrar el menu nativo y reenvia al editor `{ word, suggestions }`
 * para que los agregue a su propio menu.
 *
 * Todo lo puro vive aca para poder probarlo sin Electron.
 */

const WINDOW_MS = 600;
let markedAt = 0;

function mark(now) { markedAt = now == null ? Date.now() : now; }
function isRecent(now) { return (now == null ? Date.now() : now) - markedAt <= WINDOW_MS; }
function reset() { markedAt = 0; }

/** Lo que el editor necesita saber de los parametros de `context-menu`. */
function payloadFromParams(params) {
  const p = params || {};
  const word = String(p.misspelledWord || '').slice(0, 80);
  const suggestions = (Array.isArray(p.dictionarySuggestions) ? p.dictionarySuggestions : [])
    .map((s) => String(s || '')).filter(Boolean).slice(0, 6);
  return { word, suggestions };
}

/**
 * Decide si el menu nativo se suprime. Espera un instante si el aviso del
 * editor todavia no llego (los dos mensajes viajan por canales distintos).
 */
async function claimsEvent(wait) {
  if (isRecent()) return true;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  return isRecent();
}

module.exports = { mark, isRecent, reset, payloadFromParams, claimsEvent, WINDOW_MS };
