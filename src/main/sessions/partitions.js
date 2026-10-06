'use strict';
/**
 * MC Browser -- src/main/sessions/partitions.js
 *
 * Quién es quién: los nombres de partición y los predicados que responden
 * "¿este webContents es de la sesión principal?", "¿es el panel WebChat?",
 * "¿es una sesión aislada?".
 *
 * Es la pieza que desbloquea el paso 13 y que, al existir, permite borrar dos de
 * las tres inyecciones que hubo que hacer en los pasos anteriores (ver
 * "TRAMPA 3").
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- 'persist:mc' sigue escrito a mano en varios sitios
 * -----------------------------------------------------------------------------
 * La partición principal aparece literal en `main.js` (creación de ventana,
 * descargas, cookies, permisos) y también dentro de este módulo. Se podría
 * exportar como MAIN_PARTITION, pero **no se hizo**: son más de diez
 * referencias y tocarlas todas en el mismo commit que mueve el módulo mezcla
 * dos cosas. Si algún día se unifica, que sea su propio commit, con su test de
 * paridad de strings.
 *
 * Lo que este módulo sí garantiza es que las comparaciones de sesión usan
 * SIEMPRE la misma función, no una expresión distinta por sitio.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- los predicados devuelven false, nunca lanzan
 * -----------------------------------------------------------------------------
 * `session.fromPartition()` puede lanzar si se llama con una partición inválida
 * o durante el apagado, y todos estos predicados corren dentro de handlers de
 * permisos, de `webRequest` y de `app.on('web-contents-created')`, donde un
 * throw se come el evento entero. Por eso cada uno va envuelto en try/catch y
 * cae a `false`.
 *
 * `false` es la respuesta conservadora en los dos casos:
 *   - isMainBrowsingSession: no es la principal, no se le da trato especial.
 *   - esWebviewProtegido: no se le instala el cookie guard. Un throw aquí sería
 *     además el peor de los dos fallos, porque rompería la política de cookies
 *     sin avisar.
 *
 * -----------------------------------------------------------------------------
 * Ahora que este módulo existe, los dos pueden importar directamente y sus
 * firmas se simplifican. Ese era el objetivo de este archivo desde el principio:
 * que el wiring de los pasos anteriores sea temporal.
 *
 * Ojo con el orden de requires: partitions.js no importa net/cookie-guard.js
 * ni net/proxy.js, pero esos dos sí importan este. Si alguna vez partitions.js
 * necesita algo de ellos, el require se hace perezoso dentro de la función, o
 * se rompe el ciclo.
 */

const { session } = require('electron');
const { CFG } = require('../config');

// Partición separada para el panel WebChat (Copilot/ChatGPT/Claude/Gemini/
// Perplexity): dominios fijos y conocidos, sin publicidad ni tracking real,
// así que no necesitan las reglas estrictas de cookies/bloqueo pensadas para
// pestañas de navegación libre — pero sí conviene que hereden proxy/permisos.
const WEBCHAT_PARTITION = 'persist:mc-webchat';
const WHATSAPP_PARTITION = 'persist:mc-whatsapp';

/**
 * Partición de una sesión aislada, por id de la config.
 * @param {string|number} id
 * @returns {string}
 */
function extraSessionPartition(id) {
  return 'persist:mc-session-' + id;
}

/**
 * ¿Este webContents es de la sesión principal de navegación?
 * @param {Electron.WebContents} wc
 */
function isMainBrowsingSession(wc) {
  try { return wc?.session === session.fromPartition('persist:mc'); } catch { return false; }
}

/**
 * ¿Este webContents es el panel WebChat?
 * @param {Electron.WebContents} wc
 */
function isWebchatSession(wc) {
  try { return wc?.session === session.fromPartition(WEBCHAT_PARTITION); } catch { return false; }
}

/**
 * ¿Este webContents es alguna de las sesiones aisladas de la config?
 * Recorre CFG.extraSessions; devuelve false si la lista no existe.
 * @param {Electron.WebContents} wc
 */
function isExtraSessionWebContents(wc) {
  try {
    return (CFG.extraSessions || []).some(s => wc?.session === session.fromPartition(extraSessionPartition(s.id)));
  } catch { return false; }
}

/**
 * Qué webviews llevan cookie guard: la sesión principal y las aisladas.
 *
 * El panel WebChat queda fuera a propósito. Sus 5 dominios son conocidos y no
 * usan cookies de sesión para autenticarse, así que no ganan nada con la
 * política estricta y sí pierden si se les aplica.
 *
 * @param {Electron.WebContents} wc
 */
function esWebviewProtegido(wc) {
  return isMainBrowsingSession(wc) || isExtraSessionWebContents(wc);
}

module.exports = {
  WEBCHAT_PARTITION,
  WHATSAPP_PARTITION,
  extraSessionPartition,
  isMainBrowsingSession,
  isWebchatSession,
  isExtraSessionWebContents,
  esWebviewProtegido,
};