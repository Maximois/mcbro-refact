'use strict';
/**
 * MC Browser -- src/main/downloads/hls.js
 *
 * La descarga HLS: manifiesto, eleccion de variante, segmentos, AES-128,
 * reanudacion y el canal `dl-hls`.
 *
 * -----------------------------------------------------------------------------
 * LO QUE ESTA Y LO QUE NO
 * -----------------------------------------------------------------------------
 * Aqui: los siete helpers puros del manifiesto (`resolveUrl`,
 * `pickBestHlsVariant`, `parseHlsSegmentUrls`, `hlsSegmentIv`,
 * `decryptAes128Segment`, `loadHlsEncryption`, `downloadSegment`), la
 * escritura a disco (`writeHlsChunk`, `flushHlsOutput`) y el handler `dl-hls`.
 *
 * NO: la descarga de bytes de un archivo plano. Eso es `file.js`, que no usa
 * ffmpeg. Aqui SI hace falta: `dl-hls` deja un `.part.ts` que hay que remuxar a
 * MP4, y de eso se encarga `ffmpeg.js` (paso 18).
 *
 * -----------------------------------------------------------------------------
 * LA INYECCION TEMPORAL YA NO EXISTE
 * -----------------------------------------------------------------------------
 * Este modulo usaba `registerHlsIpc({ finalizeMediaFile })` porque
 * `finalizeMediaFile` vivia en `main.js`, e importarlo habria sido circular.
 * Era deuda con fecha segun el criterio 5.14, y el paso 18 la pago:
 *
 * ```js
 * const Ffmpeg = require('./ffmpeg');
 * registerHlsIpc();
 * ```
 *
 * Ahora los dos modulos del mismo directorio se requieren directamente y
 * `registerHlsIpc()` no recibe nada. Hay un test que lo fija, para que nadie
 * reintroduzca el parametro pensando que hacia falta.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- un segmento que falla CANCELA la descarga entera
 * -----------------------------------------------------------------------------
 * ```js
 * throw new Error(`Fallaron ${failedSegments} segmentos HLS; conversion cancelada
 *                   para evitar un archivo corrupto`);
 * ```
 *
 * No se salta el segmento y se sigue. Un `.mp4` con un agujero en medio se abre,
 * se ve el fallo en un punto y--peor-- el usuario no sabe si es que le faltaba
 * un trozo o que el archivo esta mal. Preferimos que no haya archivo.
 *
 * El `.part.ts` se queda en disco para que el usuario pueda mirar que tiene, y
 * el mensaje de error dice exactamente eso.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- la reanudacion solo existe para VOD
 * -----------------------------------------------------------------------------
 * ```js
 * const isVodPlaylist = /^\s*#EXT-X-ENDLIST\s*$/im.test(mediaText);
 * const resumeState = isVodPlaylist ? loadHlsResumeState(...) : null;
 * ```
 *
 * Un directo no tiene `#EXT-X-ENDLIST`, y sus segmentos se desplazan solos: el
 * segmento 40 de hace un segundo no es el segmento 40 de ahora. Reanudar por
 * indice en un stream en vivo produciria un archivo con segmentos de dos momentos
 * distintos, sin ningun error.
 *
 * Por eso el estado (`fingerprint`, `completedSegments`, `bytes`) solo se escribe
 * en playlists VOD. En un directo no hay nada que reanudar, y no es un fallo.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 3 -- el fingerprint descarta la reanudacion si el manifiesto cambio
 * -----------------------------------------------------------------------------
 * `fingerprintHlsPlaylist(playlistUrl, mediaText)` resume el manifiesto a una
 * huella. Si la huella no coincide, `loadHlsResumeState` devuelve `null` y el
 * `.part.ts` se borra.
 *
 * Sin esto, pausar un directo largo, esperar a que el servidor rotase la
 * playlist y reanudar metiria segmentos de dos manifiestos distintos en el mismo
 * archivo. Es el mismo bug que la trampa 2, pero por la puerta de atrás.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 4 -- el IV se deriva del numero de secuencia, y va en big-endian
 * -----------------------------------------------------------------------------
 * ```js
 * const iv = Buffer.alloc(16, 0);
 * iv.writeBigUInt64BE(seq, 8);   // <- en el offset 8, big-endian
 * ```
 *
 * Cuando el manifiesto no trae `IV=0x...`, la spec HLS dice que el IV es el
 * numero de secuencia del segmento, en big-endian, dentro de 16 bytes de cero.
 * O sea: 8 bytes de relleno a la izquierda y el numero a partir del byte 8.
 *
 * Si se escribe little-endian, o en el offset 0, el archivo descifrado sale con
 * ruido y **no hay ningun error**: el decipher funciona, devuelve bytes, y lo
 * unico que se ve es que el video sale a saltos. El test fija las dos cosas.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 5 -- `setAutoPadding(false)` en el decipher
 * -----------------------------------------------------------------------------
 * Los segmentos HLS no vienen rellenos hasta el tamano de bloque. Con
 * auto-padding activado, `decipher.final()` lanza en cuanto el ultimo bloque no
 * cuadra, y el error aparece como "fallo de red" en un bucle que en realidad
 * descifro bien.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 6 -- `dl-hls` tambien guarda archivos que NO son HLS
 * -----------------------------------------------------------------------------
 * Si el cuerpo que devuelve la URL no contiene `#EXTM3U`, se guarda como
 * archivo directo y se avisa con `descargado (TS original)`. Es a proposito: el
 * renderer manda aqui cualquier URL y este canal decide. La comprobacion esta al
 * principio, antes de crear nada en disco.
 *
 * -----------------------------------------------------------------------------
 * LO QUE NO SE PUEDE TESTEAR AUN
 * -----------------------------------------------------------------------------
 * Los siete helpers del manifiesto son funciones puras y se PODRIAN testear de
 * verdad: `pickBestHlsVariant` eligiendo la variante de mayor resolucion, o
 * `hlsSegmentIv` calculando el IV a mano. Pero este archivo hace
 * `require('electron')` al cargarse, asi que ningun test de node plano lo puede
 * importar y todos tienen que leer el fuente.
 *
 * La solucion seria partir los puros en `hls-parse.js`, sin electron. No se hizo
 * porque el plan fija la estructura destino y anadir un archivo aqui seeria
 * desviarse de ella. Es el siguiente paso natural si alguien quiere probar el
 * criptograma de verdad en vez de leerlo.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ipcMain, app } = require('electron');
const { fingerprintHlsPlaylist, loadHlsResumeState, saveHlsResumeState } = require('../../../lib/hls-resume');
const { ACTIONS } = require('../runtime');
const { CFG } = require('../config');
const DownloadsRegistry = require('./registry');
const DownloadsFetch = require('./fetch');
const Ffmpeg = require('./ffmpeg');

// Inyeccion temporal, paso 18. Ver la cabecera.
function registerHlsIpc() {
  function resolveUrl(base, segment) {
    if (segment.startsWith('http://') || segment.startsWith('https://')) return segment;
    try {
      const u = new URL(base);
      if (segment.startsWith('/')) return u.origin + segment;
      return u.origin + u.pathname.replace(/\/[^/]*$/, '/') + segment;
    } catch { return segment; }
  }

  async function downloadSegment(url, referer, signal) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await DownloadsFetch.chromiumFetch(url, referer ? { 'Referer': referer } : {}, signal);
        if (!res.ok) throw new Error(`HTTP ${res.status} en segmento`);
        return Buffer.from(await res.arrayBuffer());
      } catch (error) {
        lastError = error;
        if (signal?.aborted || attempt === 2) break;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw lastError || new Error('No se pudo descargar el segmento');
  }

  function pickBestHlsVariant(manifestText, baseUrl) {
    let bestUrl = baseUrl;
    let bestResolution = -1;
    let bestBandwidth = -1;
    const lines = manifestText.replace(/\r/g, '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const info = lines[i].trim();
      if (!info.startsWith('#EXT-X-STREAM-INF:')) continue;
      let uri = '';
      for (let next = i + 1; next < lines.length; next++) {
        const candidate = lines[next].trim();
        if (!candidate || candidate.startsWith('#')) continue;
        uri = candidate;
        break;
      }
      if (!uri) continue;
      const attributes = info.slice('#EXT-X-STREAM-INF:'.length);
      const resolutionMatch = attributes.match(/(?:^|,)RESOLUTION=(\d+)x(\d+)(?=,|$)/i);
      const bandwidthMatch = attributes.match(/(?:^|,)BANDWIDTH=(\d+)(?=,|$)/i);
      const resolution = resolutionMatch ? Number(resolutionMatch[1]) * Number(resolutionMatch[2]) : 0;
      const bandwidth = bandwidthMatch ? Number(bandwidthMatch[1]) : 0;
      if (resolution > bestResolution || (resolution === bestResolution && bandwidth > bestBandwidth)) {
        bestResolution = resolution;
        bestBandwidth = bandwidth;
        bestUrl = resolveUrl(baseUrl, uri);
      }
    }
    return bestResolution >= 0 || bestBandwidth >= 0 ? bestUrl : baseUrl;
  }

  function parseHlsSegmentUrls(mediaText, playlistUrl) {
    const urls = [];
    for (const line of mediaText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (/\.m3u8(\?|#|$)/i.test(trimmed)) continue;
      urls.push(resolveUrl(playlistUrl, trimmed));
    }
    return urls;
  }

  function hlsSegmentIv(ivHex, mediaSeq, segmentIndex) {
    if (ivHex) {
      const iv = Buffer.alloc(16, 0);
      const parsed = Buffer.from(ivHex, 'hex');
      parsed.copy(iv, Math.max(0, 16 - parsed.length));
      return iv;
    }
    const iv = Buffer.alloc(16, 0);
    const seq = BigInt(mediaSeq + segmentIndex);
    iv.writeBigUInt64BE(seq, 8);
    return iv;
  }

  function decryptAes128Segment(buffer, key, iv) {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(buffer), decipher.final()]);
  }

  async function loadHlsEncryption(mediaText, playlistUrl, pageUrl, signal) {
    const keyLine = mediaText.split('\n').find(l => /^#EXT-X-KEY:/i.test(l));
    if (!keyLine) return null;
    const attrs = keyLine.slice('#EXT-X-KEY:'.length);
    const method = (attrs.match(/METHOD=([^,]+)/i) || [])[1]?.trim().toUpperCase();
    if (!method || method === 'NONE') return null;
    if (method !== 'AES-128') {
      throw new Error(`Stream cifrado con ${method} — no soportado. Probá con yt-dlp.`);
    }
    const uriMatch = attrs.match(/URI="([^"]+)"/i);
    if (!uriMatch) throw new Error('Manifiesto HLS cifrado sin URI de clave');
    const ivHex = (attrs.match(/IV=0x([0-9a-fA-F]+)/i) || [])[1] || null;
    const keyUrl = resolveUrl(playlistUrl, uriMatch[1]);
    const referer = pageUrl || new URL(playlistUrl).origin + '/';
    const keyBuf = await downloadSegment(keyUrl, referer, signal);
    if (!keyBuf || keyBuf.length !== 16) throw new Error('Clave AES-128 inválida o inaccesible');
    const mediaSeq = parseInt((mediaText.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i) || [])[1] || '0', 10);
    return { key: keyBuf, ivHex, mediaSeq };
  }

  function writeHlsChunk(output, buffer) {
    return new Promise((resolve, reject) => {
      output.write(buffer, error => error ? reject(error) : resolve());
    });
  }

  function flushHlsOutput(output) {
    return new Promise((resolve, reject) => {
      fs.fsync(output.fd, error => error ? reject(error) : resolve());
    });
  }

  ipcMain.handle('dl-hls', async (e, { id, url, name, pageUrl }) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      const error = 'URL HLS inválida o vacía';
      ACTIONS.emit('dl-error', { id, url: url || '', error });
      ACTIONS.emit('ytdlp-log', '✗ Error HLS: ' + error);
      return { error };
    }
    const dlDir = CFG.downloadDir || app.getPath('downloads');
    if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
    const t0 = Date.now();
    const extraHeaders = DownloadsFetch.mediaRequestHeaders(pageUrl, url);
    const entry = DownloadsRegistry.dlRegister(id, url, 'hls');
    let hlsOutput;
    let hlsResumePath = '';
    try {
      ACTIONS.emit('dl-progress', { id, url, pct: 0, done: 0, total: 1, speed: 0 });
      ACTIONS.emit('ytdlp-log', 'Iniciando descarga HLS: ' + url.substring(0, 80));
      const res = await DownloadsFetch.chromiumFetch(url, extraHeaders, entry.controller.signal);
      if (!res.ok) throw new Error(`HTTP ${res.status} al cargar playlist HLS`);
      const raw = Buffer.from(await res.arrayBuffer());
      if (raw.length === 0) throw new Error('Servidor devolvió 0 bytes (sesión inválida?)');
      const manifestText = raw.toString('utf8');
      if (!manifestText.includes('#EXTM3U')) {
        // No es HLS, guardar como archivo directo
        const fname = path.join(dlDir, (name || 'media_' + Date.now()) + '.mp4');
        const rawName = fname + '.part.ts';
        fs.writeFileSync(rawName, raw);
        const finalized = await Ffmpeg.finalizeMediaFile(rawName, fname);
        const resultPath = finalized.path;
        const size = (raw.length / 1048576).toFixed(1);
        ACTIONS.emit('dl-complete', { id, url, file: resultPath, size, filename: path.basename(resultPath) });
        const mode = finalized.remuxed ? 'remux MP4' : finalized.converted ? 'recodificado MP4 H.264/AAC' : 'TS original';
        ACTIONS.emit('ytdlp-log', `✓ Descargado (${mode}): ${resultPath} (${size} MB)`);
        if (!finalized.converted) ACTIONS.emit('ytdlp-log', '⚠ ' + finalized.error + '; se conservó el archivo original');
        return { ok: true, path: resultPath, size: raw.length, converted: finalized.converted };
      }
      ACTIONS.emit('ytdlp-log', 'Manifiesto HLS detectado, descargando segmentos...');

      let playlistUrl = url;
      if (/#EXT-X-STREAM-INF/i.test(manifestText)) {
        playlistUrl = pickBestHlsVariant(manifestText, url);
      }

      const playlistHeaders = DownloadsFetch.mediaRequestHeaders(pageUrl, playlistUrl);
      const mediaText = playlistUrl === url ? manifestText
        : await (async () => {
          const variant = await DownloadsFetch.chromiumFetch(playlistUrl, playlistHeaders, entry.controller.signal);
          if (!variant.ok) throw new Error(`HTTP ${variant.status} al cargar variante HLS`);
          return Buffer.from(await variant.arrayBuffer()).toString('utf8');
        })();
      if (!mediaText.includes('#EXTM3U')) throw new Error('Playlist de media inválida');

      const encryption = await loadHlsEncryption(mediaText, playlistUrl, pageUrl, entry.controller.signal);
      if (encryption) ACTIONS.emit('ytdlp-log', 'Cifrado AES-128 detectado — descifrando segmentos...');

      const resolved = parseHlsSegmentUrls(mediaText, playlistUrl);
      if (!resolved.length) throw new Error('No se encontraron segmentos');
      const fname = path.join(dlDir, (name || 'stream_' + Date.now()) + '.mp4');
      const rawName = fname + '.part.ts';
      hlsResumePath = rawName + '.resume.json';
      const mapMatch = mediaText.match(/#EXT-X-MAP:[^\n]*URI="([^"]+)"/i);
      const isVodPlaylist = /^\s*#EXT-X-ENDLIST\s*$/im.test(mediaText);
      const fingerprint = fingerprintHlsPlaylist(playlistUrl, mediaText);
      const resumeState = isVodPlaylist
        ? loadHlsResumeState(hlsResumePath, rawName, fingerprint, resolved.length)
        : null;
      if (!resumeState) try { fs.unlinkSync(hlsResumePath); } catch {}
      const completedSegments = resumeState?.completedSegments || 0;
      let downloadedBytes = resumeState?.bytes || 0;
      let initIncluded = !!resumeState?.initIncluded;
      if (resumeState) fs.truncateSync(rawName, downloadedBytes);
      else downloadedBytes = 0;
      hlsOutput = fs.createWriteStream(rawName, { flags: resumeState && downloadedBytes > 0 ? 'a' : 'w' });
      let failedSegments = 0;
      if (mapMatch && !initIncluded) {
        const initUrl = resolveUrl(playlistUrl, mapMatch[1]);
        const init = await downloadSegment(initUrl, pageUrl || new URL(playlistUrl).origin + '/', entry.controller.signal);
        await writeHlsChunk(hlsOutput, init);
        downloadedBytes += init.length;
        initIncluded = true;
        if (isVodPlaylist) {
          await flushHlsOutput(hlsOutput);
          saveHlsResumeState(hlsResumePath, {
            fingerprint, completedSegments, bytes: downloadedBytes, initIncluded, updatedAt: Date.now()
          });
        }
      }
      const concurrency = 4;
      const initialPct = Math.round(completedSegments / resolved.length * 100);
      ACTIONS.emit('dl-progress', { id, url, pct: initialPct, done: completedSegments, total: resolved.length, speed: 0, kind: 'hls' });
      for (let i = completedSegments; i < resolved.length; i += concurrency) {
        const st = await DownloadsRegistry.dlWaitIfPaused(id);
        if (st === 'cancelled') throw new Error('Cancelado por el usuario');
        const batch = resolved.slice(i, i + concurrency);
        const referer = pageUrl || new URL(playlistUrl).origin + '/';
        const results = await Promise.all(batch.map((segmentUrl, batchIdx) => downloadSegment(segmentUrl, referer, entry.controller.signal).catch(() => null).then(buf => {
          if (!buf || !encryption) return buf;
          try {
            const segIndex = i + batchIdx;
            const iv = hlsSegmentIv(encryption.ivHex, encryption.mediaSeq, segIndex);
            return decryptAes128Segment(buf, encryption.key, iv);
          } catch {
            return null;
          }
        })));
        if (results.some(buffer => !buffer)) {
          failedSegments += results.filter(buffer => !buffer).length;
          throw new Error(`Fallaron ${failedSegments} segmentos HLS; conversión cancelada para evitar un archivo corrupto`);
        }
        for (const buffer of results) {
          await writeHlsChunk(hlsOutput, buffer);
          downloadedBytes += buffer.length;
        }
        const batchEnd = Math.min(i + batch.length, resolved.length);
        if (isVodPlaylist) {
          await flushHlsOutput(hlsOutput);
          saveHlsResumeState(hlsResumePath, {
            fingerprint, completedSegments: batchEnd, bytes: downloadedBytes, initIncluded, updatedAt: Date.now()
          });
        }
        const pct = Math.round(batchEnd / resolved.length * 100);
        const elapsed = (Date.now() - t0) / 1000;
        ACTIONS.emit('dl-progress', { id, url, pct, done: batchEnd, total: resolved.length, speed: Math.round(downloadedBytes / 1024 / Math.max(elapsed, 0.1)), kind: 'hls' });
      }

      await new Promise((resolve, reject) => { hlsOutput.end(error => error ? reject(error) : resolve()); });
      ACTIONS.emit('ytdlp-log', 'Descarga completa — convirtiendo a MP4...');
      const finalized = await Ffmpeg.finalizeMediaFile(rawName, fname, mapMatch ? 'mp4' : 'mpegts');
      const resultPath = finalized.path;
      try { fs.unlinkSync(hlsResumePath); } catch {}
      const size = (downloadedBytes / 1048576).toFixed(1);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      ACTIONS.emit('dl-complete', { id, url, file: resultPath, size, secs, filename: path.basename(resultPath) });
      const mode = finalized.remuxed ? 'remux MP4' : finalized.converted ? 'recodificado MP4 H.264/AAC' : 'TS original';
      ACTIONS.emit('ytdlp-log', `✓ HLS descargado (${mode}): ${resultPath} (${size} MB, ${resolved.length} segs, ${secs}s)`);
      if (!finalized.converted) ACTIONS.emit('ytdlp-log', '⚠ ' + finalized.error + '; se conservó el archivo original');
      return { ok: true, path: resultPath, size: downloadedBytes, converted: finalized.converted };
    } catch (e) {
      if (hlsOutput && !hlsOutput.closed) hlsOutput.destroy();
      const cancelled = entry.state === 'cancelled';
      ACTIONS.emit('dl-error', { id, url, error: cancelled ? 'Cancelado' : e.message, cancelled });
      ACTIONS.emit('ytdlp-log', (cancelled ? '✗ Cancelado: ' : '✗ Error HLS: ') + e.message);
      return { error: e.message };
    } finally {
      DownloadsRegistry.dlRegistry.delete(id);
    }
  });
}

module.exports = { registerHlsIpc };
