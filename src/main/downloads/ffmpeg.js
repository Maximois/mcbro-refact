'use strict';
/**
 * MC Browser -- src/main/downloads/ffmpeg.js
 *
 * Buscar FFmpeg, instalarlo si falta, y convertir lo descargado a MP4.
 *
 * -----------------------------------------------------------------------------
 * LO QUE ESTA Y LO QUE NO
 * -----------------------------------------------------------------------------
 * Aqui: las once funciones de ffmpeg y el directorio donde se instala.
 *
 * NO: la descarga. `hls.js` y `file.js` traen los bytes; este modulo solo
 * decide que hacer con ellos cuando ya estan en disco.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- `FFMPEG_DIR` se llama, no se cachea
 * -----------------------------------------------------------------------------
 * ```js
 * const FFMPEG_DIR = () => path.join(app.getPath('userData'), 'ffmpeg');
 * ```
 *
 * Es una flecha, no una constante ya resuelta. `app.getPath('userData')` se
 * evalua cada vez. Esto importa porque main.js cambia el userData al perfil de
 * desarrollo en la linea 28, ANTES de los requires de la linea 42 en adelante:
 * si alguien "optimiza" esto a `const FFMPEG_DIR = path.join(...)`, el modulo
 * se evaluaria al cargarse y FFmpeg se instalaria en el perfil equivocado.
 *
 * Es exactamente el mismo bug que se corrigio para las rutas [DATA], y por eso
 * hay un test que fija que sigue siendo una flecha.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- `findFfprobe` no busca ffprobe, lo deduce de ffmpeg
 * -----------------------------------------------------------------------------
 * ```js
 * const candidate = path.join(path.dirname(ffmpeg), 'ffprobe.exe');
 * ```
 *
 * Toma el directorio del ffmpeg encontrado y mira ahi al lado. No hay busqueda
 * propia para ffprobe.
 *
 * La consecuencia no es obvia: si el usuario tiene ffmpeg en el PATH pero el
 * ffprobe no esta a su lado, `inspectMediaFile` devuelve `null`, y entonces
 * `finalizeMediaFile` ve `streams` vacio, no detecta ni video ni audio, y cae
 * directo en `transcodeToMp4`. Es decir: sin ffprobe TODO se recodifica, que es
 * lentisimo y pierde calidad, sin avisar de nada. Con video h264+aac deberia
 * haber sido un remux de un segundo.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 3 -- remux primero, recodificar solo si no queda otra cosa
 * -----------------------------------------------------------------------------
 * `-c copy` no toca los bytes: es rapidisimo y no pierde calidad. Pero solo vale
 * si el video es h264 y el audio aac, que es lo que un MP4 admite. Si no, copiar
 * los bytes produce un MP4 que algunos reproductores no abren.
 *
 * Por eso `finalizeMediaFile` pregunta antes, con ffprobe:
 *
 * | ffprobe dice                        | Que hace                        |
 * | ----------------------------------- | ------------------------------- |
 * | video h264, y audio aac o sin audio | `remuxToMp4`, con `-c copy`     |
 * | video, pero otro codec              | `transcodeToMp4` con libx264    |
 * | no hay video (es audio)             | `transcodeToMp4` con libx264    |
 * | ffprobe no esta (TRAMPA 2)          | `transcodeToMp4`, sin saber     |
 *
 * Y en los dos flags de ffmpeg hay un `-map 0:a:0?` con interrogante: el `?` de
 * ffmpeg significa "este flujo es opcional". Sin el, un video sin pista de audio
 * haria fallar el comando entero.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 4 -- el fallback deja el archivo, aunque no sea MP4
 * -----------------------------------------------------------------------------
 * Si no hay FFmpeg, o si la recodificacion falla, NO se pierde la descarga:
 *
 * ```js
 * const fallbackPath = finalPath.replace(/\.mp4$/i, '.ts');
 * fs.renameSync(rawPath, fallbackPath);
 * return { path: fallbackPath, converted: false, error: ... };
 * ```
 *
 * Se renombra a `.ts` y se devuelve `converted: false` CON el error. El
 * renderer usa ese `converted` para lo que pone en la lista, asi que el usuario
 * ve el archivo y ve que no se pudo convertir. Perder la descarga entera porque
 * falte un ejecutable seria mucho peor.
 *
 * Ojo con el `/\.source$/i` de la primera rama: hoy NADIE produce un `.source`
 * (`hls.js` usa `.part.ts`). Se deja como esta, porque es el unico sitio donde
 * se acepta que un temporal podria venir con esa extension, y borrarlo a ojo
 * seria exactamente el tipo de limpieza que rompio el detector de `file.js`.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 5 -- `isUsableMp4` protege contra "salio bien pero no hay archivo"
 * -----------------------------------------------------------------------------
 * `isUsableMp4` exige mas de 1024 bytes. Sin ella, un ffmpeg que sale con
 * codigo 0 pero no escribio nada (disco lleno, ruta mala) contaria como
 * conversion correcta, y `finalizeMediaFile` borraria el `.part` original
 * thinking que ya esta todo hecho.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 6 -- instalar el portable solo funciona en Windows
 * -----------------------------------------------------------------------------
 * En cualquier otra plataforma devuelve un error con las instrucciones del
 * gestor de paquetes. Y la extraccion usa `powershell.exe` con
 * `Expand-Archive`, escapando las comillas simples a la PowerShell
 * (`replace(/'/g, "''")`). Los directorios temporales llevan `Date.now()` en el
 * nombre para que dos instalaciones simultaneas no se pisen.
 *
 * Y `execFile` se sigue pidiendo DENTRO de la funcion, no arriba del todo: es un
 * require perezoso a proposito, para no cargar child_process si nunca se instala
 * nada. Se deja asi.
 *
 * -----------------------------------------------------------------------------
 * LO QUE ESTA FUERA
 * -----------------------------------------------------------------------------
 * `ffmpeg-check` e `ffmpeg-install` (canales IPC) se quedan en main.js: son de
 * una sola linea y MainWindow los necesita.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const { ACTIONS } = require('../runtime');

const FFMPEG_DIR = () => path.join(app.getPath('userData'), 'ffmpeg');

function findFfmpeg() {
  const pathCandidates = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map(dir => path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(FFMPEG_DIR(), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    path.join(app.getPath('userData'), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    ...pathCandidates
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  return null;
}

function findFfprobe() {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return null;
  const candidate = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  return fs.existsSync(candidate) ? candidate : null;
}

async function installFfmpegPortable() {
  const destDir = FFMPEG_DIR();
  const ffmpegExe = path.join(destDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(ffmpegExe)) return { ok: true, path: ffmpegExe };
  if (process.platform !== 'win32') {
    return {
      ok: false,
      error: 'FFmpeg no encontrado. Instalalo con tu gestor de paquetes (apt install ffmpeg, brew install ffmpeg).'
    };
  }
  const zipUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
  const zipPath = path.join(app.getPath('temp'), `mc-ffmpeg-${Date.now()}.zip`);
  try {
    ACTIONS.emit?.('ytdlp-log', 'Descargando FFmpeg (~90 MB, primera vez)...');
    const res = await fetch(zipUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} al descargar FFmpeg`);
    fs.mkdirSync(destDir, { recursive: true });
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(zipPath, buf);
    ACTIONS.emit?.('ytdlp-log', 'Extrayendo FFmpeg...');
    const { execFile } = require('child_process');
    const extractDir = path.join(app.getPath('temp'), `mc-ffmpeg-extract-${Date.now()}`);
    fs.mkdirSync(extractDir, { recursive: true });
    await new Promise((resolve, reject) => {
      execFile('powershell.exe', [
        '-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
      ], { windowsHide: true }, (err) => err ? reject(err) : resolve());
    });
    const entries = fs.readdirSync(extractDir, { withFileTypes: true });
    const root = entries.find(e => e.isDirectory() && /ffmpeg/i.test(e.name))?.name || entries[0]?.name;
    if (!root) throw new Error('Estructura del ZIP de FFmpeg inesperada');
    const binDir = path.join(extractDir, root, 'bin');
    if (!fs.existsSync(binDir)) throw new Error('No se encontró carpeta bin en el ZIP');
    for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
      const src = path.join(binDir, name);
      const dst = path.join(destDir, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    }
    try { fs.unlinkSync(zipPath); } catch {}
    if (!fs.existsSync(ffmpegExe)) throw new Error('No se pudo extraer ffmpeg.exe');
    ACTIONS.emit?.('ytdlp-log', '✓ FFmpeg instalado en ' + destDir);
    return { ok: true, path: ffmpegExe };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      guide: 'Descargá FFmpeg Essentials desde https://www.gyan.dev/ffmpeg/builds/ y agregá ffmpeg.exe al PATH o a ' + destDir
    };
  }
}

async function ensureFfmpegAvailable() {
  if (findFfmpeg()) return { ok: true, path: findFfmpeg() };
  return installFfmpegPortable();
}

function inspectMediaFile(inputPath, inputFormat) {
  const ffprobe = findFfprobe();
  if (!ffprobe) return Promise.resolve(null);
  return new Promise(resolve => {
    const args = ['-v', 'error'];
    if (inputFormat) args.push('-f', inputFormat);
    args.push('-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', inputPath);
    const proc = spawn(ffprobe, args, { windowsHide: true });
    let output = '';
    proc.stdout.on('data', data => { output += data.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', code => {
      if (code !== 0) return resolve(null);
      try { resolve(JSON.parse(output)); } catch { resolve(null); }
    });
  });
}

function remuxToMp4(inputPath, outputPath, inputFormat) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return Promise.resolve({ ok: false, error: 'FFmpeg no está instalado o no está en PATH' });
  const format = resolveMediaInputFormat(inputPath, inputFormat);
  return new Promise(resolve => {
    const inputArgs = format ? ['-f', format, '-probesize', '50M', '-analyzeduration', '100M'] : ['-probesize', '50M', '-analyzeduration', '100M'];
    // `h264_redundant_pps` quita los SPS/PPS repetidos dentro de los samples. Sin
    // el, fuentes que los emiten en banda (habitual en CDNs de streaming) salen
    // con el `avcC` desincronizado: el primer sample queda corrupto, el MP4 se
    // escribe sin tabla de sync (`stss`) y el archivo no tiene ni un keyframe.
    // El sintoma es un MP4 que ffprobe da por valido pero que no decodifica.
    const proc = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...inputArgs, '-i', inputPath,
      '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-bsf:v', 'h264_redundant_pps', '-bsf:a', 'aac_adtstoasc',
      '-fflags', '+genpts+discardcorrupt', '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart', '-f', 'mp4', outputPath], { windowsHide: true });
    let error = '';
    proc.stderr.on('data', data => { error += data.toString(); });
    proc.on('error', e => resolve({ ok: false, error: `No se pudo iniciar FFmpeg: ${e.message}` }));
    proc.on('close', code => {
      if (code !== 0 && error.trim()) ACTIONS.emit?.('ytdlp-log', '[FFmpeg] ' + error.trim().split('\n').slice(-3).join(' '));
      resolve(code === 0 ? { ok: true } : {
        ok: false,
        error: error.trim() || `FFmpeg terminó con código ${code}`
      });
    });
  });
}

function transcodeToMp4(inputPath, outputPath, inputFormat) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return Promise.resolve({ ok: false, error: 'FFmpeg no está instalado o no está en PATH' });
  const format = resolveMediaInputFormat(inputPath, inputFormat);
  return new Promise(resolve => {
    const inputArgs = format ? ['-f', format] : [];
    const proc = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-probesize', '50M', '-analyzeduration', '100M',
      ...inputArgs, '-i', inputPath,
      '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=ceil(iw/2)*2:ceil(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath], { windowsHide: true });
    let error = '';
    proc.stderr.on('data', data => { error += data.toString(); });
    proc.on('error', e => resolve({ ok: false, error: `No se pudo iniciar FFmpeg: ${e.message}` }));
    proc.on('close', code => {
      if (code !== 0 && error.trim()) ACTIONS.emit?.('ytdlp-log', '[FFmpeg] ' + error.trim().split('\n').slice(-3).join(' '));
      resolve(code === 0 ? { ok: true } : {
        ok: false, error: error.trim() || `FFmpeg terminó con código ${code}`
      });
    });
  });
}

function isUsableMp4(filePath) {
  try { return fs.existsSync(filePath) && fs.statSync(filePath).size > 1024; } catch { return false; }
}

function detectMediaInputFormat(filePath) {
  const lower = String(filePath || '').toLowerCase();
  if (/\.(?:ts|m2ts|mts)(?:\.|$)/i.test(lower) || lower.endsWith('.part.ts')) return 'mpegts';
  try {
    const fd = fs.openSync(filePath, 'r');
    const sample = Buffer.alloc(65536);
    const length = fs.readSync(fd, sample, 0, sample.length, 0);
    fs.closeSync(fd);
    if (length < 4) return undefined;
    if (sample.subarray(4, 8).toString() === 'ftyp' || sample.subarray(4, 8).toString() === 'styp') return 'mp4';
    let tsHits = 0;
    for (let offset = 0; offset + 188 <= length; offset += 188) {
      if (sample[offset] === 0x47) tsHits++;
    }
    if (tsHits >= 3 || (length >= 1 && sample[0] === 0x47)) return 'mpegts';
  } catch {}
  return undefined;
}

function resolveMediaInputFormat(filePath, hint) {
  if (hint) return hint;
  return detectMediaInputFormat(filePath);
}

async function finalizeMediaFile(rawPath, finalPath, inputFormat) {
  if (!fs.existsSync(rawPath)) {
    return { path: rawPath.replace(/\.source$/i, '.ts'), converted: false, error: 'No se encontró el temporal descargado' };
  }
  const ffmpegReady = await ensureFfmpegAvailable();
  if (!ffmpegReady.ok) {
    const fallbackPath = finalPath.replace(/\.mp4$/i, '.ts');
    try {
      if (fs.existsSync(fallbackPath)) fs.unlinkSync(fallbackPath);
      fs.renameSync(rawPath, fallbackPath);
    } catch {}
    return { path: fallbackPath, converted: false, error: ffmpegReady.error + (ffmpegReady.guide ? ' — ' + ffmpegReady.guide : '') };
  }
  const detectedFormat = resolveMediaInputFormat(rawPath, inputFormat);
  const media = await inspectMediaFile(rawPath, detectedFormat);
  const streams = media?.streams || [];
  const hasVideo = streams.some(stream => stream.codec_type === 'video');
  const hasCompatibleVideo = streams.some(stream => stream.codec_type === 'video' && stream.codec_name === 'h264');
  const hasCompatibleAudio = streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac');
  if (hasVideo && hasCompatibleVideo && (!streams.some(stream => stream.codec_type === 'audio') || hasCompatibleAudio)) {
    const remuxed = await remuxToMp4(rawPath, finalPath, detectedFormat);
    if (remuxed.ok && isUsableMp4(finalPath)) {
      try { fs.unlinkSync(rawPath); } catch {}
      return { path: finalPath, converted: true, remuxed: true };
    }
    try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch {}
    ACTIONS.emit?.('ytdlp-log', '⚠ Remux MP4 falló, intentando recodificar...');
  } else if (hasVideo) {
    ACTIONS.emit?.('ytdlp-log', '⚠ Códec no compatible para remux directo, recodificando...');
  }
  const transcoded = await transcodeToMp4(rawPath, finalPath, detectedFormat);
  if (transcoded.ok) {
    try { fs.unlinkSync(rawPath); } catch {}
    return { path: finalPath, converted: true };
  }
  const fallbackPath = finalPath.replace(/\.mp4$/i, '.ts');
  try {
    if (fs.existsSync(fallbackPath)) fs.unlinkSync(fallbackPath);
    fs.renameSync(rawPath, fallbackPath);
  } catch { return { path: fallbackPath, converted: false, error: transcoded.error || 'No se pudo guardar el fallback' }; }
  return { path: fallbackPath, converted: false, error: transcoded.error || 'No se pudo convertir el archivo' };
}

module.exports = {
  FFMPEG_DIR,
  findFfmpeg,
  findFfprobe,
  installFfmpegPortable,
  ensureFfmpegAvailable,
  inspectMediaFile,
  remuxToMp4,
  transcodeToMp4,
  isUsableMp4,
  detectMediaInputFormat,
  resolveMediaInputFormat,
  finalizeMediaFile
};