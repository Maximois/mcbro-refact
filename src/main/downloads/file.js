'use strict';
/**
 * MC Browser -- src/main/downloads/file.js
 *
 * La descarga de un archivo directo: un solo `GET`, con `Range` para poder
 * reanudar, y el canal `dl-file`.
 *
 * -----------------------------------------------------------------------------
 * LO QUE ESTA Y LO QUE NO
 * -----------------------------------------------------------------------------
 * Aqui: el handler `dl-file` y el calculo del nombre de destino.
 *
 * NO: `finalizeMediaFile`. A diferencia de `hls.js`, este camino NO necesita
 * ffmpeg: aqui no hay nada que remuxar, solo renombrar. Por eso este modulo no
 * lleva inyeccion temporal y su `register` no recibe parametros.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- reanudar es "volver a pedir con Range", no "seguir escribiendo"
 * -----------------------------------------------------------------------------
 * El estado de reanudacion de este canal es el propio `.part` en disco: no hay
 * JSON ni indice, el offset es el tamano del archivo.
 *
 * Pausar NO deja el stream abierto. Lanza `PauseSignal` DENTRO del bucle del
 * reader, lo que aborta la peticion; el catch cancela el reader y el `while`
 * exterior vuelve a pedir con:
 *
 * ```js
 * headers['Range'] = `bytes=${offset}-`;
 * ```
 *
 * Y si el servidor **ignora** el Range y contesta 200 en vez de 206, el codigo
 * detecta la incoherencia y reinicia desde cero:
 *
 * ```js
 * if (res.status === 200 && offset > 0) { ... fs.writeFileSync(rawName, Buffer.alloc(0)); offset = 0; }
 * ```
 *
 * Sin esa comprobacion se concatenarian el archivo viejo y el nuevo, y saldria
 * un archivo corrupto del tamano de la suma, sin error de reds.
 *
 * Y el `output.close()` que hay antes del truncado importa en Windows: un
 * `WriteStream` abierto mantiene el fichero bloqueado y el `writeFileSync`
 * siguiente fallaria con EPERM.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- `detectedExt` NO detecta la extension real, y tres ramas estan muertas
 * -----------------------------------------------------------------------------
 * Antes del paso 17, esto era codigo igual y nadie lo habia tocado. Se deja
 * documentado porque es lo primero que va a "arreglar" alguien que lea esto, y
 * cambiarlo cambia los nombres de archivo que ve el usuario.
 *
 * ```js
 * if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)(?:$|[?#])/i.test(lower)) return '.png';  // <- esta gana
 * if (/\.(jpg|jpeg)(?:$|[?#])/i.test(lower)) return '.jpg';                        // <- NUNCA
 * if (/\.(gif)(?:$|[?#])/i.test(lower)) return '.gif';                             // <- NUNCA
 * if (/\.(webp)(?:$|[?#])/i.test(lower)) return '.webp';                           // <- NUNCA
 * ```
 *
 * El primer patron ya cubre jpg, jpeg, gif y webp, asi que las tres ramas
 * siguientes son inalcanzables. Lo que sale de verdad:
 *
 * | URL | Extension con la que se guarda | Bytes |
 * | --- | --- | --- |
 * | `foto.jpg`, `foto.gif`, `foto.webp`, `x.avif`, `x.svg`, `x.bmp` | `.png` | los originales |
 * | `cancion.wav`, `cancion.flac`, `cancion.ogg` | `.mp3` | los originales |
 * | `clip.mkv`, `clip.mov`, `clip.avi` | `.mp4` | los originales |
 * | `archivo.zip` | `.bin` | los originales |
 *
 * Es decir: **agrupa por familia y usa la extension canonica de esa familia**
 * (imagen `.png`, audio `.mp3`, video `.mp4`). Nadie sabe si fue intencionado o
 * si las tres ramas de abajo se quedaron sin efecto cuando se toco el primer
 * patron. Lo que SI es claro es que un JPEG llamado `foto.png` es un archivo con
 * el nombre equivocado, y que la tercera rama existia precisamente para evitar
 * eso.
 *
 * NO se corrige en este commit porque cambiaria los nombres que el usuario ve.
 * `test/downloads-file.test.js` fija el comportamiento ACTUAL, con el nombre del
 * test diciendo que es raro a proposito, para que quien lo arregle tenga que
 * tocar el test y vea por que estaba.
 *
 * Aparte: `lower` ya viene de `split('?')[0]`, asi que el `(?:$|[?#])` de cada
 * patron es redundante. No se simplifica por el mismo motivo.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 3 -- el nombre viene del renderer y se sanea
 * -----------------------------------------------------------------------------
 * `name` lo pone el otro proceso, asi que va por el filtro de caracteres
 * prohibidos en Windows (`\\ / : * ? " < > |`) antes de tocar el disco. Sin eso,
 * una descarga con nombre `a:b` revienta en `renameSync` y el usuario pierde el
 * archivo entero.
 *
 * Y antes del `renameSync` se borra el destino si existe: en Windows
 * `renameSync` falla con EEXIST si el destino esta ahi, no lo sobreescribe.
 */

const fs = require('fs');
const path = require('path');
const { ipcMain, app } = require('electron');
const { ACTIONS } = require('../runtime');
const { CFG } = require('../config');
const DownloadsRegistry = require('./registry');
const DownloadsFetch = require('./fetch');

function registerFileDownloadIpc() {
  ipcMain.handle('dl-file', async (e, { id, url, name, pageUrl }) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      const error = 'URL multimedia inválida o vacía';
      ACTIONS.emit('dl-error', { id, url: url || '', error });
      ACTIONS.emit('ytdlp-log', '✗ Error: ' + error);
      return { error };
    }
    const dlDir = CFG.downloadDir || app.getPath('downloads');
    if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
    const t0 = Date.now();
    const extraHeaders = DownloadsFetch.mediaRequestHeaders(pageUrl, url);
    const entry = DownloadsRegistry.dlRegister(id, url, 'file');
    const safeBase = String(name || 'media_' + Date.now()).replace(/[\\/:*?"<>|]/g, '_').trim() || 'media';
    const detectedExt = (() => {
      const lower = String(url || '').split('?')[0].toLowerCase();
      if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)(?:$|[?#])/i.test(lower)) return '.png';
      if (/\.(mp3|wav|flac|ogg|m4a|aac)(?:$|[?#])/i.test(lower)) return '.mp3';
      if (/\.(mp4|m4v|webm|mkv|mov|avi|mpeg|mpg|3gp)(?:$|[?#])/i.test(lower)) return '.mp4';
      if (/\.(jpg|jpeg)(?:$|[?#])/i.test(lower)) return '.jpg';
      if (/\.(gif)(?:$|[?#])/i.test(lower)) return '.gif';
      if (/\.(webp)(?:$|[?#])/i.test(lower)) return '.webp';
      return '.bin';
    })();
    const finalNameBase = safeBase.toLowerCase().endsWith(detectedExt.toLowerCase()) ? safeBase : safeBase + detectedExt;
    const finalTarget = path.join(dlDir, finalNameBase);
    const rawName = finalTarget + '.part';
    let offset = 0;
    let totalLen = 0;
    try {
      if (fs.existsSync(rawName)) offset = totalLen = fs.statSync(rawName).size;
    } catch {}
    let output;
    try {
      ACTIONS.emit('dl-progress', { id, url, pct: 0, done: 0, total: 1, speed: 0 });
      ACTIONS.emit('ytdlp-log', 'Descargando: ' + url.substring(0, 100));
      let expectedTotal = 0;
      let lastSpeedT = t0;
      let lastSpeedBytes = offset;
      while (true) {
        if (entry.state === 'cancelled') throw new Error('Cancelado por el usuario');
        if (entry.state === 'paused') { await new Promise(r => setTimeout(r, 250)); continue; }
        const headers = { ...extraHeaders };
        if (offset > 0) headers['Range'] = `bytes=${offset}-`;
        const res = await DownloadsFetch.chromiumFetch(url, headers, entry.controller.signal);
        const ct = res.headers.get('content-type') || '?';
        const cl = parseInt(res.headers.get('content-length') || '0');
        if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} (${ct})`);
        const rangeTotal = (res.headers.get('content-range') || '').match(/\/(\d+)$/);
        expectedTotal = res.status === 206 && rangeTotal ? Number(rangeTotal[1]) : cl;
        if (res.status === 200 && offset > 0) {
          // El servidor ignoró Range → reiniciar desde cero
          if (output) { output.close(); output = null; }
          fs.writeFileSync(rawName, Buffer.alloc(0));
          totalLen = 0; offset = 0;
        }
        if (!output) output = fs.createWriteStream(rawName, { flags: offset > 0 ? 'a' : 'w' });
        ACTIONS.emit('ytdlp-log', `Respuesta: HTTP ${res.status} | Type: ${ct} | Length: ${cl}`);
        const reader = res.body.getReader();
        try {
          while (true) {
            if (entry.state === 'cancelled') throw new Error('Cancelado por el usuario');
            if (entry.state === 'paused') throw new DownloadsRegistry.PauseSignal();
            const { done, value } = await reader.read();
            if (done) break;
            if (!output.write(Buffer.from(value))) await new Promise(resolve => output.once('drain', resolve));
            totalLen += value.length;
            offset = totalLen;
            const now = Date.now();
            if (now - lastSpeedT > 500) {
              const speed = Math.round((totalLen - lastSpeedBytes) / 1024 / ((now - lastSpeedT) / 1000));
              lastSpeedT = now; lastSpeedBytes = totalLen;
              const pct = expectedTotal > 0 ? Math.round(totalLen / expectedTotal * 100) : 0;
              ACTIONS.emit('dl-progress', { id, url, pct, done: totalLen, total: expectedTotal, speed, kind: 'file' });
            }
          }
        } catch (err) {
          await reader.cancel().catch(() => {});
          if (err instanceof DownloadsRegistry.PauseSignal || entry.state === 'paused') continue;
          if (entry.state === 'cancelled') throw new Error('Cancelado por el usuario');
          throw err;
        }
        break; // stream completo
      }
      if (totalLen === 0) throw new Error('Servidor devolvió 0 bytes');
      await new Promise((resolve, reject) => output.end(error => error ? reject(error) : resolve()));
      if (fs.existsSync(finalTarget)) try { fs.unlinkSync(finalTarget); } catch {}
      fs.renameSync(rawName, finalTarget);
      const resultPath = finalTarget;
      const size = (totalLen / 1048576).toFixed(1);
      ACTIONS.emit('dl-complete', { id, url, file: resultPath, size, secs: ((Date.now()-t0)/1000).toFixed(1), filename: path.basename(resultPath) });
      ACTIONS.emit('ytdlp-log', `✓ Descargado: ${resultPath} (${size} MB)`);
      return { ok: true, path: resultPath, size: totalLen, converted: false };
    } catch (e) {
      if (output && !output.closed) output.destroy();
      const cancelled = entry.state === 'cancelled';
      ACTIONS.emit('dl-error', { id, url, error: cancelled ? 'Cancelado' : e.message, cancelled });
      ACTIONS.emit('ytdlp-log', (cancelled ? '✗ Cancelado: ' : '✗ Error: ') + e.message);
      return { error: e.message };
    } finally {
      DownloadsRegistry.dlRegistry.delete(id);
    }
  });
}

module.exports = { registerFileDownloadIpc };
