'use strict';
/**
 * MC Browser -- src/main/navigation/transitions.js
 *
 * Reglas de transicion de navegacion: decide si se permite que una pagina
 * (webContents) salte a otra URL durante una redireccion.
 *
 * QUE HACE
 *   allowNavigationTransition(sourceUrl, targetUrl) — el veredicto.
 *   Y sus tres predicados: isExplicitNavigationSite, isExplicitMediaRedirectHost,
 *   isSameNavigationSite.
 *
 * QUE NO DEBE HACER
 *   - No mira si hay anuncio. Eso lo decide el adblocker antes de llamar aqui
 *     (isAggressiveAdNavigation / isExplicitlyBlocked), y en ese orden.
 *   - No lleva cuenta de si la navegacion la empezo el usuario. Eso es
 *     explicit-nav.js, que se consulta en otro punto del listener.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- el catch devuelve TRUE (permite)
 * -----------------------------------------------------------------------------
 * allowNavigationTransition envuelve todo en try/catch y ante cualquier error
 * devuelve \`true\`. Es decir: si la URL no se puede parsear, se PERMITE el salto.
 * Es deliberado: un fallo de parseo no debe convertirse en una pagina rota ni en
 * un bucle de navegacion bloqueada. No "endurecer" esto a false sin revisar los
 * 4 call sites.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- la lista de hosts de medios se declara DENTRO de la funcion
 * -----------------------------------------------------------------------------
 * isExplicitMediaRedirectHost construye el array explicitMediaHosts en cada
 * llamada, en vez de tenerla a nivel de modulo. Son 24 entradas y el predicado se
 * llama en cada will-redirect. Se movió tal cual para no cambiar el rendimiento
 * observable en una ruta que se ejecuta mucho; si se sube a nivel de modulo,
 * que sea en un commit con su propia justificacion.
 */

const { isVideoHost } = require('../../../modules/adblocker/main');
const { isSameNavigationSite: isSameNavigationSiteShared } = require('../../../lib/navigation-guard');
const { isAuthDomain } = require('./domains');
const { getPermissionRuleForHost } = require('../permissions/adapters');

function isSameNavigationSite(sourceUrl, targetUrl) {
  return isSameNavigationSiteShared(sourceUrl, targetUrl);
}

function isExplicitNavigationSite(host) {
  return isAuthDomain(host) || getPermissionRuleForHost(host, 'site') === 'allow';
}

function isExplicitMediaRedirectHost(host) {
  const normalized = String(host || '').toLowerCase().replace(/^\.+/, '').replace(/\.$/, '');
  if (!normalized) return false;
  const explicitMediaHosts = [
    'savefiles.com', 'playmogo.com', 'playmogo.net', 'mixdrop.co', 'mixdrop.to', 'miixdrop.top',
    'dood.wf', 'dood.la', 'dood.to', 'doodstream.com', 'voe.sx', 'voe.com',
    'mxdrop.com', 'mxdrop.to', 'lulu.to', 'mp4upload.com', 'streamwish.com', 'streamwish.to',
    'filemoon.to', 'filemoon.sx', 'filemoon.in', 'pixeldrain.com', 'mega.nz'
  ];
  return explicitMediaHosts.some(domain => normalized === domain || normalized.endsWith('.' + domain));
}

function allowNavigationTransition(sourceUrl, targetUrl) {
  try {
    const targetHost = new URL(targetUrl).hostname;
    if (isExplicitMediaRedirectHost(targetHost) || isVideoHost(targetHost)) return true;
    return isSameNavigationSite(sourceUrl, targetUrl) || isExplicitNavigationSite(targetHost);
  } catch {
    return true;
  }
}

module.exports = {
  isSameNavigationSite,
  isExplicitNavigationSite,
  isExplicitMediaRedirectHost,
  allowNavigationTransition,
};