'use strict';
/**
 * MC Browser -- tools/ytdlp.js
 *
 * yt-dlp: encontrarlo, instalarlo, y los canales `ytdlp-check`, `ytdlp-version`,
 * `ytdlp-install`, `ytdlp-analyze` y `ytdlp-download`.
 *
 * -----------------------------------------------------------------------------
 * LO QUE ESTA Y LO QUE NO
 * -----------------------------------------------------------------------------
 * Aqui: los cinco canales IPC, la busqueda del ejecutable, y el exporte de
 * cookies de la sesion a un archivo que yt-dlp pueda leer.
 *
 * NO: descargar el video. yt-dlp lo descarga el, como proceso aparte. Este
 * modulo solo le pasa las cookies, le dice donde guardar, y translates su salida.
 *
 * -----------------------------------------------------------------------------
 * POR QUE ESTA EN tools/ Y NO EN src/main/
 * -----------------------------------------------------------------------------
 * Porque lo dice el plan (paso 19, tabla de pasos). Se deja constancia de que
 * `tools/` hasta ahora era solo scripts de desarrollo (`boot-smoke.js`,
 * `*-smoke.js`), y que este modulo es codigo de PRODUCCION que ademas entra por
 * la puerta de atras: sus rutas son `../src/main/runtime` y `../src/main/config`,
 * mientras main.js lo carga con `require('./tools/ytdlp')`. Eso crea una
 * dependencia en las dos direcciones entre `tools/` y `src/main/`, que funciona
 * en Node pero no es la forma en que esta organizado el resto.
 *
 * Si algun dia se mueve a `src/main/tools/ytdlp.js`, el unico cambio real son
 * esas dos rutas. No se hace aqui porque cambiar la carpeta del plan es otra
 * decision.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- `findYtdlp` NO busca en el PATH
 * -----------------------------------------------------------------------------
 * ```js
 * for (const c of [path.join(app.getPath('userData'), 'yt-dlp.exe'), 'yt-dlp.exe', 'yt-dlp'])
 * ```
 *
 * Los dos ultimos parecen una busqueda en el PATH y no lo son: son rutas
 * RELATIVAS, que Node resuelve contra el directorio de trabajo del proceso. Si
 * el usuario tiene yt-dlp en el PATH pero no en su perfil ni en el CWD de la
 * app, no lo encuentra, y `ytdlp-check` responde false aunque el comando
 * `yt-dlp` funcione en una terminal.
 *
 * Ojo que esto es distinto del bloque de ffmpeg (`ffmpeg.js`), que si recorre el
 * PATH a mano. El contraste esta aqui para que no se "arregle" este con el
 * estilo del otro creyendo que es lo mismo.
 *
 * `ytdlpPath` es la cache entre llamadas, y se revalida con `fs.existsSync` en
 * cada uso. Por eso, si el usuario borra el ejecutable, la siguiente llamada lo
 * busca otra vez en vez de usar un caminho muerto.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- las cookies de sesion se exportan a un archivo EN CLARO
 * -----------------------------------------------------------------------------
 * yt-dlp corre como proceso aparte y no ve las cookies del navegador. Se las
 * exportamos al formato Netscape (`--cookies`), que es texto plano con las
 * sesiones de la persona dentro.
 *
 * | Donde | Que es |
 * | --- | --- |
 * | `session.fromPartition('persist:mc').cookies.get(...)` | las cookies de MC |
 * | `app.getPath('temp')/mc-ytdlp-cookies-<Date.now()>.txt` | el archivo, en claro |
 * | `cleanupYtdlpCookiesFile` en el `finally` | se borra pase lo que pase |
 *
 * El `finally` es lo que importa: sin el, un analyze que falla deja el archivo
 * con la sesion de la persona en el temporal. Y va en el `finally` y no en el
 * `catch` porque el camino feliz tambien tiene que borrar.
 *
 * Que el borrado sea `fs.unlink(file, () => {})` sin esperar es deliberado: no
 * bloquea la respuesta al renderer por un borrado. El precio es que si el
 * borrado falla, el archivo se queda, y no hay reintento. No hay forma de
 * arreglarlo sin cambiar el comportamiento observable, asi que se deja y se
 * escribe.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 3 -- para Instagram, Facebook, X y TikTok va la URL de la PAGINA
 * -----------------------------------------------------------------------------
 * Para esos sitios hay que pasarle a yt-dlp la URL de la pagina, no la URL de
 * stream ya extraida. El motivo esta en el comentario del codigo y es largo:
 * el extractor de yt-dlp sabe manejar el login y las URLs firmadas de cada
 * plataforma, y una URL de stream suelta no las lleva.
 *
 * ```js
 * if (isYtdlpNativeLoginHost(pageHost)) target = opts.pageUrl;
 * ```
 *
 * O sea que `opts.url` y `opts.pageUrl` no son sinónimos, y el que gana depende
 * del host. Cambiar el criterio es cambiar para que sitios descarga.
 *
 * Y las cookies se piden dos veces: primero para la pagina, y si eso no devuelve
 * nada, para el target. Una es para el caso normal y la otra para cuando no venia
 * `pageUrl`.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 4 -- `output.trim()` se supone que es SOLO la ruta
 * -----------------------------------------------------------------------------
 * ```js
 * '--print', 'after_move:filepath'
 * ...
 * resolve({ ok: true, path: output.trim() });
 * ```
 *
 * Se acumula todo stdout y se asume que contiene una unica linea: la ruta final
 * del archivo. Funciona porque el progreso de yt-dlp va a stderr, que aqui se
 * manda al renderer y no se acumula.
 *
 * Si yt-dlp escribiera cualquier aviso extra en stdout, `path` seria un texto
 * multilinea y el renderer receberia una ruta que no existe. Se deja como esta:
 * es el contrato con la salida de una herramienta de terceros.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 5 -- los tres canales tienen timeouts distintos, y el que no deberia
 * -----------------------------------------------------------------------------
 * | Canal | Timeout |
 * | --- | --- |
 * | `ytdlp-version` | 5 s |
 * | `ytdlp-analyze` | 30 s |
 * | `ytdlp-download` | NINGUNO |
 *
 * La descarga no tiene timeout a proposito: un video largo legitimate tarda mas
 * de 30 s y matarlo seria peor que esperar. El precio es que si yt-dlp se cuelga
 * sin salir, ese `spawn` se queda vivo hasta que cierre la app. Se deja, con la
 * tabla a la vista para que la decision sea consciente.
 *
 * -----------------------------------------------------------------------------
 * LO QUE NO SE MOVIO
 * -----------------------------------------------------------------------------
 * `ffmpeg-check` e `ffmpeg-install` estaban EN MEDIO de este bloque, entre
 * `ytdlp-check` y `ytdlp-version`. No son de yt-dlp (llaman a `ffmpeg.js`) y se
 * quedan en main.js: son de una linea y son canales IPC que main.js registra.
 * Por eso la extraccion son dos bloques y no uno.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, session, ipcMain } = require('electron');
const { ACTIONS, getMainWin } = require('../src/main/runtime');
const { CFG } = require('../src/main/config');

let ytdlpPath = '';
function findYtdlp() {
  if (ytdlpPath && fs.existsSync(ytdlpPath)) return ytdlpPath;
  for (const c of [path.join(app.getPath('userData'), 'yt-dlp.exe'), 'yt-dlp.exe', 'yt-dlp']) {
    try { if (fs.existsSync(c)) { ytdlpPath = c; return c; } } catch {}
  }
  return null;
}

// Sitios con extractor propio en yt-dlp que requieren sesión iniciada para
// resolver el video real (Instagram, Facebook, X/Twitter, TikTok). Para
// estos, hay que pasarle a yt-dlp la URL de la PÁGINA (no una URL de stream
// ya extraída) y las cookies de la sesión — yt-dlp arma él mismo el
// manifiesto/segmentos usando su propio extractor, que sabe manejar el
// login y las URLs firmadas de cada plataforma.
const YTDLP_NATIVE_LOGIN_HOSTS = /(^|\.)instagram\.com$|(^|\.)facebook\.com$|(^|\.)twitter\.com$|(^|\.)x\.com$|(^|\.)tiktok\.com$/i;
function isYtdlpNativeLoginHost(host) {
  return YTDLP_NATIVE_LOGIN_HOSTS.test(String(host || ''));
}

// Exporta las cookies de la sesión del navegador para un dominio a un
// archivo formato Netscape (el que yt-dlp espera con --cookies). Sin esto,
// yt-dlp corre como proceso aparte sin ninguna cookie — para sitios que
// exigen sesión iniciada (Instagram, Facebook, etc.) eso significa que solo
// puede ver contenido público, o directamente falla.
async function writeYtdlpCookiesFile(pageUrl) {
  try {
    const host = new URL(pageUrl).hostname;
    const cookies = await session.fromPartition('persist:mc').cookies.get({ url: pageUrl });
    if (!cookies.length) return null;
    const lines = ['# Netscape HTTP Cookie File', '# Generado por MC Browser para yt-dlp'];
    for (const c of cookies) {
      const domain = c.domain || host;
      const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const expires = c.expirationDate ? Math.round(c.expirationDate) : 0;
      lines.push([domain, includeSubdomains, c.path || '/', c.secure ? 'TRUE' : 'FALSE', expires, c.name, c.value].join('\t'));
    }
    const file = path.join(app.getPath('temp'), `mc-ytdlp-cookies-${Date.now()}.txt`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  } catch (e) { console.error('[ytdlp-cookies]', e.message); return null; }
}
function cleanupYtdlpCookiesFile(file) {
  if (!file) return;
  fs.unlink(file, () => {});
}

function registerYtdlpIpc() {
  ipcMain.handle('ytdlp-check', () => !!findYtdlp());
  ipcMain.handle('ytdlp-version', async () => {
    const p = findYtdlp();
    if (!p) return '';
    try {
      return new Promise((resolve) => {
        const proc = spawn(p, ['--version'], { timeout: 5000 });
        let out = '';
        proc.stdout.on('data', d => out += d.toString());
        proc.on('close', () => resolve(out.trim()));
        proc.on('error', () => resolve(''));
      });
    } catch { return ''; }
  });
  ipcMain.handle('ytdlp-install', async () => {
    try {
      const dest = path.join(app.getPath('userData'), 'yt-dlp.exe');
      ACTIONS.emit('ytdlp-log', 'Descargando yt-dlp desde GitHub...');
      const res = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe');
      if (!res.ok) { ACTIONS.emit('ytdlp-log', `HTTP ${res.status} al descargar`); return { error: `HTTP ${res.status}` }; }
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      ytdlpPath = dest;
      ACTIONS.emit('ytdlp-log', '✓ yt-dlp instalado en ' + dest);
      return { ok: true, path: dest };
    } catch (e) { ACTIONS.emit('ytdlp-log', 'Error instalación: ' + e.message); return { error: e.message }; }
  });
  ipcMain.handle('ytdlp-analyze', async (e, url) => {
    const p = findYtdlp();
    if (!p) return { error: 'yt-dlp not found' };
    let cookiesFile = null;
    try {
      cookiesFile = await writeYtdlpCookiesFile(url);
      const args = ['--no-download', '--dump-json'];
      if (cookiesFile) args.push('--cookies', cookiesFile);
      args.push(url);
      return await new Promise((resolve) => {
        const proc = spawn(p, args, { timeout: 30000 });
        let out = '', err = '';
        proc.stdout.on('data', d => out += d.toString());
        proc.stderr.on('data', d => err += d.toString());
        proc.on('close', (code) => {
          if (code === 0) {
            try {
              const data = JSON.parse(out);
              resolve({ ok: true, title: data.title, duration: data.duration, formats: (data.formats || []).length });
            } catch { resolve({ error: 'Error parsing yt-dlp output' }); }
          } else resolve({ error: err || `Exit code ${code}` });
        });
        proc.on('error', e => resolve({ error: e.message }));
      });
    } catch (e) { return { error: e.message }; }
    finally { cleanupYtdlpCookiesFile(cookiesFile); }
  });
  ipcMain.handle('ytdlp-download', async (e, opts) => {
    const p = findYtdlp();
    if (!p) return { error: 'yt-dlp not found' };
    const dlDir = CFG.downloadDir || app.getPath('downloads');
    // Si viene pageUrl y es un sitio con login (Instagram/Facebook/X/TikTok),
    // usar la página real en vez de la URL de stream ya extraída: yt-dlp
    // resuelve el video con su propio extractor (maneja firmas/expiración
    // solo), y sí sabe usar las cookies para contenido que requiere sesión.
    let target = opts.url;
    let cookiesFile = null;
    try {
      if (opts.pageUrl) {
        try {
          const pageHost = new URL(opts.pageUrl).hostname;
          if (isYtdlpNativeLoginHost(pageHost)) target = opts.pageUrl;
          cookiesFile = await writeYtdlpCookiesFile(opts.pageUrl);
        } catch {}
      }
      if (!cookiesFile) cookiesFile = await writeYtdlpCookiesFile(target).catch(() => null);
      const args = [target, '-o', path.join(dlDir, '%(title)s.%(ext)s'), '--no-playlist', '--print', 'after_move:filepath'];
      if (cookiesFile) args.push('--cookies', cookiesFile);
      return await new Promise((resolve) => {
        const proc = spawn(p, args);
        let output = '';
        proc.stdout.on('data', d => { output += d.toString(); try { getMainWin()?.webContents?.send('ytdlp-log', d.toString().trim()); } catch {} });
        proc.stderr.on('data', d => { try { getMainWin()?.webContents?.send('ytdlp-log', d.toString().trim()); } catch {} });
        proc.on('close', code => { if (code === 0) resolve({ ok: true, path: output.trim() }); else resolve({ error: `Exit code ${code}` }); });
        proc.on('error', e => resolve({ error: e.message }));
      });
    } catch (e) { return { error: e.message }; }
    finally { cleanupYtdlpCookiesFile(cookiesFile); }
  });
}

module.exports = { registerYtdlpIpc };