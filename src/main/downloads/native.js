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
const { BROWSER_UA, fetchWithRedirects } = require('./net');
const { pickExtractor } = require('./extractors');

// id -> { item, url, webContentsId, state }
const nativeDlRegistry = new Map();
// Testigo de traspaso entre dl-native-retry y el siguiente will-download.
// Ver TRAMPA 1: es de un solo uso y se limpia en cuanto se consume.
let pendingNativeRetryId = null;

// ── Persistencia del estado en el proceso main (dl-state.json) ──
// El registro vive en memoria y muere al cerrar la app. Para que una descarga
// pausada/interrumpida se pueda reanudar tras reiniciar (sin DownloadItem,
// leyendo el .crdownload del disco), se persisten las entradas resumibles
// (state active|paused) en un JSON de userData. Al cargar, entran al registro
// con item:null; el reanudador con Range no necesita el DownloadItem.
const DLS_PATH = path.join(app.getPath('userData'), 'dl-state.json');
let dlStateTimer = null;
let dlStateDirty = false;

function persistDownloadEntries() {
  const list = [...nativeDlRegistry.values()]
    .filter((e) => e && (e.state === 'active' || e.state === 'paused'))
    .map((e) => ({
      id: e.id, url: e.url, pageUrl: e.pageUrl || '', filename: e.filename || 'descarga',
      type: e.type || 'FILE', totalBytes: e.totalBytes || 0, totalBytesEstimate: e.totalBytesEstimate || 0,
      receivedBytes: e.receivedBytes || 0, webContentsId: e.webContentsId, savePath: e.savePath || '',
      ts: e.ts || Date.now()
    }));
  try {
    const dir = path.dirname(DLS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DLS_PATH, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) { console.error('[DL-STATE] save:', e.message); }
}

// Los progresos del 'updated' de Chromium llegan cientos de veces por segundo:
// se aplanan con un timer de 1s, pero las acciones del usuario (pause/resume/
// cancel/done) persisten directo.
function saveDlStateSoon() {
  dlStateDirty = true;
  if (dlStateTimer) return;
  dlStateTimer = setTimeout(() => {
    dlStateTimer = null;
    if (dlStateDirty) { dlStateDirty = false; persistDownloadEntries(); }
  }, 1000);
}

// En un cierre brusco el JSON puede quedar a medias; no se propaga el error.
function loadDlState() {
  try {
    if (!fs.existsSync(DLS_PATH)) return;
    const list = JSON.parse(fs.readFileSync(DLS_PATH, 'utf8'));
    if (!Array.isArray(list)) return;
    for (const p of list) {
      if (!p || !p.id || !p.url || nativeDlRegistry.has(p.id)) continue;
      nativeDlRegistry.set(p.id, {
        id: p.id, url: p.url, pageUrl: p.pageUrl || '', filename: p.filename || 'descarga',
        type: p.type || 'FILE', totalBytes: p.totalBytes || 0, totalBytesEstimate: p.totalBytesEstimate || 0,
        receivedBytes: p.receivedBytes || 0, webContentsId: p.webContentsId, savePath: p.savePath || '',
        ts: p.ts || 0,
        state: 'paused', fallbackAbort: false, fallbackReq: null, item: null
      });
    }
  } catch { /* JSON corrupto de un cierre brusco: se descarta */ }
}
loadDlState();

// ── Reanudación con Range propia (vía única, cualquier servidor) ──
// item.resume() de Chromium REINICIA en silencio cuando el servidor no contesta
// 206, así que aquí se reanuda SIEMPRE con Range propio: se pide el contenido
// desde el byte del parcial (.crdownload). Si el servidor contesta 206 se
// continúa desde ahí; si contesta 200 (ignora Range: la mayoría), se re-descarga
// el cuerpo saltando los bytes ya bajados SIN reiniciar; si el cuerpo es HTML
// (enlace expirado, típico de un host con tickets), no se toca el parcial y se
// resuelve 'no-resume-support'. Funciona también sin DownloadItem (app
// reiniciada): el tamaño del parcial se lee del disco y el directo a usar lo
// decide el extractor del host (solo se re-mintia cuando lo sabe renovar).

function downloadPartialStream(entry, res, partial, savePath, opts = {}) {
  // opts: { startByte, totalBytes, checkHtml, skipBytes }
  return new Promise((resolve) => {
    const out = fs.createWriteStream(partial, { flags: 'a' });
    let received = opts.startByte || 0;
    let skip = opts.skipBytes || 0;
    let checked = !opts.checkHtml;
    let lastEmit = 0;
    let closed = false;
    const finish = (code) => {
      if (closed) return;
      closed = true;
      entry.fallbackReq = null;
      resolve(code);
    };
    entry.fallbackReq = res;
    res.on('data', (chunk) => {
      if (entry.fallbackAbort) { res.destroy(); return; }
      if (!checked) {
        checked = true;
        const head = chunk.slice(0, Math.min(chunk.length, 512)).toString('latin1').trimStart().toLowerCase();
        const ct = String(res.headers['content-type'] || '').toLowerCase();
        if (ct.includes('text/html') || /^<(?:!doctype|html|head|body|title)/.test(head)) {
          out.destroy();
          res.destroy();
          return finish('no-resume-support');
        }
      }
      if (skip > 0) {
        if (chunk.length <= skip) { skip -= chunk.length; return; }
        chunk = chunk.slice(skip);
        skip = 0;
      }
      received += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 250) {
        lastEmit = now;
        const pct = (opts.totalBytes || 0) > 0 ? Math.min(100, Math.round(received / opts.totalBytes * 100)) : 0;
        ACTIONS.emit('dl-native-progress', {
          id: entry.id, url: entry.url, filename: entry.filename,
          received, totalBytes: opts.totalBytes || 0, pct, state: 'progressing'
        });
      }
      if (!out.write(chunk)) res.pause();
    });
    out.on('drain', () => res.resume());
    res.on('error', () => { out.destroy(); finish('http-error'); });
    out.on('error', () => { res.destroy(); finish('io-error'); });
    res.on('end', () => {
      if (skip > 0) { out.destroy(); return finish('http-error'); }
      out.end(() => {
        fs.unlink(savePath, () => {});
        fs.rename(partial, savePath, () => {
          const size = (received / 1048576).toFixed(1);
          ACTIONS.emit('dl-native-done', {
            id: entry.id, url: entry.url, filename: entry.filename, file: savePath,
            size, type: entry.type || 'FILE', name: entry.filename,
            state: 'completed', cancelled: false
          });
          const live = nativeDlRegistry.get(entry.id);
          if (live) { live.state = 'done'; live.item = null; live.completedAt = Date.now(); }
          persistDownloadEntries();
          finish('ok');
        });
      });
    });
  });
}

// entry puede venir sin DownloadItem (sesión pasada): la ruta se resuelve del
// savePath persistido, o de downloadDir + filename como hace will-download.
function resumeEntrySavePath(entry) {
  if (entry.item && typeof entry.item.getSavePath === 'function') return entry.item.getSavePath();
  return entry.savePath;
}

// Cierra la entrada como 'done' emitiendo el evento que mueve el panel (usado
// cuando el archivo ya está completo en disco o un 416 confirma que el parcial
// alcanzó el total). La fila nunca debe quedarse congelada.
function finishNativeAsDone(entry, savePath, totalBytes) {
  const size = ((totalBytes || 0) / 1048576).toFixed(1);
  const live = nativeDlRegistry.get(entry.id);
  if (live) { live.state = 'done'; live.item = null; live.completedAt = Date.now(); }
  ACTIONS.emit('dl-native-done', {
    id: entry.id, url: entry.url, filename: entry.filename, file: savePath,
    size, type: entry.type || 'FILE', name: entry.filename,
    state: 'completed', cancelled: false
  });
  persistDownloadEntries();
}

function resumeNativeWithRange(entry, targetUrl) {
  return new Promise((resolve) => {
    const savePath = resumeEntrySavePath(entry);
    const partial = savePath + '.crdownload';
    const totalBytes = entry.totalBytes > 0 ? entry.totalBytes : (entry.totalBytesEstimate || 0);

    // 1) El archivo ya está completo en disco (la descarga terminó justo al
    // cerrar la app y faltó persistir el estado): se cierra como done, no se
    // descarga nada.
    fs.stat(savePath, (saveErr, sf) => {
      if (!saveErr && sf.isFile()) {
        finishNativeAsDone(entry, savePath, sf.size);
        return resolve('ok');
      }

      fs.stat(partial, (statErr, st) => {
        const hasPartial = !statErr && st.isFile() && st.size > 0;
        const startByte = hasPartial ? st.size : 0;
        const headers = {
          'User-Agent': BROWSER_UA,
          Accept: '*/*',
          Referer: entry.pageUrl || ''
        };
        if (hasPartial) headers.Range = 'bytes=' + startByte + '-';
        // 2) Sin parcial (app reiniciada que limpió el .crdownload, o Chromium
        // lo borró al salir): se reinicia desde cero con el stream propio. La
        // fila AVANZA; no se queda congelada, pero se avisa al panel por qué.
        if (!hasPartial) {
          try {
            getMainWin()?.webContents?.send('dl-native-note', {
              id: entry.id, text: 'No había archivo parcial: se reinicia desde cero'
            });
          } catch {}
        }
        fetchWithRedirects(targetUrl, { headers }).then(({ res, status }) => {
          if (hasPartial && status === 206) {
            // 3) Continúa exactamente desde el último byte del parcial.
            downloadPartialStream(entry, res, partial, savePath, { startByte, totalBytes }).then(resolve);
          } else if (hasPartial && status === 200) {
            // El servidor ignora Range: se descartan los primeros startByte
            // bytes del cuerpo y el resto se agrega al parcial, sin reiniciar.
            downloadPartialStream(entry, res, partial, savePath, {
              startByte, totalBytes, checkHtml: true, skipBytes: startByte
            }).then(resolve);
          } else if (!hasPartial && (status === 206 || status === 200)) {
            downloadPartialStream(entry, res, partial, savePath, {
              startByte: 0, totalBytes, checkHtml: true
            }).then(resolve);
          } else if (hasPartial && status === 416 && totalBytes > 0 && startByte >= totalBytes) {
            // Range fuera de límite porque el parcial ya llega al total.
            res.resume();
            finishNativeAsDone(entry, savePath, startByte);
            resolve('ok');
          } else {
            res.resume();
            resolve('http-error');
          }
        }).catch(() => resolve('http-error'));
      });
    });
  });
}

// Entrada reconstruida para reanudar una descarga de una sesión anterior (el
// renderer mandó saved: url/pageUrl/filename/... pero el registro está vacío).
function makeStaleEntry(id, saved) {
  const filename = String(saved.filename || 'descarga');
  const dlDir = CFG.downloadDir || app.getPath('downloads');
  return {
    id,
    url: saved.url,
    pageUrl: saved.pageUrl || '',
    filename,
    type: saved.type || 'FILE',
    savePath: resolveSafePath(dlDir, filename) || path.join(dlDir, 'descarga'),
    totalBytes: Number(saved.total) || 0,
    totalBytesEstimate: Number(saved.total) || 0,
    receivedBytes: Number(saved.received) || 0,
    ts: Date.now(),
    state: 'paused', fallbackAbort: false, fallbackReq: null, item: null
  };
}

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
      // Guardar en la carpeta de descargas configurada. El nombre viene de
      // Content-Disposition (Chromium lo sanitiza, pero no confiamos en eso):
      // se confina a dlDir por si trae separadores o '..'.
      const savePath = resolveSafePath(dlDir, filename) || path.join(dlDir, 'descarga');
      nativeDlRegistry.set(dlId, {
        id: dlId, item, url, filename, type, totalBytes, webContentsId: webContents?.id,
        pageUrl, savePath, ts: Date.now(), state: 'active'
      });
      item.setSavePath(savePath);
      persistDownloadEntries();

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
        if (entry) {
          entry.state = item.isPaused() ? 'paused' : state === 'progressing' ? 'active' : state;
          entry.receivedBytes = item.getReceivedBytes();
        }
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
        saveDlStateSoon();
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
        // El archivo persistido solo guarda resumibles (active|paused): la
        // entrada recién terminada sale del JSON al re-persistir.
        persistDownloadEntries();
      });
    } catch (e) {
      console.error('[DL-NATIVE]', e.message);
    }
  });
}


/**
 * Registra los IPC de control de las descargas nativas.
 *
 * Se llama a nivel de modulo (no dentro de whenReady) para que los handlers
 * existan siempre, igual que el resto de los IPC del proceso principal.
 */
function registerNativeDownloadIpc() {
  ipcMain.handle('dl-native-pause', (_e, id) => {
    const entry = nativeDlRegistry.get(id);
    if (!entry || entry.state !== 'active' || !entry.item) return { ok: false };
    try { entry.item.pause(); entry.state = 'paused'; persistDownloadEntries(); return { ok: true }; } catch { return { ok: false }; }
  });
  ipcMain.handle('dl-native-resume', async (_e, id, saved = {}) => {
    let entry = nativeDlRegistry.get(id);
    if (!entry) {
      // Descarga de una sesión anterior y sin registro persistido (o limpiado):
      // el renderer manda el mínimo y se reconstruye la entrada con item:null.
      if (!saved.url) return { ok: false };
      entry = makeStaleEntry(id, saved);
      nativeDlRegistry.set(id, entry);
    }
    if (entry.state !== 'paused') return { ok: false, reason: 'busy' };
    try {
      if (entry.fallbackReq && !entry.fallbackReq.destroyed) return { ok: true, mode: 'range' };
      entry.fallbackAbort = false;
      entry.state = 'active';
      // Si el host sabe renovar directos (re-mint) se pide uno fresco ANTES de
      // lanzar el Range; sino se usa la URL original. Nunca item.resume().
      entry.receivedBytes = entry.receivedBytes || 0;
      let targetUrl = entry.url;
      const ex = pickExtractor(entry.url);
      if (ex && typeof ex.mint === 'function') {
        const minted = await ex.mint(entry.pageUrl || entry.url);
        if (!minted) return { ok: false, reason: ex.name + '-remint-fail' };
        targetUrl = minted;
      }
      resumeNativeWithRange(entry, targetUrl).then((result) => {
        if (result !== 'ok') {
          const cur = nativeDlRegistry.get(entry.id);
          if (cur) cur.state = 'paused';
          persistDownloadEntries();
          try { getMainWin()?.webContents?.send('dl-native-range-fail', { id: entry.id, reason: result }); } catch {}
        }
      });
      persistDownloadEntries();
      return { ok: true, mode: 'range' };
    } catch { return { ok: false, reason: 'error' }; }
  });
  ipcMain.handle('dl-native-cancel', (_e, id) => {
    const entry = nativeDlRegistry.get(id);
    if (!entry || !['active', 'paused'].includes(entry.state)) return { ok: false };
    if (entry.fallbackReq) {
      entry.fallbackAbort = true;
      try { entry.fallbackReq.destroy(); } catch {}
    }
    try {
      if (entry.item) entry.item.cancel();
      entry.state = 'cancelled';
      persistDownloadEntries();
      return { ok: true };
    } catch { return { ok: false }; }
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
  // Estado resumible (active|paused) del proceso main: lo pide el renderer al
  // arrancar para mostrar interrumpidas que ya no viven en su historial.
  ipcMain.handle('dl-native-state', () => {
    return [...nativeDlRegistry.values()]
      .filter((e) => e && (e.state === 'active' || e.state === 'paused'))
      .map((e) => ({
        id: e.id, url: e.url, pageUrl: e.pageUrl || '', filename: e.filename || 'descarga',
        name: e.filename || 'descarga', type: e.type || 'FILE',
        totalBytes: e.totalBytes || 0, receivedBytes: e.receivedBytes || 0,
        progress: (e.totalBytes || 0) > 0 ? Math.round((e.receivedBytes || 0) / e.totalBytes * 100) : 0,
        state: 'interrupted', native: true, ts: e.ts || Date.now()
      }));
  });
}

module.exports = {
  registerNativeDownloadHandler,
  registerNativeDownloadIpc,
};
