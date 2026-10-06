'use strict';
/**
 * MC Browser -- src/main/sessions/whatsapp.js
 *
 * WhatsApp Web: sesion especial que se hace pasar por Chrome de escritorio.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- el setHdr borra antes de escribir
 * -----------------------------------------------------------------------------
 * Los headers de Chromium ya vienen puestos y con distinta capitalizacion
 * (sec-ch-ua vs Sec-CH-UA). Si setHdr solo asignara, el header antiguo se
 * quedaria y Electron mandaria los dos. Por eso el bucle de borrado por
 * lowercase es load-bearing, no cosmetico.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- por que UA_CHROME y no el de Chromium
 * -----------------------------------------------------------------------------
 * Los Client Hints de Chromium delatan un bot: siempre igual en todos los
 * clientes. Un Chrome de escritorio los manda distintos. El bloqueo de este
 * interceptor es el patron completo (Chrome 140, marca "Not=A?Brand"), no
 * solo una version.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 3 -- el filtro mira d.url, no la pagina
 * -----------------------------------------------------------------------------
 * Aqui, a diferencia de downloads/native.js, el host que se mira es el de la
 * URL REQUESTED. Solo se tocan los Client Hints de los hosts de WhatsApp
 * (web.whatsapp.com, *.whatsapp.com, *.whatsapp.net), no los de los CDN que
 * servirian una imagen desde esa pagina. Si se mirara el host de la pagina, se
 * pisarian cabeceras de terceros.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 4 -- este interceptor se queda aqui, no va a net/headers.js
 * -----------------------------------------------------------------------------
 * Los tres interceptores de net/headers.js son de la sesion principal. Este
 * cuelga de waSess y solo tiene sentido dentro de la sesion de WhatsApp. Por eso
 * viaja con su sesion, y no como una inyeccion temporal a net/headers.js.
 *
 * -----------------------------------------------------------------------------
 * TAXONOMIA: sin reglas globales de request
 * -----------------------------------------------------------------------------
 * WhatsApp usa permisos granulares (setupSessionPermissionHandlers) NO porque
 * quiera reglas de red, sino porque necesita la entrada 'notifications: allow'
 * de web.whatsapp.com, que se escribe justo arriba. El proxy si se aplica,
 * porque el usuario lo configuro para toda la app.
 */

const { session } = require('electron');
const Sessions = require('./partitions');
const PermissionsAdapters = require('../permissions/adapters');
const PermissionsEntries = require('../permissions/entries');
const PermissionsHandlers = require('../permissions/handlers');
const Proxy = require('../net/proxy');

function setupWhatsappSession() {
  const waSess = session.fromPartition(Sessions.WHATSAPP_PARTITION);
  if (!PermissionsAdapters.getPermissionRuleForHost('web.whatsapp.com', 'notifications')) {
    PermissionsEntries.setPermissionEntry('web.whatsapp.com', 'notifications', 'allow');
  }
  PermissionsHandlers.setupSessionPermissionHandlers(waSess);
  Proxy.applyProxyFromCfg(waSess, '[whatsapp]');
  waSess.webRequest.onBeforeSendHeaders({ urls: ['https://web.whatsapp.com/*', 'https://*.whatsapp.com/*', 'https://*.whatsapp.net/*'] }, (d, cb) => {
    if (!/^https?:\/\//i.test(d.url || '')) return cb({ requestHeaders: d.requestHeaders });
    const headers = { ...d.requestHeaders };
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
  return waSess;
}

module.exports = { setupWhatsappSession };