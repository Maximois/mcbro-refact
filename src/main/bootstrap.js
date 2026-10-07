'use strict';

// MC Browser -- src/main/bootstrap.js
//
// Cuerpo principal del proceso principal. main.js (entrypoint delgado) es el
// unico que carga este archivo, y lo hace como SU PRIMER require de proyecto.
// Aqui, lo primero que se hace con codigo propio es fijar la carpeta de datos
// (regla 2.5): config, runtime, data/* y el resto se cargan DESPUES de ese
// setPath. Ver docs/RESTRUCTURACION.md 2.5 y 3.

const { app, BrowserWindow, session, ipcMain, shell, dialog, Notification, Menu, clipboard, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile, execFileSync } = require('child_process');
const crypto = require('crypto');

// ── Carpeta de datos: tiene que ir ANTES de cualquier require de código propio ──
//
// Unique data folder per build: dev and installed app keep separate data.
//
// Por qué está aquí y no más abajo: config, data/bookmarks y data/history
// calculan su ruta AL CARGARSE, con `path.join(app.getPath('userData'), ...)`.
// Se requieren en las líneas siguientes a este bloque, así que leerían
// `userData` antes de que nadie lo cambiara y acabarían en la carpeta POR
// DEFECTO en vez de en `mc-browser-v2-dev`.
//
// No es hipotético: se perdían las sesiones guardadas, el allowlist, el DoH, el
// historial real y los marcadores, porque esos archivos existen en la carpeta
// correcta y la app miraba la otra.
//
// Invariante (regla 2.5): ESTE es el primer require de código propio del
// proceso principal. Si alguien antepone un require de proyecto antes de este
// bloque, la app vuelve a leer la carpeta por defecto. Lo comprueban el fuente
// (test/data-paths.test.js, que escanea ESTE archivo) y la ejecución
// (tools/boot-smoke.js, con la línea [DATA] de más abajo).
const DATA_DIR = app.isPackaged ? 'MC Browser' : 'mc-browser-v2-dev';
app.setPath('userData', path.join(app.getPath('appData'), DATA_DIR));
const { isAggressiveAdNavigation, isExplicitlyBlocked, isTrustedResource, isVideoHost, isAdblockHostAllowed, isAdblockSiteAllowed, isGoogleDocumentHost, isGoogleAdHost } = require('../../modules/adblocker/main');
const Permissions = require('../../lib/permissions');
const { isWebContentsFrameAlive } = Permissions;
// La reanudacion de HLS (fingerprintHlsPlaylist, loadHlsResumeState,
// saveHlsResumeState) se la lleva src/main/downloads/hls.js en el paso 16. Este
// require era su unico consumidor en main.js, asi que se va con el.
// Configuracion persistida (cfg.json): CFG, saveCfg, validacion de parches y
// rutas seguras. CFG queda congelado al require, asi que es seguro guardarlo
// una vez aqui — ver src/main/config/index.js y docs/RESTRUCTURACION.md 2.1.
const {
  CFG, saveCfg, setGpuRuntimeActive, cfgSnapshot, sanitizeCfgPatch, resolveSafePath,
  CFG_PATH
} = require('./config');
// Marcadores e historial persistidos. OJO: `store.items` y un objeto contenedor
// porque ambos arrays se reasignan en caliente (history:clear, bookmarks:remove,
// tope de 2000). Consumir `store.items` siempre por propiedad, nunca
// destructurar `items`. Ver src/main/data/README.md.
const { store: bookmarksStore, save: saveBookmarks_, BOOKMARKS_PATH } = require('./data/bookmarks');
const { store: historyStore, save: saveHistory_, HISTORY_PATH } = require('./data/history');

// Una linea y solo una, para que se pueda comprobar desde fuera que los tres
// modulos de persistencia resolvieron la MISMA carpeta que la que se acaba de
// fijar. El bug que motiva esta linea era justo el contrario: los tres se
// cargaron antes del setPath y leyeron la carpeta por defecto, asi que la app
// abria con la configuracion vacia y sin historial ni marcadores.
//
// tools/boot-smoke.js la lee y falla si alguna de las cuatro no cae dentro de
// DATA_DIR. Ver docs/RESTRUCTURACION.md 2.5.
console.log(`[DATA] userData=${app.getPath('userData')} cfg=${CFG_PATH} history=${HISTORY_PATH} bookmarks=${BOOKMARKS_PATH}`);
// Estado global compartido: la ventana anfitriona y el objeto ACTIONS.
// mainWin se asigna tarde (dentro de createWindow), asi que se accede SIEMPRE
// por getMainWin(), nunca destructurandolo. Ver src/main/runtime.js.
const { setMainWin, getMainWin, ACTIONS } = require('./runtime');

// Permisos del navegador por sitio. La politica vive en lib/permissions.js;
// estos modulos son los puentes hacia Electron y hacia CFG.
const PermissionsHandlers = require('./permissions/handlers');
const PermissionsAdapters = require('./permissions/adapters');
const PermissionsEntries = require('./permissions/entries');
// Navegacion: catalogos de dominios, estado de navegacion explicita y reglas
// de transicion. domains.js es puro; transitions.js depende de el y del adblocker.
const NavDomains = require('./navigation/domains');
const NavExplicit = require('./navigation/explicit-nav');
const NavTransitions = require('./navigation/transitions');
// Estadisticas. tracker.js es el dueno de STATS: se REASIGNA en reset-stats
// y en clear-data, asi que fuera de ahi se accede con getStats() y los
// accesores, nunca importando STATS. Ver src/main/stats/tracker.js.
const StatsTracker = require('./stats/tracker');
const MediaDetect = require('./stats/media-detect');
// Registra el handler 'get-sysinfo'. No devuelve nada: el require es lo que
// instala el IPC. Antes este modulo tambien era el muestreador de CPU/RAM y lo
// exportaba; ese sampler ya no existe.
require('./stats/process-metrics');
// DNS sobre HTTPS. Ojo: hay DOS mapas de servidores distintos (wire /dns-query
// para Chromium y JSON /resolve para el test), y configureHostResolver es un
// ajuste GLOBAL que compite con el resolver nativo de Perchance.
// Ver src/main/net/README.md.
const DoH = require('./net/doh');
const CookieGuard = require('./net/cookie-guard');
const Headers = require('./net/headers');
const RequestGuard = require('./net/request-guard');
const DownloadsHls = require('./downloads/hls');
const DownloadsFile = require('./downloads/file');
const DownloadsFfmpeg = require('./downloads/ffmpeg');
const YtDlp = require('../../tools/ytdlp');
const DownloadsRegistry = require('./downloads/registry');
const DownloadsFetch = require('./downloads/fetch');
const DownloadsNative = require('./downloads/native');
const SessionsExtra = require('./sessions/extra');
const SessionsWebchat = require('./sessions/webchat');
const SessionsWhatsapp = require('./sessions/whatsapp');
const SessionsIpc = require('./sessions/ipc');
const Proxy = require('./net/proxy');
const StreamCapture = require('./streams/capture');
const MemoryStore = require('./memory/store');
const Sessions = require('./sessions/partitions');
const WindowsCreate = require('./windows/create');
const WindowsWebcontents = require('./windows/webcontents');
const PerchancePaneInit = require('./perchance/panel');
const Modules = require('./modules-loader');
const WindowIpc = require('./ipc/window');
const External = require('./ipc/external');
// Panel aislado de Perchance: vista nativa (WebContentsView) con partición
// propia, allowlist, permisos, CSP/XFO y descargas blob/data (perchance-panel.js).
const PerchancePanel = require('../../perchance/perchance-panel');

// Error conocido de Electron: "Render frame was disposed before WebFrameMain
// could be accessed". Se dispara cuando un webview/iframe navega rápido y su
// frame se descarta mientras Electron emite un evento de navegación (típico
// de Perchance, que crea muchos iframes y navega entre subdominios). Es
// inofensivo y no rompe la app; lo filtramos para que no ensucie la consola
// sin ocultar otros errores reales.
process.on('uncaughtException', (err) => {
  const msg = String((err && err.message) || err || '');
  if (msg.includes('Render frame was disposed before WebFrameMain could be accessed')) return;
  console.error('[UNCAUGHT]', err);
});

// La carpeta de datos se fijo arriba, antes de los requires de proyecto. Ver el
// bloque con DATA_DIR y el comentario de por que el orden importa.

function registerBrowserSystemProtocols() {
  try {
    if (process.platform === 'win32' && app.isPackaged) {
      app.setAppUserModelId('com.mcbrowser.v2');
      const executable = process.execPath;
      const command = `"${executable}" "%1"`;
      const registry = [
        ['HKCU\\Software\\Classes\\MCBrowserURL', '/ve', '/t', 'REG_SZ', '/d', 'URL:MC Browser', '/f'],
        ['HKCU\\Software\\Classes\\MCBrowserURL', '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'],
        ['HKCU\\Software\\Classes\\MCBrowserURL\\shell\\open\\command', '/ve', '/t', 'REG_SZ', '/d', command, '/f'],
        ['HKCU\\Software\\RegisteredApplications', '/v', 'MC Browser', '/t', 'REG_SZ', '/d', 'Software\\MC Browser\\Capabilities', '/f'],
        ['HKCU\\Software\\MC Browser\\Capabilities', '/v', 'ApplicationName', '/t', 'REG_SZ', '/d', 'MC Browser', '/f'],
        ['HKCU\\Software\\MC Browser\\Capabilities', '/v', 'ApplicationDescription', '/t', 'REG_SZ', '/d', 'MC Browser Web Browser', '/f'],
        ['HKCU\\Software\\MC Browser\\Capabilities', '/v', 'ApplicationIcon', '/t', 'REG_SZ', '/d', `${executable},0`, '/f'],
        ['HKCU\\Software\\MC Browser\\Capabilities\\URLAssociations', '/v', 'http', '/t', 'REG_SZ', '/d', 'MCBrowserURL', '/f'],
        ['HKCU\\Software\\MC Browser\\Capabilities\\URLAssociations', '/v', 'https', '/t', 'REG_SZ', '/d', 'MCBrowserURL', '/f']
      ];
      for (const args of registry) {
        try { execFileSync('reg.exe', ['ADD', ...args], { windowsHide: true, stdio: 'ignore' }); } catch {}
      }
      app.setAsDefaultProtocolClient('http', executable, [app.getAppPath()]);
      app.setAsDefaultProtocolClient('https', executable, [app.getAppPath()]);
    }
  } catch (e) {
    console.warn('[BrowserRegistration]', e && e.message ? e.message : String(e));
  }
}

registerBrowserSystemProtocols();

function readGpuAccelerationPref() {
  try {
    const cfgPath = path.join(app.getPath('userData'), 'cfg.json');
    if (fs.existsSync(cfgPath)) {
      const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      return saved.gpuAcceleration === true;
    }
  } catch {}
  return false;
}

// Debe ejecutarse antes de app.ready; por defecto desactivada.
const GPU_RUNTIME_ACTIVE = readGpuAccelerationPref();
if (!GPU_RUNTIME_ACTIVE) {
  try { app.disableHardwareAcceleration(); } catch (e) { console.warn('[GPU]', e.message); }
}
// La UI necesita saber si el cambio de gpuAcceleration ya surte efecto o
// exige reiniciar (cfgSnapshot lo compara). Se pasa al modulo de config
// porque alli vive la funcion que arma ese snapshot.
setGpuRuntimeActive(GPU_RUNTIME_ACTIVE);

// ✅ LOGIN WORKS: solo esta flag, nada más
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// ── ANTIGUO: disable-direct-composition-video-overlays ──
// Este switch se agrego para un parpadeo del overlay de video en Windows (el
// <video> se promovia a una capa DXGI/DirectComposition aparte y el flip
// titilaba fuera de la ventana). SE QUITO porque es incompatible con el
// consumo de RAM: con la GPU activada, suprimir los overlays de video por
// hardware obliga a componer el video en software DENTRO del proceso renderer,
// que es justo donde se acumulaba la memoria (medido: ~490 MB de mas en el
// renderer tras varias navegaciones en YouTube, y ~604 MB con el switch
// activo vs ~867 MB en el peor pico sin GPU).
//
// NO volver a agregarlo de forma incondicional. Si el parpadeo vuelve a
// molestar, tiene que ser un toggle explicito de Ajustes, no un default: el
// costo en RAM es alto y silencioso. La via correcta para el parpadeo es
// ajustar como se presenta el video, no apagar la aceleracion por hardware.

// Con GPU por software (gpuAcceleration=false en cfg) el decode de video
// ocurre en el renderer, no en el gpu-process. Eso se nota en el monitor:
// los saltos grandes de RAM caen SIEMPRE en Renderer, y gpu-process queda
// plano en ~80 MB. Por eso el proceso a vigilar para el consumo de video es
// Renderer.




// Limpieza de datos del panel de Perchance (caché/cookies/storage) y apertura
// de su carpeta de descargas. El renderer del panel las invoca desde su sección
// de configuración.
ipcMain.handle('perchance:clear-data', async (_e, opts = {}) => {
  try {
    return await PerchancePanel.clearPerchanceData(PerchancePanel.PERCHANCE_PARTITION, opts);
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
});
ipcMain.handle('perchance:open-dl-folder', () => {
  try { shell.openPath(PerchancePanel.downloadFolder()); } catch {}
});

async function saveBlobOrDataUrlToDownloads(wc, srcURL, hintName, sourceFrame) {
  try {
    if (!/^(blob|data):/i.test(srcURL)) return { ok: false, error: 'no es blob: ni data:' };
    if (!wc || wc.isDestroyed()) return { ok: false, error: 'página no disponible' };
    const safeHint = String(hintName || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
    const script = `
      (async () => {
        try {
          const url = ${JSON.stringify(srcURL)};
          const hint = ${JSON.stringify(safeHint)};

          // 1. extension desde el nombre que ya tuvieramos
          const guessed = /\\.([a-z0-9]{2,8})$/i.exec(hint);
          let ext = guessed ? guessed[1].toLowerCase() : '';

          // 2. tipo MIME real. Un blob: NO lo revela la URL, hay que leerlo.
          let mime = '';
          if (/^data:/i.test(url)) {
            const m = /^data:([^;,]+)[;,]/i.exec(url);
            if (m) mime = m[1];
          } else {
            try {
              const res = await fetch(url);
              mime = (res.headers.get('content-type') || '').split(';')[0].trim();
            } catch {}
          }

          // 3. tipo del elemento <img>/<video>/<source> que apunta a esta URL
          if (!mime) {
            const el = Array.from(document.querySelectorAll('img[src],video[src],video[poster],source[src]'))
              .find(n => n.src === url || n.getAttribute('src') === url || n.poster === url);
            if (el) mime = el.getAttribute('type') || '';
          }

          if (!ext && mime) {
            const map = {
              'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
              'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
              'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico',
              'image/tiff': 'tiff', 'image/heic': 'heic',
              'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv',
              'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
              'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
              'text/plain': 'txt', 'text/html': 'html', 'application/json': 'json',
              'application/pdf': 'pdf', 'application/zip': 'zip'
            };
            ext = map[mime.toLowerCase()] || (/^[a-z0-9.+-]+\\/([a-z0-9.+-]+)$/i.test(mime) ? mime.split('/')[1].toLowerCase().replace(/^x-/, '') : '');
          }

          // 4. ultimo recurso: sniff de los primeros bytes.
          //    Ojo: comparar bytes con fromCharCode es inutil para PNG
          //    (0x89 no es imprimible), hay que mirar offsets.
          if (!ext && /^blob:/i.test(url)) {
            try {
              const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
              const ascii = (i, n) => String.fromCharCode.apply(null, buf.slice(i, i + n));
              if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) ext = 'png';
              else if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) ext = 'jpg';
              else if (ascii(0, 4) === 'GIF8') ext = 'gif';
              else if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') ext = 'webp';
              else if (ascii(0, 3) === 'ID3' || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0)) ext = 'mp3';
              else if (ascii(4, 4) === 'ftyp') ext = 'mp4';
              else if (ascii(0, 5) === '%PDF-') ext = 'pdf';
              else if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) ext = 'webm';
            } catch {}
          }

          // Prioridad: atributo download del ancla original > hint > 'imagen'
          const original = Array.from(document.querySelectorAll('a[href]')).find(link => link.href === url);
          const originalName = original && original.getAttribute('download');
          let stem = hint || 'imagen';
          if (!ext && !originalName) stem = 'imagen';
          const filename = originalName || (stem + (ext ? '.' + ext : ''));

          // Sin atributo download, Chromium no siempre resuelve un blob: de
          // iframe y el click se propaga al frame padre (=> zoom en galeria).
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = filename;
          anchor.rel = 'noopener';
          anchor.style.display = 'none';
          (document.body || document.documentElement).appendChild(anchor);
          anchor.click();
          setTimeout(() => anchor.remove(), 1000);
          return { ok: true, filename, mime: mime || null, ext: ext || null };
        } catch (error) {
          return { error: error.message || String(error) };
        }
      })()
    `;
    const executor = sourceFrame && typeof sourceFrame.executeJavaScript === 'function' ? sourceFrame : wc;
    // awaitPromise: el script es async (lee el MIME del blob) y sin esto
    // executeJavaScript devuelve "[object Promise]" y el anchor nunca se
    // clickea. userGesture mantiene el click como gesto del usuario.
    const result = await executor.executeJavaScript(script, true, { awaitPromise: true });
    if (!result || result.error) return { ok: false, error: result?.error || 'no se pudo iniciar la descarga' };
    return { ok: true, filename: result.filename || null, mime: result.mime || null };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// Sesiones extra: a diferencia de WebChat (5 dominios fijos, sin publicidad),
// acá el usuario navega a CUALQUIER sitio dentro de su propia identidad/
// cookie jar — así que sí deben recibir las mismas reglas de ad/tracker
// blocking, política de cookies y permisos que la sesión principal. Lo único
// que cambia es el almacenamiento (cookies/cache/storage separados).



// === IPC HANDLERS (sin tocar sesión/UA) ===
// Window
ipcMain.handle('webview:destroy', (_event, webContentsId) => {
  const id = Number(webContentsId);
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: 'ID de webview inválido' };
  try {
    const guest = require('electron').webContents.fromId(id);
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') return { ok: true, destroyed: false };
    guest.destroy();
    return { ok: true, destroyed: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
// El renderer avisa que el usuario inició una navegación explícita en un
// webview. Mientras dure, `will-redirect` no bloquea sus redirecciones.
ipcMain.on('nav-intent', (_event, opts) => {
  const wcId = Number(opts && opts.wcId);
  if (Number.isInteger(wcId) && wcId > 0) NavExplicit.markExplicitNavigation(wcId);
});

// Config
ipcMain.handle('get-cfg', () => cfgSnapshot());
ipcMain.handle('update-cfg', (e, patch) => {
  const clean = sanitizeCfgPatch(patch);
  // Mutar CFG existente para que referencias (ctx.cfg en módulos) no queden obsoletas
  Object.assign(CFG, clean);
  if ((clean.blockAds !== undefined || clean.blockTrackers !== undefined) && ACTIONS.adblockToggle) {
    ACTIONS.adblockToggle({ ads: CFG.blockAds, trackers: CFG.blockTrackers });
  }
  if (clean.dohEnabled !== undefined || clean.dohServer !== undefined) {
    DoH.applyDoH();
  }
  if (clean.cookiePolicy !== undefined) {
    CookieGuard.applyCookiePolicy(CFG.cookiePolicy);
    CookieGuard.refreshCookieGuards();
  }
  if (Object.keys(clean).length) saveCfg();
  return cfgSnapshot();
});
ipcMain.handle('proxy:set', (_e, settings = {}) => Proxy.setProxy(settings));

// ── Downloads ───────────────────────────────
// dl-hls se finaliza solo: hls.js requiere ffmpeg.js directamente, asi que ya no
// hace falta pasarle finalizeMediaFile por parametro. La deuda del paso 16 se
// cerro en el 18.
DownloadsHls.registerHlsIpc();
// dl-file no lleva inyeccion: este camino no usa ffmpeg, solo renombra. Ver
// la cabecera de downloads/file.js.
DownloadsFile.registerFileDownloadIpc();
DownloadsRegistry.registerDownloadControlIpc();
DownloadsNative.registerNativeDownloadIpc();
// A nivel de modulo, no dentro de whenReady: los handlers se registran al
// require. Ver el bloque de sesion en src/main/sessions/ipc.js.
SessionsIpc.registerSessionsIpc();
ipcMain.handle('open-dl-folder', () => { shell.openPath(CFG.downloadDir || app.getPath('downloads')); });
const OPENABLE_EXT_MAIN = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm', '.m4v', '.mov', '.mp3', '.wav', '.ogg', '.opus', '.flac', '.m4a', '.aac', '.bin', '.txt', '.json']);
ipcMain.handle('dl:open-file', async (_e, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') return { error: 'Ruta no válida' };
    const dlDir = CFG.downloadDir || app.getPath('downloads');
    const base = path.resolve(dlDir);
    const resolved = path.resolve(filePath);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      return { error: 'Ruta fuera de la carpeta de descargas' };
    }
    if (!OPENABLE_EXT_MAIN.has(path.extname(resolved).toLowerCase())) {
      return { error: 'Tipo de archivo no permitido' };
    }
    if (!fs.existsSync(resolved)) return { error: 'Archivo no encontrado' };
    const err = await shell.openPath(resolved);
    return err ? { error: err } : { ok: true };
  } catch (err) { return { error: err.message }; }
});
ipcMain.handle('choose-dl-dir', async () => {
  const result = await dialog.showOpenDialog(getMainWin(), { properties: ['openDirectory'] });
  if (!result.canceled && result.filePaths.length) {
    CFG.downloadDir = result.filePaths[0];
    saveCfg();
    return { path: result.filePaths[0] };
  }
  return {};
});
// Cookies / Cache
//
// `persist:mc` es la particion de la SESION PRINCIPAL. No cambiar por
// `session.defaultSession`: el usuario abre varias sesiones aisladas que NUNCA
// comparten cookies, y cada una tiene su propia particion
// (`persist:mc-session-<id>`, ver Sessions.extraSessionPartition). defaultSession solo
// corresponde a las ventanas sin `partition` propio, asi que usarla vaciaria
// la sesion principal Y dejaria intactas las demas.
//
// Cada handler de limpieza apunta a una particion explicita a proposito:
//   clear-cookies / clear-data / clear-all        -> persist:mc (principal)
//   sessions:clear-data / sessions:delete         -> persist:mc-session-<id>
//   clear-webchat-data                             -> Sessions.WEBCHAT_PARTITION
//   Perchance                                      -> su propia sesion
//
// Esos handlers son operacion GLOBAL a proposito: el boton "limpiar cookies"
// del panel WebChat debe borrar las de WebChat, no las de la pestana desde la
// que se pulso. Por eso NO se debe cambiar a `event.sender.session`.
const sess = () => session.fromPartition('persist:mc');
// Los canales `sessions:*` y `clear-*` se fueron a src/main/sessions/ipc.js
// (registrados con registerSessionsIpc mas abajo). Este helper se queda porque
// los handlers de cookies por sitio, que son de net/cookie-guard.js, lo usan
// tambien. Ver el bloque largo de sesion en ese modulo: los de limpieza son
// operacion GLOBAL y no deben cambiarse por `event.sender.session`.
ipcMain.handle('add-cookie-rule', (e, { domain, policy }) => { CFG.allowlist[domain] = policy; saveCfg(); CookieGuard.refreshCookieGuards(); return { ok: true }; });
ipcMain.handle('remove-cookie-rule', (e, { domain }) => { delete CFG.allowlist[domain]; saveCfg(); CookieGuard.refreshCookieGuards(); return { ok: true }; });
ipcMain.handle('set-cookie-policy-for-domain', (e, { domain, policy }) => {
  const host = String(domain || '').trim().replace(/^\.+/, '').toLowerCase();
  if (!host) return { ok: false, error: 'dominio obligatorio' };
  CFG.allowlist[host] = policy;
  saveCfg();
  CookieGuard.refreshCookieGuards();
  return { ok: true, domain: host, policy };
});
ipcMain.handle('get-site-cookies', async (e, { domain }) => {
  try {
    const host = String(domain || '').trim().replace(/^\.+/, '').toLowerCase();
    if (!host) return [];
    const allCookies = await sess().cookies.get({});
    const matchesHost = (cookieDomain) => {
      const normalized = String(cookieDomain || '').replace(/^\.+/, '').toLowerCase();
      if (!normalized) return false;
      if (normalized === host) return true;
      if (host.endsWith('.' + normalized) || normalized.endsWith('.' + host)) return true;
      return false;
    };
    const cookies = allCookies.filter(cookie => matchesHost(cookie.domain));
    return cookies.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: !!cookie.secure,
      session: !!cookie.session,
      httpOnly: !!cookie.httpOnly,
      expirationDate: cookie.expirationDate || null,
      sameSite: cookie.sameSite || 'unspecified'
    }));
  } catch (error) {
    return { error: error.message };
  }
});
ipcMain.handle('remove-site-cookie', async (e, { domain, name, path: cookiePath }) => {
  try {
    const host = String(domain || '').trim().replace(/^\.+/, '').toLowerCase();
    const cookiePathValue = String(cookiePath || '/');
    if (!host || !name) return { ok: false, error: 'faltan datos' };
    const removed = await sess().cookies.remove(CookieGuard.cookieRemovalUrl({ domain: host, path: cookiePathValue, secure: true }, host), name);
    if (!removed) {
      await sess().cookies.remove(CookieGuard.cookieRemovalUrl({ domain: host, path: cookiePathValue, secure: false }, host), name);
    }
    return { ok: true, removed: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
// Block rules
ipcMain.handle('adblock:host-allow', (_e, { host, allowed } = {}) => {
  const rawHost = String(host || '').trim();
  const normalizedHost = PermissionsAdapters.normalizeSiteHost(/^https?:\/\//i.test(rawHost) ? rawHost : 'https://' + rawHost);
  if (!normalizedHost) return { ok: false, error: 'dominio inválido' };
  if (!Array.isArray(CFG.adblockAllowlist)) CFG.adblockAllowlist = [];
  const canonicalHost = normalizedHost.replace(/^www\./i, '');
  CFG.adblockAllowlist = CFG.adblockAllowlist
    .map(value => PermissionsAdapters.normalizeSiteHost(/^https?:\/\//i.test(String(value)) ? String(value) : 'https://' + String(value)))
    .filter(Boolean)
    .filter(value => value !== canonicalHost);
  if (allowed === true) CFG.adblockAllowlist.push(canonicalHost);
  saveCfg();
  return { ok: true };
});
ipcMain.handle('adblock:site-allow', (_e, { site, allowed } = {}) => {
  const rawSite = String(site || '').trim();
  const normalizedSite = PermissionsAdapters.normalizeSiteHost(/^https?:\/\//i.test(rawSite) ? rawSite : 'https://' + rawSite);
  if (!normalizedSite) return { ok: false, error: 'sitio inválido' };
  if (!Array.isArray(CFG.adblockAllowedSites)) CFG.adblockAllowedSites = [];
  const canonicalSite = normalizedSite.replace(/^www\./i, '');
  CFG.adblockAllowedSites = CFG.adblockAllowedSites
    .map(value => PermissionsAdapters.normalizeSiteHost(/^https?:\/\//i.test(String(value)) ? String(value) : 'https://' + String(value)))
    .filter(Boolean)
    .filter(value => value !== canonicalSite);
  if (allowed === true) CFG.adblockAllowedSites.push(canonicalSite);
  saveCfg();
  return { ok: true };
});
ipcMain.handle('add-block-rule', (e, rule) => {
  if (rule && rule.pattern) { CFG.customRules.push(rule); saveCfg(); }
  return { ok: true };
});
ipcMain.handle('remove-block-rule', (e, { pattern, site }) => {
  if (site) {
    CFG.customRules = CFG.customRules.filter(r => !(r.pattern === pattern && r.site === site));
  } else {
    CFG.customRules = CFG.customRules.filter(r => r.pattern !== pattern);
  }
  saveCfg();
  return { ok: true };
});
ipcMain.handle('add-resource-rule', (e, rule = {}) => {
  const url = String(rule.url || '').trim();
  const action = rule.action === 'allow' ? 'allow' : rule.action === 'block' ? 'block' : '';
  if (!url || !action) return { ok: false, error: 'faltan URL o acción' };
  CFG.resourceRules = (Array.isArray(CFG.resourceRules) ? CFG.resourceRules : []).filter(item => item.url !== url || item.resourceType !== rule.resourceType);
  CFG.resourceRules.push({ url, action, resourceType: String(rule.resourceType || 'script') });
  saveCfg();
  return { ok: true };
});
ipcMain.handle('remove-resource-rule', (e, { url, resourceType }) => {
  CFG.resourceRules = (Array.isArray(CFG.resourceRules) ? CFG.resourceRules : []).filter(item => item.url !== url || (resourceType && item.resourceType !== resourceType));
  saveCfg();
  return { ok: true };
});
ipcMain.handle('get-resource-rules', () => Array.isArray(CFG.resourceRules) ? [...CFG.resourceRules] : []);
// Bookmarks
ipcMain.handle('bookmarks:list', () => [...bookmarksStore.items]);
ipcMain.handle('bookmarks:add', (e, bookmark) => {
  const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2,6), url: bookmark.url, title: bookmark.title || bookmark.url, icon: bookmark.icon || '', folder: bookmark.folder || '', ts: Date.now() };
  bookmarksStore.items.unshift(entry);
  saveBookmarks_();
  return entry;
});
ipcMain.handle('bookmarks:remove', (e, { id }) => {
  bookmarksStore.items = bookmarksStore.items.filter(b => b.id !== id);
  saveBookmarks_();
  return { ok: true };
});
ipcMain.handle('bookmarks:update', (e, { id, patch }) => {
  const b = bookmarksStore.items.find(b => b.id === id);
  if (b) Object.assign(b, patch);
  saveBookmarks_();
  return { ok: true };
});
ipcMain.handle('bookmarks:reorder', (e, { fromIndex, toIndex }) => {
  const [item] = bookmarksStore.items.splice(fromIndex, 1);
  if (item) { bookmarksStore.items.splice(toIndex, 0, item); saveBookmarks_(); }
  return { ok: true };
});
// Browser history
ipcMain.handle('history:list', () => [...historyStore.items].reverse());
ipcMain.handle('history:add', (e, entry) => {
  if (!entry || typeof entry.url !== 'string' || !/^https?:\/\//i.test(entry.url)) return { ok: false };
  const last = historyStore.items[historyStore.items.length - 1];
  if (last && last.url === entry.url) return { ok: true, entry: last };
  const saved = {
    url: entry.url,
    title: String(entry.title || entry.url).slice(0, 500),
    ts: Number(entry.ts) || Date.now()
  };
  historyStore.items.push(saved);
  if (historyStore.items.length > 2000) historyStore.items = historyStore.items.slice(-2000);
  saveHistory_();
  return { ok: true, entry: saved };
});
ipcMain.handle('history:clear', () => {
  historyStore.items = [];
  saveHistory_();
  return { ok: true };
});
// Session export/import
ipcMain.handle('export-session', async () => {
  try {
    const cookies = await sess().cookies.get({});
    const result = { app: 'mc-browser-v2', version: 1, cookies };
    const dir = path.join(app.getPath('documents'), DATA_DIR + '-sessions');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fname = path.join(dir, `session-${Date.now()}.json`);
    fs.writeFileSync(fname, JSON.stringify(result, null, 2), 'utf8');
    return { ok: true, path: fname, count: cookies.length };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('import-session', async () => {
  try {
    const result = await dialog.showOpenDialog(getMainWin(), {
      properties: ['openFile'],
      filters: [{ name: 'Session Files', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths.length) return {};
    const raw = fs.readFileSync(result.filePaths[0], 'utf8');
    const data = JSON.parse(raw);
    if (data.app !== 'mc-browser-v2') return { error: 'Invalid format' };
    let count = 0;
    for (const c of (data.cookies || [])) {
      try {
        await sess().cookies.set({
          url: (c.secure ? 'https://' : 'http://') + c.domain + (c.path || '/'),
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite
        });
        count++;
      } catch {}
    }
    return { ok: true, count };
  } catch (e) { return { error: e.message }; }
});
const STREAM_SCAN_SCRIPT = `
  (function(){
    try {
      if(!window.__mcFound) window.__mcFound=[];
      const pageUrl = location.href;
      const SKIP_EXT = /\\.(html?|php|aspx?|jsp|json|xml|css|js|svg|woff2?|ttf|eot)(\\?|#|$)/i;
      const MEDIA_RE = /\\.(m3u8|mp4|webm|mpd|ts|m4s|mkv|avi|mov)(\\?|#|$)/i;
      const TOKEN_RE = /[?&](token|exp|sign|auth|st|nonce|signature|hls|m3u8|mpd|playlist)=/i;
      const isMedia = u => u && !SKIP_EXT.test(u) && !/^(about|data|javascript):/i.test(u) && (MEDIA_RE.test(u) || TOKEN_RE.test(u) || /^https?:\\/\\/(x\\.com|twitter\\.com)\\/[^/]+\\/status\\/\\d+\\/video\\//i.test(u));
      // Extraer usuario de un bloque de tweet (x.com): a[href="/username"] o [data-testid="User-Name"]
      function extractUserFromNode(node) {
        const links = node.querySelectorAll('a[href]');
        for (const a of links) {
          const href = a.getAttribute('href');
          const m = href.match(/^\\/([a-zA-Z0-9_]{1,15})$/);
          if (m && !/^(home|explore|search|notifications|messages|settings|i|compose|login|signup|hashtag|status|photo)$/i.test(m[1])) {
            return '@' + m[1];
          }
        }
        const un = node.querySelector('[data-testid="User-Name"]');
        if (un) {
          const t = un.textContent.trim().replace(/^@/, '');
          if (t && t.length >= 2 && t.length <= 40) return '@' + t;
        }
        return null;
      }
      // Buscar el autor/usuario del post que contiene el medio recorriendo el DOM hacia arriba
      function findAuthor(el) {
        // x.com / twitter.com: article[data-testid="tweet"] más cercano → usuario del tweet
        if (el.closest) {
          const article = el.closest('article[data-testid="tweet"]');
          if (article) {
            const u = extractUserFromNode(article);
            if (u) return u;
          }
        }
        let node = el;
        for (let i = 0; i < 50 && node && node !== document.body; i++) {
          // x.com: [data-testid="User-Name"] (handle visible del tweet) en el ancestro
          if (node.querySelector) {
            const un = node.querySelector('[data-testid="User-Name"]');
            if (un) {
              const t = un.textContent.trim().replace(/^@/, '');
              if (t && t.length >= 2 && t.length <= 40) return '@' + t;
            }
          }
          // Genérico: itemprop="author"
          if (node.querySelector) {
            const auth = node.querySelector('[itemprop="author"]');
            if (auth) {
              const t = (auth.getAttribute('content') || auth.textContent || '').trim().replace(/^@/, '');
              if (t && t.length >= 2 && t.length <= 40) return '@' + t;
            }
          }
          node = node.parentElement;
        }
        return null;
      }
      // Encontrar el autor del video activo (reproduciéndose o visible en pantalla)
      function findActiveVideoAuthor() {
        const videos = document.querySelectorAll('video');
        // 1. Video reproduciéndose
        for (const v of videos) {
          if (!v.paused) {
            const a = findAuthor(v);
            if (a) return a;
          }
        }
        // 2. Video visible en pantalla
        for (const v of videos) {
          const r = v.getBoundingClientRect();
          if (r.top < window.innerHeight && r.bottom > 0 && r.width > 0) {
            const a = findAuthor(v);
            if (a) return a;
          }
        }
        // 3. Si solo hay un video, usarlo
        if (videos.length === 1) {
          const a = findAuthor(videos[0]);
          if (a) return a;
        }
        // 4. Último video del DOM (el más reciente)
        for (let i = videos.length - 1; i >= 0; i--) {
          const a = findAuthor(videos[i]);
          if (a) return a;
        }
        return null;
      }
      const add=(url,via,author)=>{
        if(!url||!isMedia(url)) return;
        const currentPage = location.href;
        const samePage = window.__mcFound.find(f => f.url === url && f.pageUrl === currentPage);
        if (samePage) {
          if (author && !samePage.author) samePage.author = author;
          return;
        }
        const existing = window.__mcFound.find(f => f.url === url && f.pageUrl !== currentPage);
        if (existing) {
          existing.pageUrl = currentPage;
          if (author && !existing.author) existing.author = author;
          return;
        }
        window.__mcFound.push({url,via,pageUrl:currentPage,author:author||null});
      };
      document.querySelectorAll('video,audio').forEach(el=>{
        const author = findAuthor(el);
        // Perchance y otros generadores usan URLs firmadas o sin extensión.
        // La etiqueta multimedia es evidencia suficiente para incluirlas.
        if(el.src && (isMedia(el.src) || /^https?:/i.test(el.src))) add(el.src,'DOM:'+el.tagName,author);
        if(el.currentSrc && el.currentSrc!==el.src && (isMedia(el.currentSrc) || /^https?:/i.test(el.currentSrc))) add(el.currentSrc,'currentSrc',author);
        el.querySelectorAll('source').forEach(s=>{
          if(s.src && (isMedia(s.src) || /^https?:/i.test(s.src))) add(s.src,'source',author);
        });
      });
      document.querySelectorAll('iframe').forEach(f=>{
        const author = findAuthor(f);
        if(f.src&&isMedia(f.src)) add(f.src,'iframe',author);
      });
      try {
        performance.getEntriesByType('resource').forEach(entry => {
          if (entry.name && /\\.(m3u8|mpd|mp4|webm|mkv)(?:\\?|#|$)|manifest|playlist|stream/i.test(entry.name)) add(entry.name,'performance',findActiveVideoAuthor());
        });
      }catch(e){}
      document.querySelectorAll('link[href]').forEach(link => {
        if (/preload|video|audio|manifest/i.test(link.rel || '') && link.href) add(link.href,'preload');
      });
      document.querySelectorAll('script:not([src])').forEach(s=>{
        const m=[...s.textContent.matchAll(/(https?:\\/\\/[^"' \\n<>]{10,400}\\.(?:m3u8|mpd|mp4|webm|mkv)[^"' \\n<>]*)/gi)];
        m.forEach(x=>add(x[1],'script:inline'));
      });
      try{if(typeof jwplayer!=='undefined'&&jwplayer())
        jwplayer().getPlaylist().forEach(it=>{(it.sources||[]).forEach(s=>{if(s.file&&isMedia(s.file))add(s.file,'jwplayer');});if(it.file&&isMedia(it.file))add(it.file,'jwplayer');});
      }catch(e){}
      try{if(typeof videojs!=='undefined')
        document.querySelectorAll('.video-js').forEach(el=>{try{const s=videojs.getPlayer(el).currentSrc();if(s&&isMedia(s))add(s,'videojs');}catch(_){}});
      }catch(e){}
      ['playerSrc','streamUrl','liveUrl','hlsUrl','videoUrl','mediaUrl'].forEach(k=>{
        if(window[k]){const v=String(window[k]);if(isMedia(v))add(v,'window.'+k);}
      });
      if(!window.__mcHooked){
        window.__mcHooked=true;
        const _f=window.fetch; window.fetch=function(r,...a){
          const u=typeof r==='string'?r:(r&&r.url)||'';
          if(/\\.m3u8|\\.mpd|manifest|segment|chunk/i.test(u)) add(u,'fetch',findActiveVideoAuthor());
          return _f.apply(this,[r,...a]);
        };
        const _x=XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open=function(m,u,...a){
          if(u&&/\\.m3u8|\\.mpd|manifest|segment/i.test(u)) add(u,'xhr',findActiveVideoAuthor());
          return _x.apply(this,[m,u,...a]);
        };
      }
      return JSON.stringify(window.__mcFound);
    } catch(e) { return JSON.stringify([]); }
  })()
`;
ipcMain.handle('streams:scan', async (_e, id) => {
  if (!getMainWin() || getMainWin().isDestroyed()) return [];
  try {
    const webviewId = Number(id);
    if (!Number.isInteger(webviewId) || webviewId < 1) return [];
    const raw = await getMainWin().webContents.executeJavaScript(`
      (function(){
        const wv = document.getElementById('webview-${webviewId}');
        if (!wv) return '[]';
        return wv.executeJavaScript(${JSON.stringify(STREAM_SCAN_SCRIPT)});
      })()
    `);
    let items = typeof raw === 'string' ? JSON.parse(raw || '[]') : (Array.isArray(raw) ? raw : []);
    if (items.length) {
      const adHosts = ['doubleclick.net','googlesyndication.com','adnxs.com','rubiconproject.com','openx.net','casalemedia.com','contextweb.com','criteo.com','criteo.net','adsrvr.org','pubmatic.com','taboola.com','outbrain.com','mgid.com','33across.com','dotomi.com','demdex.net','krxd.net','quantserve.com','scorecardresearch.com','serving-sys.com','tidaltv.com','adsafeprotected.com','doubleverify.com','moatads.com','sharethrough.com','yieldmo.com','adtarget.biz','fwmrm.net','4dex.io'];
      items = items.filter(i => {
        try { const h = new URL(i.url).hostname; return !adHosts.some(a => h === a || h.endsWith('.' + a)); } catch { return true; }
      });
    }
    return items;
  } catch(e) { ACTIONS.emit('ytdlp-log', 'Stream scan error: ' + e.message); return []; }
});
StreamCapture.registerStreamCaptureIpc();
  ipcMain.handle('ffmpeg-check', () => ({ found: !!DownloadsFfmpeg.findFfmpeg(), path: DownloadsFfmpeg.findFfmpeg() || '' }));
ipcMain.handle('ffmpeg-install', () => DownloadsFfmpeg.installFfmpegPortable());

YtDlp.registerYtdlpIpc();

// === AI MODULE fallbacks (solo si el módulo AI no carga) ────
// Se definen como función pero NO se registran aún — se registran después
// del módulo AI en el catch, para que los handlers reales ganen.
//
// OJO con los nombres duplicados: `ai:adblock:*` aparece AQUÍ (stubs) y
// también en modules/adblocker/main.js (implementación real). NO es un
// conflicto ni un bug: son escenarios mutuamente excluyentes.
//
//   - El módulo AI carga bien  → sus handlers registran, los stubs NUNCA se
//     registran y los handlers reales de adblocker atienden la llamada.
//   - El módulo AI falla       → cae en el catch, se registran estos stubs y
//     la UI recibe { error: 'AI module not available' } en vez de colgarse.
//
// `ai:adblock:*` NO está en la lista de aiUnavail de abajo a propósito: los
// handlers de adblocker/main.js son los únicos que deben atender esos tres
// canales, y solo lo hacen si el módulo AI no lo reclam antes.
// Resuelve las coordenadas CSS del clic derecho (para elementFromPoint).
// params.x/y vienen en DIP; la página espera píxeles CSS. Se usa la posición
// capturada por el listener 'contextmenu' inyectado en la página (exacta),
// con fallback a la escala empírica (ancho de ventana DIP / viewport CSS).
async function resolveCtxCssPoint(wc, params) {
  try {
    const pos = await wc.executeJavaScript(`(() => {
      const p = window.__mcCtxPos;
      if (p && typeof p.x === 'number' && typeof p.y === 'number' && Date.now() - p.t < 30000) {
        return { x: Math.round(p.x), y: Math.round(p.y), src: 'page' };
      }
      return null;
    })()`);
    if (pos && typeof pos.x === 'number') return pos;
  } catch {}
  let scale = 1;
  try {
    const win = wc.getOwnerBrowserWindow();
    const size = win ? win.getContentSize() : null;
    const css = await wc.executeJavaScript('({ w: window.innerWidth || 1, h: window.innerHeight || 1 })');
    if (size && size[0] > 0 && css && css.w > 0) {
      const s = size[0] / css.w;
      if (s > 0 && s < 10) scale = s;
    }
  } catch {}
  return {
    x: Math.round((Number(params.x) || 0) / scale),
    y: Math.round((Number(params.y) || 0) / scale),
    src: 'scale'
  };
}

/* REMOVED_GENERATED_CONTENT_HANDLER
  try {
    if (!wc || wc.isDestroyed()) return;
    const pt = await resolveCtxCssPoint(wc, params);
    const code = `(async () => {
      const px = ${pt.x};
      const py = ${pt.y};
      const toDataUrl = (blob) => new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(new Error('FileReader error'));
        r.readAsDataURL(blob);
      });
      let target = null;
      let node = document.elementFromPoint(px, py);
      while (node && node.nodeType === 1) {
        const tag = node.tagName;
        if (tag === 'CANVAS' || tag === 'IMG' || tag === 'VIDEO') { target = node; break; }
        node = node.parentElement;
      }
      if (!target) {
        const cands = Array.from(document.querySelectorAll('img, video, canvas'))
          .filter(e => e.offsetWidth > 50 && e.offsetHeight > 50)
          .sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight));
        target = cands[0];
      }
      if (!target) return { error: 'No se encontró imagen/video generado en la página' };
      if (target.tagName === 'CANVAS') {
        try {
          const dataUrl = target.toDataURL('image/png');
          return { type: 'image', dataUrl, mimeType: 'image/png', name: 'generated.png' };
        } catch (e) { return { error: 'Canvas no exportable: ' + e.message }; }
      }
      if (target.tagName === 'IMG') {
        const src = target.currentSrc || target.src || '';
        if (src.startsWith('data:')) {
          const mime = (src.split(';')[0] || 'data:image/png').split(':')[1] || 'image/png';
          return { type: 'image', dataUrl: src, mimeType: mime };
        }
        if (src.startsWith('blob:')) {
          try {
            const resp = await fetch(src);
            const blob = await resp.blob();
            const dataUrl = await toDataUrl(blob);
            const mime = blob.type || 'image/png';
            return { type: 'image', dataUrl, mimeType: mime };
          } catch (e) { return { error: 'No se pudo leer la imagen: ' + e.message }; }
        }
        if (/^https?:/i.test(src)) return { type: 'url', url: src };
        return { error: 'Imagen no soportada: ' + src.slice(0, 60) };
      }
      if (target.tagName === 'VIDEO') {
        const src = target.currentSrc || target.src || '';
        if (src.startsWith('blob:')) {
          try {
            const resp = await fetch(src);
            const blob = await resp.blob();
            const dataUrl = await toDataUrl(blob);
            const mime = blob.type || 'video/mp4';
            return { type: 'video', dataUrl, mimeType: mime };
          } catch (e) { return { error: 'No se pudo leer el video: ' + e.message }; }
        }
        if (/^https?:/i.test(src)) return { type: 'url', url: src };
        return { error: 'Video no soportado: ' + src.slice(0, 60) };
      }
      return { error: 'Elemento no soportado' };
    })()`;
    const result = await wc.executeJavaScript(code, true);
    if (!result || result.error) {
      getMainWin()?.webContents?.send('save-generated-result', { ok: false, error: (result && result.error) || 'No se pudo extraer el contenido' });
      return;
    }
    if (result.type === 'url') {
      wc.downloadURL(result.url);
      return;
    }
    if (result.dataUrl) {
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(result.dataUrl);
      if (!m) {
        getMainWin()?.webContents?.send('save-generated-result', { ok: false, error: 'Formato de datos no válido' });
        return;
      }
      const mimeType = m[1];
      const data = Buffer.from(m[2], 'base64');
      const ext = mimeType.includes('png') ? '.png' : mimeType.includes('jpeg') || mimeType.includes('jpg') ? '.jpg'
        : mimeType.includes('gif') ? '.gif' : mimeType.includes('webp') ? '.webp'
        : mimeType.includes('webm') ? '.webm' : mimeType.includes('mp4') ? '.mp4'
        : mimeType.includes('ogg') ? '.ogv' : '.bin';
      const dlDir = CFG.downloadDir || app.getPath('downloads');
      if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
      const defaultName = 'generado-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + ext;
      const saveRes = await dialog.showSaveDialog({
        defaultPath: path.join(dlDir, defaultName),
        filters: [
          { name: 'Archivo generado', extensions: [ext.replace('.', '')] },
          { name: 'Todos los archivos', extensions: ['*'] }
        ]
      });
      if (saveRes.canceled || !saveRes.filePath) return;
      fs.writeFileSync(saveRes.filePath, data);
      const dlId = 'dl-save-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      const pageUrl = wc.getURL();
      ACTIONS.emit('dl-native', {
        id: dlId,
        url: pageUrl,
        filename: path.basename(saveRes.filePath),
        totalBytes: data.length,
        pageUrl,
        state: 'active'
      });
      ACTIONS.emit('dl-native-done', {
        id: dlId,
        url: pageUrl,
        filename: path.basename(saveRes.filePath),
        file: saveRes.filePath,
        size: (data.length / 1048576).toFixed(1),
        state: 'completed',
        cancelled: false
      });
      getMainWin()?.webContents?.send('save-generated-result', { ok: true, path: saveRes.filePath });
    }
  } catch (err) {
    getMainWin()?.webContents?.send('save-generated-result', { ok: false, error: err.message || String(err) });
  }
}
*/

// === WINDOW EVENTS (popups -> nueva pestaña) ────────────

WindowsWebcontents.registerWebContentsListeners({
  saveBlobOrDataUrlToDownloads,
  resolveCtxCssPoint
});

// ── Documentos asociados (PDF / DOCX / TXT / MD) ──
// En Windows y Linux, abrir un archivo con la app no dispara `open-file`: la
// ruta llega como argumento de linea de comandos, en el primer arranque o en
// === APP LIFECYCLE ===
// Bloqueo de instancia única: si ya hay una instancia de MC Browser corriendo,
// la nueva se cierra y enfoca la ventana existente. Evita conflictos de caché/
// sesión (persist:mc) que rompen WhatsApp al lanzar el proyecto varias veces.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
}


WindowIpc.registerWindowIpc();
External.registerExternalIpc();

app.whenReady().then(() => {
  if (!gotTheLock) return;
  if (process.env.MC_PCH_DIAG === '1') {
    try {
      const { crashReporter } = require('electron');
      const dumpsDir = path.join(app.getPath('userData'), 'pch-crashdumps');
      fs.mkdirSync(dumpsDir, { recursive: true });
      app.setPath('crashDumps', dumpsDir);
      crashReporter.start({ uploadToServer: false, compress: false });
      console.log('[PCH-CRASH] crashReporter local ->', dumpsDir);
    } catch (e) { console.log('[PCH-CRASH] setup-fail', e.message); }
  }
  WindowsCreate.createWindow();
  getMainWin().webContents.once('did-finish-load', () => {
    const pendingExt = External.consumePendingExternalUrl();
    if (pendingExt) External.openExternalUrl(pendingExt);
    // Si la app se lanzo con un documento asociado, recien ahora que el renderer
    // esta listo se puede avisarle que muestre la pestana de Documentos.
    External.flushPendingDocument();
  });
  if (process.env.MC_PCH_DIAG === '1') {
    try {
      const installMainWatcher = () => {
        getMainWin()?.webContents?.executeJavaScript(`(() => {
          if (window.__mcMainWatch) return 'already';
          window.__mcMainWatch = true;
          const snap = (el) => {
            try {
              const r = el.getBoundingClientRect();
              return JSON.stringify({
                tag: el.tagName,
                cls: String(el.className||'').slice(0,60),
                id: el.id,
                src: (el.getAttribute('src')||'').slice(0,200),
                srcdoc: (el.getAttribute('srcdoc')||'').slice(0,60),
                sandbox: el.getAttribute('sandbox'),
                partition: el.getAttribute('partition'),
                styleAttr: (el.getAttribute('style')||'').slice(0,120),
                display: window.getComputedStyle(el).display,
                vis: !!(el.offsetWidth||el.offsetHeight),
                rect: [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],
                parent: (el.parentElement ? (el.parentElement.tagName + '.' + String(el.parentElement.className||'').slice(0,30)) : 'root'),
              });
            } catch (e) { return 'snap-err'; }
          };
          const seen = new WeakSet();
          const report = (el) => {
            if (seen.has(el)) return;
            seen.add(el);
            console.log('[PCH-MAIN-WV] ADD ' + el.tagName + ' ' + snap(el));
          };
          const scan = (root) => {
            if (!root) return;
            if (/WEBVIEW|IFRAME/i.test(root.tagName || '')) report(root);
            root.querySelectorAll && root.querySelectorAll('webview, iframe').forEach(report);
          };
          scan(document);
          new MutationObserver((muts) => {
            for (const m of muts) {
              for (const n of (m.addedNodes || [])) {
                if (n && n.nodeType === 1) scan(n);
              }
            }
          }).observe(document.documentElement, { childList: true, subtree: true });
          return 'installed';
        })()`).then((r) => console.log('[PCH-MAIN] watcher', r)).catch((e) => console.log('[PCH-MAIN] watcher-fail', e.message));
      };
      const wc = getMainWin()?.webContents;
      if (wc) {
        if (wc.isLoading()) wc.once('dom-ready', installMainWatcher);
        else installMainWatcher();
      }
    } catch (e) { console.log('[PCH-MAIN] setup-exc', e.message); }
  }
  const sess = session.fromPartition('persist:mc');
  SessionsWebchat.setupWebchatSession();
  for (const s of (CFG.extraSessions || [])) {
    try { SessionsExtra.setupExtraSession(session.fromPartition(Sessions.extraSessionPartition(s.id))); } catch (e) { console.error('[sessions:init]', e.message); }
  }
  // Panel aislado de Perchance: debe usar resolver nativo del sistema y no
  // quedar bloqueado por secure DNS/DoH de la app.
  app.configureHostResolver({ secureDnsMode: 'off' });
  PerchancePaneInit.setupPerchancePanel();
  SessionsWhatsapp.setupWhatsappSession();
  ACTIONS.emit = (ch, ...args) => { try { getMainWin()?.webContents?.send(ch, ...args); } catch {} };
  // Desactivado: la señalización automática de auth-session-updated provoca
  // redirecciones durante el flujo OAuth de Google/X y rompe el login de la
  // segunda cuenta. El navegador debe dejar completar la autenticación sin
  // interrumpir la sesión del proveedor.
  let authCookieTimer = null;
  Proxy.applyProxyFromCfg(sess, '');

  // ── Descargas nativas del navegador (will-download) ──
  // Captura descargas normales (botón "Descargar", enlaces directos, etc.)
  // que no pasan por el detector de streams, y las muestra en el panel.
  // (extraído a DownloadsNative.registerNativeDownloadHandler() para poder engancharlo
  // también en cada sesión aislada — ver setupExtraSession)
  DownloadsNative.registerNativeDownloadHandler(sess);

  // ── Live request log & cookie interception ──
  Headers.installHeaderInterceptors(sess, {
    isStreamHlsCaptureEnabled: StreamCapture.isStreamHlsCaptureEnabled,
    consumeStreamEntryReferer: StreamCapture.consumeStreamEntryReferer,
    findHlsPlayerEntry: StreamCapture.findHlsPlayerEntry,
  });


  MemoryStore.registerMemoryIpc();

  // checkMedia y los contadores de requests viven ahora en src/main/stats/, a
  // proposito en nivel de modulo para poder reutilizarlos en SessionsExtra.setupExtraSession()
  // igual que en la sesion principal. Ver src/main/stats/README.md.
  Modules.registerModules({
    CFG, saveCfg, getMainWin, ACTIONS, External, sess,
    NavDomains, MediaDetect, StatsTracker, RequestGuard, DoH, resolveSafePath
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      WindowsCreate.createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  saveCfg();
  if (process.platform !== 'darwin') app.quit();
});
