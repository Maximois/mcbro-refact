'use strict';
/**
 * MC Browser -- src/main/sessions/webchat.js
 *
 * WebChat: webview de los chats de IA que elige el usuario.
 *
 * -----------------------------------------------------------------------------
 * TAXONOMIA: esta NO lleva reglas globales
 * -----------------------------------------------------------------------------
 * Y no es una omision, es la decision. Los proveedores de chat de IA son
 * precisamente los sitios que mas rompen con reglas globales: la sesion pierde
 * mensajes, deja de cargar adjuntos o se cuelga en el login. A diferencia de
 * Extra (que es "la principal con otro almacenamiento"), aqui la sesion es
 * deliberadamente permisiva.
 *
 * Por eso NO hay:
 *   - setupSessionPermissionHandlers  -> en su lugar, allow-all
 *   - adblocker / requestGuard        -> nada de reglas de request
 *   - registro de descargas           -> una descarga de un chat no va al panel
 *
 * Lo unico que conserva es el proxy, porque el usuario lo configuro para
 * TODA la app y saltarselo en un panel visible seria una sorpresa.
 *
 * Los dos handlers allow-all (request y check) son lo que hace que esto no sea
 * solo "sin reglas": sin setPermissionCheckHandler, una pagina seguiria
 *_O_PIDIENDO_ permisos aunque se le negara la peticion. Faltaria uno de los
 * dos y el allow-all seria parcial.
 */

const { session } = require('electron');
const Sessions = require('./partitions');
const Proxy = require('../net/proxy');

function setupWebchatSession() {
  const wchSess = session.fromPartition(Sessions.WEBCHAT_PARTITION);
  // WebChat es un webview de proveedores elegidos por el usuario: no hereda
  // las reglas granulares de permisos del navegador principal.
  wchSess.setPermissionRequestHandler((_webContents, _permission, callback) => callback(true));
  wchSess.setPermissionCheckHandler(() => true);
  Proxy.applyProxyFromCfg(wchSess, '[webchat]');
  return wchSess;
}

module.exports = { setupWebchatSession };