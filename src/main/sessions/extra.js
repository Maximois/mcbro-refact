'use strict';
/**
 * MC Browser -- src/main/sessions/extra.js
 *
 * Sesion aislada con almacenamiento propio (cookies, cache y storage separados
 * en su propia particion).
 *
 * -----------------------------------------------------------------------------
 * TAXONOMIA: esta SI lleva reglas globales
 * -----------------------------------------------------------------------------
 * A diferencia de WebChat y WhatsApp, aqui el usuario navega a CUALQUIER sitio.
 * Por eso esta sesion recibe las mismas reglas que la principal:
 *
 *   - permisos granulares (setupSessionPermissionHandlers)
 *   - proxy
 *   - adblock con TODAS sus callbacks: Stream Hunter, registro de bloqueos y
 *     registro de requests observados
 *   - requestGuard, el guardian de reglas del paso 14
 *
 * Lo UNICO que cambia respecto a la sesion principal es el almacenamiento. Por
 * eso no hay ningun flag ni ninguna condicion: si el guardian se degrada, esta
 * sesion se degrada con el, y ese era el objetivo.
 *
 * Lo que NO se reimplementa aqui (y por eso sigue siendo barato):
 *   - las cuatro llamadas a applyProxyFromCfg no comprueban CFG.proxyEnabled, y
 *     no hace falta: applyProxyFromCfg ya sale solo si no hay proxy.
 *   - el registro de descargas nativas es el mismo para las dos sesiones que
 *     capturan descargas (esta y la principal), asi que va en downloads/native.js
 *     y no se duplica.
 *
 * Nota sobre el orden: applyProxyFromCfg y setupSessionPermissionHandlers se
 * llaman ANTES que m.setup() del adblocker, igual que antes de moverse este
 * codigo. El orden importa: el proxy tiene que estar puesto antes de que el
 * adblocker registre sus handlers de webRequest sobre la misma sesion.
 */

const PermissionsHandlers = require('../permissions/handlers');
const Proxy = require('../net/proxy');
const RequestGuard = require('../net/request-guard');
const DownloadsNative = require('../downloads/native');
const NavDomains = require('../navigation/domains');
const MediaDetect = require('../stats/media-detect');
const StatsTracker = require('../stats/tracker');
// CFG y saveCfg si se destructuran, a proposito: loadCfg() corre DENTRO de
// config/index.js al requerirlo, asi que el objeto ya esta fusionado con
// cfg.json cuando este require termina. Ver main.js:12-17 y el punto 2.1 del
// plan. Los modulos de funcion si van con namespace, como en main.js.
const { CFG, saveCfg } = require('../config');

function setupExtraSession(sess) {
  PermissionsHandlers.setupSessionPermissionHandlers(sess);
  Proxy.applyProxyFromCfg(sess, '[session]');
  try {
    // TRES niveles, no dos: modules/ esta en la raiz del repo, y este archivo
    // vive en src/main/sessions/. Con dos niveles el require resolvia a
    // src/modules/adblocker/main, que no existe, y el catch de abajo se lo
    // comia en silencio: la sesion extra se quedaba SIN adblocker y el smoke
    // daba verde igual, porque el catch solo hace console.error.
    const Adblocker = require('../../../modules/adblocker/main');
    // Paridad completa con la sesion principal: Stream Hunter (checkMedia),
    // notificacion de bloqueos (recordBlockedRequest) y registro de requests
    // observados (recordObservedRequest).
    Adblocker.setup({
      cfg: CFG,
      saveCfg,
      emit: () => {},
      session: sess,
      allowedDomains: NavDomains.AUTH_DOMAINS,
      mediaCallback: MediaDetect.checkMedia,
      blockCallback: StatsTracker.recordBlockedRequest,
      requestCallback: StatsTracker.recordObservedRequest,
      requestGuard: RequestGuard.createRequestGuard()
    });
  } catch (e) {
    console.error('[ADBLOCK][session]', e.message);
  }
  // Descargas nativas: antes solo 'persist:mc' las capturaba; una descarga
  // hecha dentro de una sesion aislada no aparecia en el panel de descargas.
  DownloadsNative.registerNativeDownloadHandler(sess);
}

module.exports = { setupExtraSession };