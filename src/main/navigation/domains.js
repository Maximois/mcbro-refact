'use strict';
/**
 * MC Browser -- src/main/navigation/domains.js
 *
 * Catalogo de dominios que nunca se deben interferir, predicados de dominio y
 * las constantes de User-Agent. Solo datos y funciones puras: sin estado, sin
 * Electron, sin CFG.
 *
 * QUE HACE
 *   - AUTH_DOMAINS + isAuthDomain: la lista de exenciones y su predicado.
 *   - isAuthRedirectFlow / isAuthPopupUrl: predicados derivados de la anterior.
 *   - baseNavigationDomain: reduce un host a su dominio base (sufijos compuestos).
 *   - UA_WHATSAPP / PERCHANCE_UA / PCH_CHROME_MAJOR: identidades de navegador.
 *
 * QUE NO DEBE HACER
 *   - No decide permisos. La excepcion "este sitio tiene permiso site:allow" la
 *     consulta permissions/adapters.js, desde transitions.js.
 *   - No lleva cuenta de nada. Si necesitas estado de navegacion por webContents,
 *     es explicit-nav.js.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- AUTH_DOMAINS es mas grande de lo que parece
 * -----------------------------------------------------------------------------
 * No es solo "hosts de autenticacion". Incluye sitios de contenido completos
 * (youtube.com, github.com, x.com, google.com, chatgpt.com) porque necesitan
 * excepciones en permisos/navegacion. Reducirla a solo hosts de auth para que el
 * adblock aplique en YouTube/GitHub/X se evaluo y se RECHAZO: rompe la
 * navegacion. Si hay que agregar un host, tiene que ser para conectarlo con una
 * excepcion concreta, no "porque parece de confianza".
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- la lista se pasa como allowedDomains al adblocker
 * -----------------------------------------------------------------------------
 * main.js hace `m.setup({ allowedDomains: AUTH_DOMAINS })`, y ahi el adblocker
 * hace `return callback({ cancel: false })` ANTES de evaluar sus propias reglas
 * de contenido. O sea: un host de esta lista tiene el adblock COMPLETAMENTE
 * desactivado, no solo la parte de autenticacion. El adblock normal mantiene su
 * lista separada; esta no la reemplaza.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 3 -- isAuthDomain NO usa endsWith sin punto
 * -----------------------------------------------------------------------------
 * `normalized.endsWith(domain)` sin el punto delante daria true para
 * 'evil-google.com' contra 'google.com'. Por eso el predicado compara exacto o
 * `endsWith('.' + domain)`. No simplificar eso. El comentario del codigo lo
 * explica mejor.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 4 -- MULTI_LABEL_PUBLIC_SUFFIXES no es una Public Suffix List
 * -----------------------------------------------------------------------------
 * Son 12 sufijos compuestos escritos a mano, no una lista pPSL completa. Si
 * algun dia hace falta mas cobertura, el sitio correcto es la Public Suffix List,
 * no ampliar ese Set a mano.
 */



// === AUTH DOMAINS (nunca bloquear estos) ===
//
// LEE ANTES DE "LIMPIAR" ESTA LISTA. Incluye DOS clases de host a proposito:
//
//  1) Hosts de autenticacion real (accounts.google.com, appleid.apple.com,
//     auth.openai.com...) donde el login se rompe si el adblock interfiere.
//
//  2) Algunos sitios de contenido completos (youtube.com, github.com, x.com,
//     chatgpt.com, google.com, deepseek.com...) necesitan excepciones en
//     permisos/navegacion. El adblock filtra YouTube por separado y no usa
//     esta lista para eximir sus recursos.
//
// CONSECUENCIA, aceptada a proposito: esta lista se pasa como allowedDomains
// al adblocker (ver m.setup(... allowedDomains: AUTH_DOMAINS)), y ahi hace
// `return callback({ cancel: false })` ANTES de evaluar reglas propias de
// contenido o autenticacion. El adblock normal mantiene su lista separada.
//
// NO_REDUCIR esta lista solo "a hosts de auth" para que el adblock aplique en
// YouTube/GitHub/X: eso fue evaluado y rechazo porque rompe la navegacion.
// Si hay que agregar un host, es para conectarlo con una excepcion concreta.
//
// El matching es exacto o por sufijo con punto (ver isAuthDomain), asi que
// 'google.com' no captura 'evil-google.com' ni 'notgoogle.com'.
const AUTH_DOMAINS = [
  'login.microsoftonline.com', 'login.live.com', 'login.windows.net',
  'accounts.google.com', 'accounts.youtube.com', 'oauth.googleusercontent.com',
  'google.com', 'google.com.py', 'www.google.com', 'gmail.com', 'mail.google.com',
  'googleusercontent.com', 'googleapis.com', 'gstatic.com', 'googlevideo.com',
  'youtube.com', 'www.youtube.com', 'myaccount.google.com', 'meet.google.com',
  'drive.google.com', 'docs.google.com', 'slides.google.com', 'sheets.google.com',
  'chat.google.com', 'maps.google.com', 'play.google.com',
  'login.skype.com', 'graph.windows.net', 'appleid.apple.com', 'idmsa.apple.com',
  'auth0.com', 'github.com', 'api.github.com', 'copilot.microsoft.com',
  'api.copilot.microsoft.com', 'chatgpt.com', 'auth.openai.com', 'api.openai.com',
  'openai.com', 'www.openai.com', 'chat.openai.com',
  'claude.ai', 'api.anthropic.com', 'anthropic.com', 'www.anthropic.com',
  'grok.com', 'www.grok.com', 'auth.grok.com', 'api.grok.com',
  'gemini.google.com', 'aistudio.google.com',
  'deepseek.com', 'www.deepseek.com', 'api.deepseek.com',
  'perplexity.ai', 'www.perplexity.ai', 'api.perplexity.ai',
  'pplx-next-static-public.perplexity.ai', 'pplx-next-public.perplexity.ai',
  'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com',
  'api.x.com', 'oauth.x.com', 'auth.x.com', 'mobile.x.com', 'support.x.com',
  'x.ai', 'www.x.ai', 'accounts.x.ai', 'api.x.ai', 'oauth.x.ai', 'auth.x.ai', 'login.x.ai',
  'api.twitter.com', 'mobile.twitter.com', 'auth.twitter.com', 'id.twitter.com',
  'abs.twimg.com', 'pbs.twimg.com', 'video.twimg.com', 'twimg.com',
  // Meta: SOLO subdominios de auth/asociación (NO facebook.com/fbcdn.net
  // → el adblock sigue activo en el contenido/anuncios de Facebook/Instagram)
  'accountscenter.facebook.com', 'connect.facebook.net', 'graph.facebook.com',
  'api.instagram.com', 'i.instagram.com'
];

function isAuthDomain(host) {
  const normalized = String(host || '').toLowerCase().replace(/^\.+/, '');
  if (!normalized) return false;
  // Exacto o sufijo CON punto. No usar `includes` ni `endsWith(domain)` sin
  // punto: 'evil-google.com'.endsWith('google.com') es true y abriria la
  // puerta a cualquier host que termine igual.
  return AUTH_DOMAINS.some(domain => normalized === domain || normalized.endsWith('.' + domain));
}

// Un redirect de OAuth cruza entre el host original y el host del proveedor:
// por ejemplo grok.com -> accounts.google.com, o x.com -> auth.x.ai.
// Basta con que UNO de los dos sea dominio de auth; si ambos lo son, el
// flujo entero (incluidos hosts intermedios) queda exento.
function isAuthRedirectFlow(targetHost, documentHost) {
  return isAuthDomain(targetHost) || isAuthDomain(documentHost);
}
function isAuthPopupUrl(rawUrl) {
  try {
    return isAuthDomain(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

// === UA ===
// Global: identidad nativa de Electron/Chromium (sin override).
// WhatsApp: regla especial — UA Chrome reciente que WhatsApp acepta.
const UA_WHATSAPP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
// Perchance: NO usar UA_WHATSAPP como referencia — cada panel tiene su regla
// especial y no se mezclan. La UA de Perchance se deriva del motor real:
// declarar un Chrome mayor que el motor hace que la web sirva features que el
// motor no soporta (fallos silenciosos, ej. speaker-selection/local-network).
const PCH_CHROME_MAJOR = (process.versions && process.versions.chrome ? process.versions.chrome.split('.')[0] : '124');
const PERCHANCE_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${PCH_CHROME_MAJOR}.0.0.0 Safari/537.36`;

const MULTI_LABEL_PUBLIC_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.kr', 'com.br', 'com.cn', 'com.mx', 'co.in']);
function baseNavigationDomain(host) {
  const normalized = String(host || '').toLowerCase().replace(/^\.+/, '').replace(/\.$/, '');
  const parts = normalized.split('.');
  if (parts.length <= 2) return normalized;
  const suffix = parts.slice(-2).join('.');
  return parts.slice(-(MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix) ? 3 : 2)).join('.');
}


// El panel de Perchance viaja en su propia particion y con su propia UA, asi
// que onBeforeSendHeaders lo identifica por host para que no reciba las cabeceras
// de la sesion principal. Vive aqui, junto a PERCHANCE_UA, porque es la otra
// mitad de la misma excepcion.
function isPerchanceHost(host) {
  const value = String(host || '').toLowerCase().replace(/^\.+/, '');
  return value === 'perchance.org' || value.endsWith('.perchance.org');
}


module.exports = {
  AUTH_DOMAINS,
  isAuthDomain,
  isAuthRedirectFlow,
  isAuthPopupUrl,
  UA_WHATSAPP,
  PCH_CHROME_MAJOR,
  PERCHANCE_UA,
  isPerchanceHost,
  MULTI_LABEL_PUBLIC_SUFFIXES,
  baseNavigationDomain,
};
