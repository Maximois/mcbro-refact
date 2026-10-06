'use strict';
/**
 * MC Browser -- src/main/downloads/registry.js
 *
 * El registro de descargas activas: lo unico que permite pausar, reanudar y
 * cancelar una descarga en curso desde otro proceso (el renderer).
 *
 * -----------------------------------------------------------------------------
 * LO QUE ESTA Y LO QUE NO
 * -----------------------------------------------------------------------------
 * Aqui vive el `Map` y los tres canales de control (`dl-pause`, `dl-resume`,
 * `dl-cancel`). NO viven aqui las descargas: `dl-hls` y `dl-file` se quedan en
 * `main.js` hasta los pasos 16 y 17, y son los que se registran contra este
 * registro con `dlRegister()`.
 *
 * Que se separen es lo que hace que `dl-pause` pueda seguir funcionando cuando
 * los dos bucles de descarga se muevan: el registro no depende de ellos.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- `PauseSignal` no es un error, es una pausa
 * -----------------------------------------------------------------------------
 * ```js
 * if (entry.state === 'paused') throw new PauseSignal();
 * // ...
 * if (err instanceof PauseSignal || entry.state === 'paused') continue;
 * ```
 *
 * Se lanza DENTRO del bucle de descarga y se captura en el mismo bucle, para
 * saltar al siguiente segmento sin perder el progreso. Si un `catch` genérico
 * lo tratara como un fallo real, avisaria al usuario de un error que el propio
 * usuario acaba de provocar, y la descarga se marcaria como fallida en vez de
 * pausada.
 *
 * Por eso `dl-file` lo mira con `instanceof` y no por el texto del mensaje.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- el AbortController se recrea al reanudar
 * -----------------------------------------------------------------------------
 * Un `AbortController` abortado no se puede volver a usar: queda contamina-
 * do para siempre. Por eso `dl-resume` hace `e.controller = new
 * AbortController()` en lugar de limpiar el anterior.
 *
 * Y por eso los dos bucles de descarga leen `entry.controller.signal` en CADA
 * iteracion en vez de guardarlo una vez al principio: si lo guardaran, resumed
 * seguiria leyendo el signal del controller viejo y ya abortado, y la descarga
 * no continuaria.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 3 -- `dlWaitIfPaused` sondea, no empuja
 * -----------------------------------------------------------------------------
 * No hay evento "se ha reanudado". El que espera (el bucle HLS) comprueba cada
 * 250 ms el estado de su entrada. Es simple y es correcto, pero significa que
 * una descarga pausada sigue despertando cada cuarto de segundo mientras dure
 * la pausa. Con una descarga pausada y el navegador abierto eso son cuatro
 * despertares por segundo.
 *
 * Si alguna vez esto molesta (consumo de CPU con la ventana minimizada), el
 * arreglo es un `Set` de resolvers pendientes en el registro, no un intervalo
 * mas corto.
 */

const { ipcMain } = require('electron');

// id -> { id, url, type, state, controller }
// `state` es 'active' | 'paused' | 'cancelled'. La entrada se borra al
// terminar la descarga (en el `finally` de cada bucle), no antes: mientras dura
// el trabajo tiene que poder consultarse.
const dlRegistry = new Map();

// Se lanza para saltar de segmento sin perder progreso. Ver TRAMPA 1.
class PauseSignal extends Error {}

function dlRegister(id, url, type) {
  const entry = { id, url, type, state: 'active', controller: new AbortController() };
  dlRegistry.set(id, entry);
  return entry;
}

// Resuelve 'active' cuando se reanuda, 'cancelled' si se cancela mientras espera.
// Y 'active' si la entrada ya no esta, que es lo que pasa si se completo.
function dlWaitIfPaused(id) {
  return new Promise(resolve => {
    const tick = () => {
      const e = dlRegistry.get(id);
      if (!e) return resolve('active');
      if (e.state === 'cancelled') return resolve('cancelled');
      if (e.state === 'active') return resolve('active');
      setTimeout(tick, 250);
    };
    tick();
  });
}

function registerDownloadControlIpc() {
  ipcMain.handle('dl-pause', (_e, id) => {
    const e = dlRegistry.get(id);
    if (e && e.state === 'active') {
      e.state = 'paused';
      // En archivos directos abortamos el fetch para pausar de inmediato;
      // en HLS el bucle espera en el limite del lote sin perder segmentos.
      if (e.type === 'file' && e.controller) e.controller.abort();
    }
    return { ok: true };
  });
  ipcMain.handle('dl-resume', (_e, id) => {
    const e = dlRegistry.get(id);
    if (e && e.state === 'paused') {
      e.state = 'active';
      // Un AbortController abortado no se reutiliza. Ver TRAMPA 2.
      e.controller = new AbortController();
    }
    return { ok: true };
  });
  ipcMain.handle('dl-cancel', (_e, id) => {
    const e = dlRegistry.get(id);
    if (e) {
      e.state = 'cancelled';
      if (e.controller) e.controller.abort();
    }
    return { ok: true };
  });
}

module.exports = {
  dlRegistry, PauseSignal, dlRegister, dlWaitIfPaused, registerDownloadControlIpc,
};