'use strict';
/**
 * MC Browser -- src/main/navigation/explicit-nav.js
 *
 * Maquina de estados que marca que una navegacion fue iniciada por los controles
 * del navegador, para que las reglas anti-redireccion no le corten la cadena.
 *
 * QUE HACE
 *   Un Map de webContents.id -> { timer }. Cuatro operaciones:
 *
 *     markExplicitNavigation(wcId)        el usuario puso la URL
 *     keepExplicitNavigationAlive(wcId)  renueva la ventana de 2,5 s
 *     hasExplicitNavigation(wcId)        consulta
 *     clearExplicitNavigation(wcId)      limpia ya
 *
 * QUE NO DEBE HACER
 *   - No decide si una redireccion se permite. Eso es transitions.js. Aqui solo
 *     se lleva la cuenta de si la navegacion en curso la empezó el usuario.
 *   - No guarda nada mas por webContents.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- 2,5 s es corto a proposito
 * -----------------------------------------------------------------------------
 * EXPLICIT_NAV_SETTLE_MS (2500) es la ventana durante la que una redireccion se
 * considera parte de la navegacion que el usuario pidio. Pasado ese plazo el
 * estado se borra solo y las reglas anti-redireccion vuelven a aplicarse.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- did-navigate RENUEVA, no limpia
 * -----------------------------------------------------------------------------
 * El evento 'did-navigate' se emite cuando la navegacion del frame principal se
 * CONFIRMA, o sea tras la cadena de redirecciones. Por eso conviene renovar el
 * margen en vez de cortarlo: allows que la cadena completa siga exenta y
 * vuelve a bloquear auto-redirecciones posteriores (anuncios) durante el resto de
 * la carga.
 *
 * did-navigate puede dispararse en un salto INTERMEDIO de la cadena en algunas
 * versiones de Chromium, no solo al final. Por eso limpiar ahi mismo cortaria la
 * proteccion a mitad de una cadena legitima (muy comun: login.x.com -> api.x.com
 * -> app.x.com), y el siguiente salto de ESA MISMA navegacion quedaria
 * bloqueado como si fuera ajeno.
 *
 * 'did-fail-load' si limpia de inmediato, porque ahi no hay cadena que
 * proteger.
 *
 * La politica que consume este estado esta en el listener de 'will-redirect'
 * (hoy en main.js, se extrae a windows/webcontents.js en el paso 25).
 */

// WebContents con una navegación EXPLÍCITA iniciada por controles del navegador
// (barra de URL, marcador, historial o atajo). Mientras una webContents
// está en este estado, `will-redirect` NO bloquea sus redirecciones: las reglas
// anti-redirección solo aplican a auto-redirecciones iniciadas por la página.
const userNavWebContents = new Map();
const EXPLICIT_NAV_SETTLE_MS = 2500;

function markExplicitNavigation(wcId) {
  const previous = userNavWebContents.get(wcId);
  if (previous?.timer) clearTimeout(previous.timer);
  userNavWebContents.set(wcId, { timer: null });
}

function keepExplicitNavigationAlive(wcId) {
  const navigation = userNavWebContents.get(wcId);
  if (!navigation) return false;
  if (navigation.timer) clearTimeout(navigation.timer);
  navigation.timer = setTimeout(() => userNavWebContents.delete(wcId), EXPLICIT_NAV_SETTLE_MS);
  return true;
}

function clearExplicitNavigation(wcId) {
  const navigation = userNavWebContents.get(wcId);
  if (navigation?.timer) clearTimeout(navigation.timer);
  userNavWebContents.delete(wcId);
}

function hasExplicitNavigation(wcId) {
  return userNavWebContents.has(wcId);
}

module.exports = {
  userNavWebContents,
  EXPLICIT_NAV_SETTLE_MS,
  markExplicitNavigation,
  keepExplicitNavigationAlive,
  clearExplicitNavigation,
  hasExplicitNavigation,
};