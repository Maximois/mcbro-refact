'use strict';
/**
 * MC Browser -- src/main/runtime.js
 *
 * Estado global del proceso principal que mas de un modulo necesita. Es el
 * unico modulo sin logica propia: solo guarda por que tener centralizado lo
 * que antes vivia suelto en main.js.
 *
 * QUE HACE
 *   - Ser el dueno de la ventana anfitriona (mainWin).
 *   - Ser el dueno de ACTIONS, el objeto que el renderer y los modulos usan
 *     para hablar con la ventana y para activar/desactivar el adblock.
 *
 * QUE NO DEBE HACER
 *   - No crea la ventana. `setMainWin()` solo la registra; la construccion es
 *     de src/main/windows/create.js.
 *   - No guarda CFG. Eso es de src/main/config y se importa directo.
 *   - No guarda nada mas. Si aparece una tercera variable global que varios
 *     modulos necesitan, va en ese modulo.
 *
 * -----------------------------------------------------------------------------
 * INVARIANTE 1 — mainWin se obtiene con una FUNCION, no con una variable
 * -----------------------------------------------------------------------------
 * mainWin se asigna dentro de createWindow(), es decir DESPUES de que todos
 * los modulos se hayan cargado. Un `const { mainWin } = require('./runtime')`
 * se quedaria con `null` para siempre y todos los `send()` al renderer
 * fallarian en silencio.
 *
 * Correcto:   getMainWin()?.webContents?.send(...)
 * Incorrecto: mainWin?.webContents?.send(...)   con mainWin capturado al require
 *
 * `getMainWin()` devuelve `null` mientras no haya ventana, y puede devolver una
 * ventana YA DESTRUIDA: main.js nunca pone el puntero a null en el evento
 * 'closed'. Por eso todos los usos van envueltos en try/catch o con `?.`, y los
 * que necesitan hablar con ella de verdad comprueban `isDestroyed()` antes.
 * No "arreglar" eso aqui sin revisar los 70+ call sites: hoy cada uno ya sabe
 * si su ventana puede estar muerta.
 *
 * -----------------------------------------------------------------------------
 * INVARIANTE 2 — ACTIONS se destructura, sus propiedades NO
 * -----------------------------------------------------------------------------
 *   const { ACTIONS } = require('./runtime');   // OK, el objeto se pasa por ref
 *   const { emit } = require('./runtime');      // MAL, emit todavia no existe
 *
 * Las dos propiedades se asignan tarde y en un orden que importa:
 *
 *   ACTIONS.emit          <- dentro de app.whenReady()
 *   ACTIONS.adblockToggle <- justo despues de que el modulo adblocker cargue
 *
 * Los listeners de `web-contents-created` se REGISTRAN antes de whenReady (en
 * el nivel de modulo) pero no se EJECUTAN hasta que Electron cree un webContents.
 * El orden real es: se registra el listener -> cuandoReady asigna emit -> el
 * webview navega -> el listener corre. Funciona, pero el margen es de un solo
 * paso. Un listener nuevo que intente emitir durante el arranque tropezaria con
 * `emit === null` y el `try {} catch {}` lo esconderia. Ver
 * docs/RESTRUCTURACION.md seccion 2.3.
 */

let mainWin = null;

/**
 * Registra la ventana anfitriona y la devuelve, para poder encadenar:
 *   const win = setMainWin(new BrowserWindow({...}));
 * @returns {import('electron').BrowserWindow}
 */
function setMainWin(win) {
  mainWin = win;
  return win;
}

function getMainWin() {
  return mainWin;
}

// Module action references (set after whenReady)
const ACTIONS = { adblockToggle: null, emit: null };

module.exports = { setMainWin, getMainWin, ACTIONS };