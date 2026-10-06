'use strict';
/**
 * MC Browser -- src/main/net/proxy.js
 *
 * La configuracion de proxy y su aplicacion a las sesiones.
 *
 * -----------------------------------------------------------------------------
 * QUE HACE
 * -----------------------------------------------------------------------------
 *   - proxyRulesFromCfg()   arma la regla desde CFG, o null si no hay proxy.
 *   - applyProxyFromCfg()   aplica esa regla a una sesion, sin esperar.
 *   - setProxy()            el cuerpo del IPC proxy:set: valida, aplica a las
 *                           tres particiones y persiste en CFG.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- el proxy se repetia cuatro veces, identico
 * -----------------------------------------------------------------------------
 * Las sesiones principal, WebChat, WhatsApp y cada sesion aislada llamaban a
 * setProxy() con la MISMA expresion, cambiando solo la sesion y la etiqueta del
 * log. Eso es una funcion con dos parametros escrita cuatro veces, y cambiar una
 * de las cuatro se lleva por delante a las otras tres en silencio. Ahora hay una
 * sola.
 *
 * Ojo: applyProxyFromCfg() NO espera a setProxy(). Es fire-and-forget con
 * .catch(), igual que estaba. El unico sitio que espera es setProxy(), el IPC.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- el IPC SI espera, y solo para la sesion principal
 * -----------------------------------------------------------------------------
 * En setProxy() la sesion principal se espera sin .catch(); WebChat y WhatsApp
 * llevan .catch(() => {}). Es deliberado: si el proxy principal falla, el
 * handler devuelve el error al renderer; si falla el de un panel, se ignora.
 * No es un descuido, no unificarlo.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 3 -- al apagar, no se manda proxyRules:''
 * -----------------------------------------------------------------------------
 * Se manda { mode: 'direct' }. Una cadena vacia no es lo mismo que "sin proxy"
 * para Chromium: puede quedarse esperando una conexion que no va a llegar.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 4 -- los nombres de particion salen de sessions/partitions.js
 * -----------------------------------------------------------------------------
 * Cuando se extrajo este modulo, WEBCHAT_PARTITION y WHATSAPP_PARTITION se
 * recibian por parametro porque sessions/partitions.js (paso 13) no existia.
 * Ya existe: se importan y la firma se simplifica.
 *
 * Es el mismo esquema que el cookie guard. El wiring por parametro era
 * temporal a proposito, no un patron a seguir: si al añadir una particion
 * nueva hay que tocar tres modulos, algo se esta haciendo mal.
 */

const { session } = require('electron');
const { CFG, saveCfg } = require('../config');
const { WEBCHAT_PARTITION, WHATSAPP_PARTITION } = require('../sessions/partitions');

const TIPOS_VALIDOS = /^(http|https|socks5)$/;

/**
 * Regla de proxy segun CFG, o null si el proxy esta apagado.
 * @returns {{ proxyRules: string } | null}
 */
function proxyRulesFromCfg() {
  if (!CFG.proxyEnabled || !CFG.proxyHost) return null;
  const type = CFG.proxyType || 'socks5';
  const host = CFG.proxyHost;
  const port = CFG.proxyPort || 1080;
  return { proxyRules: `${type}://${host}:${port}` };
}

/**
 * Aplica el proxy de CFG a una sesion. No espera: igual que antes de extraerse.
 * @param {Electron.Session} sess
 * @param {string} tag etiqueta para el log, p. ej. '[session]' o '[webchat]'
 */
function applyProxyFromCfg(sess, tag) {
  const regla = proxyRulesFromCfg();
  if (!regla) return;
  sess.setProxy(regla).catch(e => console.error(`[PROXY]${tag}`, e.message));
}

/**
 * Cuerpo del IPC proxy:set. Valida, aplica a las tres particiones y persiste.
 *
 * @param {object} settings lo que llega del renderer
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function setProxy(settings = {}) {
  const proxyEnabled = settings.enabled === true;
  const proxyType = String(settings.type || CFG.proxyType || 'socks5').toLowerCase();
  const proxyHost = String(settings.host || '').trim();
  const proxyPort = Number(settings.port || 1080);
  if (proxyEnabled && (!TIPOS_VALIDOS.test(proxyType) || !proxyHost || !Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)) {
    return { ok: false, error: 'Configuración de proxy inválida' };
  }
  try {
    const proxyRules = proxyEnabled ? `${proxyType}://${proxyHost}:${proxyPort}` : '';
    const destino = proxyEnabled ? { proxyRules } : { mode: 'direct' };
    await session.fromPartition('persist:mc').setProxy(destino);
    await session.fromPartition(WEBCHAT_PARTITION).setProxy(destino).catch(() => {});
    await session.fromPartition(WHATSAPP_PARTITION).setProxy(destino).catch(() => {});
    Object.assign(CFG, { proxyEnabled, proxyType, proxyHost, proxyPort });
    saveCfg();
    return { ok: true, enabled: proxyEnabled, type: proxyType, host: proxyHost, port: proxyPort };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = {
  proxyRulesFromCfg,
  applyProxyFromCfg,
  setProxy,
};