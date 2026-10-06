'use strict';
/**
 * MC Browser -- src/main/net/request-guard.js
 *
 * El guardian de cada peticion: decide si una request se cancela, se redirige,
 * se permite o se deja pasar, aplicando las reglas globales de la app.
 *
 * -----------------------------------------------------------------------------
 * QUE HACE
 * -----------------------------------------------------------------------------
 * createRequestGuard() devuelve un closure `(details) => decision`. No decide
 * nada por su cuenta: devuelve una de estas cuatro, o null (dejar pasar):
 *
 *   { cancel: true }        la peticion se bloquea
 *   { allow: true }         la peticion se permite y se salta el motor
 *   { redirectURL: '...' }  se cambia el destino (solo httpsOnly)
 *   null                    sin objecion
 *
 * El closure lee CFG en CADA invocacion, no al crearse. Por eso no hay que
 * re-registrarlo cuando el usuario cambia una regla.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- el orden de las reglas es la regla
 * -----------------------------------------------------------------------------
 * No es un `if / else if` de casos equivalentes: es una cascada donde cada
 * capa puede ganarle a la siguiente, y el orden ES el comportamiento.
 *
 *   1. Reglas por recurso (resourceRules)      allow -> allow, block -> cancel
 *   2. Allowlists de adblock                    -> allow
 *   3. Reglas site-scoped (con `rule.site`)     -> cancel, SIEMPRE
 *   4. Reglas globales (sin `rule.site`)        -> cancel, salvo dominios auth
 *   5. httpsOnly                                -> redirectURL
 *   6. site:allow del documento                 -> null
 *   7. Documento de Google                      -> allow (salvo hosts de anuncios)
 *   8. Dominio auth                             -> null
 *   9. Permisos de contenido (img/js/audio)     -> cancel
 *
 * Lo que dice ese orden, en una frase: **los bloqueos ganan, los permisos de
 * contenido no aplican en Google ni en la cadena OAuth.**
 *
 * Las capas 1 a 5 cortan antes de llegar a las 9. Eso es lo que quiere: una
 * regla de bloqueo del usuario tiene que ganarle a un permiso de contenido,
 * porque el bloqueo es la decision mas especifica. Las capas 7 y 8, en cambio,
 * cortan ANTES de la 9, y por eso las reglas de permisos de contenido de la
 * pagina no se evaluan en Google ni en un login. No es un descuido: en Google
 * los recursos de terceros se permiten todos y solo se bloquean los hosts de
 * anuncios conocidos; y la cadena OAuth (Google, x.ai, Grok) carga scripts
 * alternando entre dominios, asi que ahi los permisos de contenido cortarian
 * el login.
 *
 * Reordenar las capas 3 y 4 cambia el resultado en paginas de login: las
 * site-scoped aplican siempre, las globales no. Ese contraste es deliberado.ágina
 * dejarian de aplicarse.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- comparar URLs sin query string
 * -----------------------------------------------------------------------------
 * Muchos sitios (sobre todo los que sirven recursos desde varios subdominios o
 * CDN) regeneran sus scripts con un parámetro de cache-busting o token
 * distinto en cada carga. Comparar por URL EXACTA hacía que una regla
 * "Permitir" guardada una vez dejara de aplicar en la siguiente carga de la
 * MISMA pagina, y se ve como si el permiso no se diera o volviera a bloquearse.
 *
 * Por eso toda comparacion de resourceRules pasa por stripUrlQuery().
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 3 -- los domains auth solo se saltan en unas capas
 * -----------------------------------------------------------------------------
 * `isAuthDomain` protege la cadena OAuth (Google, x.ai, Grok), que carga scripts
 * y recursos alternando entre varios dominios. Si las reglas globales se
 * aplicaran ahi, el login se romperia.
 *
 * Pero el bypass es SOLO de las reglas globales (capa 4) y del final de la
 * cascada (capa 8, que corta antes de los permisos de contenido). Las
 * site-scoped de la capa 3 NO lo tienen, y a proposito: una regla que el
 * usuario puso para un sitio vale tambien en su pagina de login.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 4 -- todo el cuerpo va dentro de un try, y cae a null
 * -----------------------------------------------------------------------------
 * El `catch {}` final devuelve `null`, es decir, deja pasar. Es lo correcto:
 * un fallo al evaluar una regla no debe cortar la red de la app. Este closure
 * corre DENTRO de un handler de red de Chromium, donde un throw se traduce en
 * una peticion colgada.
 */

const { CFG } = require('../config');
const NavDomains = require('../navigation/domains');
const PermissionsAdapters = require('../permissions/adapters');
const {
  isAdblockHostAllowed,
  isAdblockSiteAllowed,
  isGoogleDocumentHost,
  isGoogleAdHost,
} = require('../../../modules/adblocker/main');

/**
 * La URL sin query string ni fragmento, para comparar reglas de forma estable.
 * @param {string} url
 * @returns {string}
 */
function stripUrlQuery(url) {
  return String(url || '').split(/[?#]/)[0];
}

/**
 * El documento padre de la request, con un caso especial para Google.
 *
 * En páginas Google, `details.documentUrl` a veces no es el documento real sino
 * el iframe que pidio el recurso, asi que se sube al frame superior cuando ese
 * es de Google. Sin esto, la página principal de Google se trata como un
 * iframe y sus reglas no aplican.
 *
 * @param {Electron.OnBeforeRequestListenerDetails} details
 * @returns {string}
 */
function requestDocumentUrl(details) {
  const fallback = details?.documentUrl || details?.referrer || '';
  try {
    const topUrl = details?.frame?.top?.url;
    if (topUrl && isGoogleDocumentHost(new URL(topUrl).hostname)) return topUrl;
  } catch {}
  return fallback;
}

/**
 * Crea el guardian de requests de una sesion.
 * @returns {(details: Electron.OnBeforeRequestListenerDetails) => ({cancel?: boolean, allow?: boolean, redirectURL?: string} | null)}
 */
function createRequestGuard() {
  return (details) => {
    try {
      const requestHost = PermissionsAdapters.normalizeSiteHost(details?.url || '');
      // Fallback a referrer cuando documentUrl viene vacío (primera navegación)
      const documentUrl = requestDocumentUrl(details);
      const documentHost = PermissionsAdapters.normalizeSiteHost(documentUrl);
      // Coincidencia sin query string: muchos sitios (sobre todo los que
      // sirven recursos desde varios subdominios/CDN) regeneran sus scripts
      // con un parámetro de cache-busting o token distinto en cada carga.
      // Comparar por URL exacta hacía que una regla "Permitir" guardada una
      // vez dejara de aplicar en la siguiente carga de la MISMA pagina -
      // se ve como si el permiso "no se diera" o "volviera a bloquearse".
      const requestUrlNoQuery = stripUrlQuery(details?.url);
      const resourceRule = (Array.isArray(CFG.resourceRules) ? CFG.resourceRules : [])
        .find(rule => rule && (rule.url === details?.url || stripUrlQuery(rule.url) === requestUrlNoQuery)
          && (!rule.resourceType || rule.resourceType === details?.resourceType));
      if (resourceRule?.action === 'allow') return { allow: true };
      if (resourceRule?.action === 'block') return { cancel: true };
      if (isAdblockHostAllowed(requestHost) || isAdblockSiteAllowed(requestHost) || isAdblockSiteAllowed(documentHost)) {
        return { allow: true };
      }
      // Reglas personalizadas:
      //  - site-scoped: SIEMPRE aplican en su sitio (incluso en dominios auth).
      //  - globales: NO aplican en dominios auth (proteger OAuth/login).
      // El bypass de auth solo protege los permisos de contenido (más abajo).
      const customRulesArr = Array.isArray(CFG.customRules) ? CFG.customRules : [];
      const globalBlocks = customRulesArr
        .filter(rule => !rule.site)
        .map(rule => PermissionsAdapters.parseGlobalBlockRule(rule && rule.pattern ? rule.pattern : rule))
        .filter(Boolean);
      const siteScopedBlocks = customRulesArr
        .filter(rule => rule.site)
        .map(rule => ({ ...PermissionsAdapters.parseGlobalBlockRule(rule && rule.pattern ? rule.pattern : rule), site: rule.site }))
        .filter(r => r && r.host);
      // Sitio/contenedor puede abrir un dominio de la lista de bloqueo manual,
      // pero no implica desactivar adblock ni permisos de contenido en terceros.
      const siteOverridesBlock = PermissionsAdapters.isSitePermissionAllowed(requestHost) || PermissionsAdapters.isSitePermissionAllowed(documentHost)
        || isAdblockHostAllowed(requestHost) || isAdblockSiteAllowed(documentHost);
      if (!siteOverridesBlock) {
        // Reglas site-scoped: SIEMPRE aplican en su sitio (incluso en dominios auth)
        if (documentHost && siteScopedBlocks.some(rule => {
          if (!rule.site) return false;
          const docBase = NavDomains.baseNavigationDomain(documentHost);
          const siteBase = NavDomains.baseNavigationDomain(rule.site);
          return docBase === siteBase && PermissionsAdapters.isGlobalBlockMatch(requestHost, documentHost, rule);
        })) {
          return { cancel: true };
        }
        // Reglas globales: NO aplican en dominios auth (proteger OAuth/login)
        if (!NavDomains.isAuthDomain(requestHost) && !NavDomains.isAuthDomain(documentHost)) {
          if (globalBlocks.some(rule => PermissionsAdapters.isGlobalBlockMatch(requestHost, documentHost, rule))) {
            return { cancel: true };
          }
        }
      }

      const resourceType = String(details?.resourceType || '').toLowerCase();
      const isMainFrame = resourceType === 'mainframe' || resourceType === 'main_frame';

      if (CFG.httpsOnly && isMainFrame && /^http:\/\//i.test(details.url || '')) {
        try {
          const parsed = new URL(details.url);
          const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
          if (!local) {
            parsed.protocol = 'https:';
            if (!parsed.port || parsed.port === '80') parsed.port = '';
            return { redirectURL: parsed.toString() };
          }
        } catch {}
      }

      // Permisos de contenido (images/js/audio) se evalúan sobre el documento activo.
      // site:allow en un CDN/request host ya no salta esas reglas en páginas ajenas.
      const host = PermissionsAdapters.normalizeSiteHost(details?.documentUrl || details?.url || '');
      if (!host) return null;
      if (PermissionsAdapters.isSitePermissionAllowed(host)) return null;

      // En páginas Google, permitir recursos ajenos salvo los hosts de anuncios
      // enumerados; el adblocker recibe esos hosts para aplicar el bloqueo.
      if (isGoogleDocumentHost(documentHost)) {
        if (isGoogleAdHost(requestHost)) return null;
        return { allow: true };
      }

      // La cadena OAuth puede cargar scripts y recursos entre X, x.ai, Google y Grok.
      // Las reglas de permisos de contenido no deben cortar esos recursos.
      if (NavDomains.isAuthDomain(requestHost) || NavDomains.isAuthDomain(documentHost)) return null;

      const imageRule = PermissionsAdapters.getPermissionRuleForHost(host, 'images');
      const audioRule = PermissionsAdapters.getPermissionRuleForHost(host, 'audio');
      const jsRule = PermissionsAdapters.getPermissionRuleForHost(host, 'javascript');
      if ((resourceType === 'image' || resourceType === 'img') && (imageRule === 'deny' || imageRule === 'block')) {
        return { cancel: true };
      }
      if ((resourceType === 'media' || resourceType === 'audio' || resourceType === 'track') && (audioRule === 'deny' || audioRule === 'block')) {
        return { cancel: true };
      }
      if (resourceType === 'script' && (jsRule === 'deny' || jsRule === 'block')) {
        return { cancel: true };
      }
    } catch {}
    return null;
  };
}

module.exports = {
  createRequestGuard,
  stripUrlQuery,
  requestDocumentUrl,
};