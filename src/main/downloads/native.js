'use strict';
/**
 * MC Browser -- src/main/downloads/native.js
 *
 * Las descargas que hace Chromium por su cuenta: el registro de lo que esta
 * bajando, el 'will-download' que lo captura, y los cuatro IPC de control.
 *
 * -----------------------------------------------------------------------------
 * POR QUE EL REGISTRO Y LOS IPC ESTAN EN EL MISMO MODULO
 * -----------------------------------------------------------------------------
 * `nativeDlRegistry` solo lo usan dos cosas: el handler de 'will-download' y
 * los handlers de `dl-native-pause/resume/cancel/retry`. Nada mas, en toda la
 * aplicacion.
 *
 * Eso permitia mover solo el handler y exportar el Map. Habria funcionado, pero
 * habria dejado el estado colgando fuera con un `setPendingNativeRetry(id)`
 * como unica puerta de entrada, que es exactamente el tipo de stubs que se
 * quedan puestos para siempre. Moviendo los cuatro IPC con el registro, el token
 * deja de necesitar puerta: se queda privado.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- pendingNativeRetryId es un testigo de un solo uso
 * -----------------------------------------------------------------------------
 * No es un estado, es un puntero de traspaso entre dos eventos distintos:
 *
 *   dl-native-retry  ->  pendingNativeRetryId = id;  source.downloadURL(url)
 *                                            |
 *                        (Chromium dispara 'will-download' para esa URL)
 *                                            v
 *   will-download    ->  dlId = pendingNativeRetryId || generarUno()
 *                        pendingNativeRetryId = null;
 *
 * Sirve para que el reintento **reutilice el id** de la descarga que fallo. Sin
 * el testigo, el reintento crearia una entrada nueva en el panel y la anterior
 * se quedaria a medias para siempre.
 *
 * El unico riesgo real es que se quede puesto: si `downloadURL()` no dispara
 * 'will-download' (por ejemplo porque la particion no responde), el testigo
 * sobrevive y el proximo will-download que llegue, de cualquier pagina, hereda
 * un id de reintento equivocado. Por eso se limpia a null en cuanto se consume,
 * y por eso es de un solo uso por diseno.
 *
 * No es un Map porque solo hay un reintento en vuelo a la vez: el renderer
 * dispara uno, espera el evento, y lanza el siguiente.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- Perchance no pasa por aqui
 * -----------------------------------------------------------------------------
 * 'will-download' se salta entero si la pagina es de perchance.org. El panel de
 * Perchance ya registra su propio 'will-download' para manejar blob:/data: y
 * tiene su carpeta dedicada (Downloads/Perchance). Si esta sesion lo
 * interceptara primero, las dos rutas competirian por el mismo evento.
 *
 * Por eso el filtro mira el host de la PAGINA (no el de la URL descargada): una
 * descarga desde una pagina de Perchance de un host de terceros sigue siendo de
 * Perchance y la gestiona su modulo.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 3 -- el registro se poda a 200, y solo por entradas terminadas
 * -----------------------------------------------------------------------------
 * Al terminar una descarga se ordena el registro por `completedAt` y se
 * descarta la mas vieja mientras haya mas de 200. El filtro es `value.completedAt`,
 * no el tamano del Map: las descargas activas no tienen completedAt, asi que no
 * se pueden podar nunca. Un `size > 200` aqui borraria descargas en curso y
 * dejaria al renderer sin entrada para actualizarlas.
 *
 * El limite de 200 es de memoria, no de disco: el historial de descargas lo
 * guarda el renderer.
 */

const fs = require('fs');
const path = require('path');
const { app, ipcMain, session, webContents } = require('electron');
const { CFG, resolveSafePath } = require('../config');
const { getMainWin, ACTIONS } = require('../runtime');

// id -> { item, url, webContentsId, state }
const nativeDlRegistry = new Map();
// Testigo de traspaso entre dl-native-retry y el siguiente will-download.
// Ver TRAMPA 1: es de un solo uso y se limpia en cuanto se consume.
let pendingNativeRetryId = null;

// ── Descargas nativas del navegador (will-download) ──
// Nivel de módulo (igual que MediaDetect.checkMedia) para poder engancharla tanto en la
// sesión principal como en cada sesión aislada (setupExtraSession), y que
// las descargas hechas ahí también aparezcan en el panel de descargas.
function registerNativeDownloadHandler(sess) {
  sess.on('will-download', (event, item, webContents) => {
    try {
      const wc = webContents;
      const pageUrl = wc && !wc.isDestroyed() ? wc.getURL() || '' : '';
      if (wc && !wc.isDestroyed()) {
        // Perchance corre en su propia partición. Su módulo ya registra
        // 'will-download' para manejar blob:/data: correctamente y con su
        // carpeta de descargas dedicada (Downloads/Perchance).
        try {
          const host = new URL(pageUrl).hostname.toLowerCase();
          if (host === 'perchance.org' || host.endsWith('.perchance.org')) return;
        } catch {}
      }
      const url = item.getURL() || '';
      const filename = item.getFilename() || 'descarga';
      const totalBytes = item.getTotalBytes();
      const dlId = pendingNativeRetryId || ('dl-native-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
      pendingNativeRetryId = null;
      const dlDir = CFG.downloadDir || app.getPath('downloads');
      if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
      // mimeType lo trae Chromium ya resuelto (incluye el sniff de bytes para
      // blob:/data:), así que es la fuente fiable para etiquetar el historial.
      const mime = String(item.getMimeType() || '').toLowerCase();
      const type = mime.startsWith('video/') ? 'MP4'
        : mime.startsWith('audio/') ? 'AUDIO'
        : mime.startsWith('image/') ? 'IMG'
        : mime === 'application/pdf' ? 'PDF'
        : 'FILE';
      nativeDlRegistry.set(dlId, { id: dlId, item, url, filename, type, webContentsId: webContents?.id, state: 'active' });
      // Guardar en la carpeta de descargas configurada. El nombre viene de
      // Content-Disposition (Chromium lo sanitiza, pero no confiamos en eso):
      // se confina a dlDir por si trae separadores o '..'.
      item.setSavePath(resolveSafePath(dlDir, filename) || path.join(dlDir, 'descarga'));

      // Avisar al renderer para cerrar la pestaña popup que solo sirvió
      // para iniciar esta descarga (comportamiento de navegadores normales:
      // la pestaña de descarga se abre y se cierra sola).
      try {
        getMainWin()?.webContents?.send('dl-native-tab', { wcId: webContents?.id });
      } catch {}

      ACTIONS.emit('dl-native', {
        id: dlId,
        url,
        filename,
        type,
        totalBytes,
        pageUrl,
        state: 'active'
      });

      item.on('updated', (e, state) => {
        const entry = nativeDlRegistry.get(dlId);
        if (entry) entry.state = item.isPaused() ? 'paused' : state === 'progressing' ? 'active' : state;
        const received = item.getReceivedBytes();
        const pct = totalBytes > 0 ? Math.round(received / totalBytes * 100) : 0;
        ACTIONS.emit('dl-native-progress', {
          id: dlId,
          url,
          filename,
          received,
          totalBytes,
          pct,
          state
        });
      });

      item.on('done', (e, state) => {
        const entry = nativeDlRegistry.get(dlId);
        const finalState = state === 'completed' ? 'done' : state === 'cancelled' ? 'cancelled' : 'error';
        if (entry) {
          entry.state = finalState;
          entry.item = null;
          entry.completedAt = Date.now();
        }
        const received = item.getReceivedBytes();
        const size = (received / 1048576).toFixed(1);
        const filePath = item.getSavePath();
        ACTIONS.emit('dl-native-done', {
          id: dlId,
          url,
          filename,
          file: filePath,
          size,
          // El historial del renderer usa type/name para la etiqueta y el icono;
          // sin ellos la entrada cae en los valores por defecto.
          type: nativeDlRegistry.get(dlId)?.type || 'FILE',
          name: filename,
          state,
          cancelled: state === 'cancelled' || state === 'interrupted'
        });
        const completed = [...nativeDlRegistry.entries()]
          .filter(([, value]) => value.completedAt)
          .sort((a, b) => a[1].completedAt - b[1].completedAt);
        while (completed.length > 200) {
          nativeDlRegistry.delete(completed.shift()[0]);
        }
      });
    } catch (e) {
      console.error('[DL-NATIVE]', e.message);
    }
  });
}


/**
 * Registra los cuatro IPC de control de las descargas nativas.
 *
 * Se llama a nivel de modulo (no dentro de whenReady) para que los handlers
 * existan siempre, igual que el resto de los IPC del proceso principal.
 */
function registerNativeDownloadIpc() {
  ipcMain.handle('dl-native-pause', (_e, id) => {
    const entry = nativeDlRegistry.get(id);
    if (!entry || entry.state !== 'active') return { ok: false };
    try { entry.item.pause(); entry.state = 'paused'; return { ok: true }; } catch { return { ok: false }; }
  });
  ipcMain.handle('dl-native-resume', (_e, id) => {
    const entry = nativeDlRegistry.get(id);
    if (!entry || entry.state !== 'paused') return { ok: false };
    try {
      // item.resume() sin soporte de Range hace que Chromium REINICIE la
      // descarga desde cero (el sintoma reportado). canResume() decide: si el
      // servidor no puede reanudar, no relanzamos en silencio.
      if (!entry.item.canResume()) return { ok: false, reason: 'no-resume-support' };
      entry.item.resume(); entry.state = 'active'; return { ok: true };
    } catch { return { ok: false, reason: 'error' }; }
  });
  ipcMain.handle('dl-native-cancel', (_e, id) => {
    const entry = nativeDlRegistry.get(id);
    if (!entry || !['active', 'paused'].includes(entry.state)) return { ok: false };
    try { entry.item.cancel(); entry.state = 'cancelled'; return { ok: true }; } catch { return { ok: false }; }
  });
  ipcMain.handle('dl-native-retry', (_e, id, saved = {}) => {
    const entry = nativeDlRegistry.get(id);
    const url = entry?.url || saved.url;
    if (!url) return { ok: false };
    try {
      pendingNativeRetryId = id;
      const source = entry?.webContentsId ? webContents.fromId(entry.webContentsId) : null;
      if (source && !source.isDestroyed()) source.downloadURL(url);
      else session.fromPartition(saved.partition || 'persist:mc').downloadURL(url);
      return { ok: true };
    } catch { return { ok: false }; }
  });
}

module.exports = {
  registerNativeDownloadHandler,
  registerNativeDownloadIpc,
};
