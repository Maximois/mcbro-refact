'use strict';
/**
 * MC Browser -- src/main/windows/create.js
 *
 * La creacion de la ventana principal: el BrowserWindow con frame=false, el
 * preload, la particion persist:mc, y el watcher de hot-reload que se activa
 * solo en MC_DEV + MC_HOT_RELOAD.
 *
 * El bloque fue extraido de main.js tal cual. Los watchers se quedan en este
 * modulo como closure: antes vivian en variables globales de main.js y ahora en
 * este modulo, y el cierre de cada watcher se hace aqui mismo al recargar o al
 * cerrar la ventana.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- el hot-reload no es un daemon; es una cola de timers
 * -----------------------------------------------------------------------------
 * Cada vuelta de watcher llama a scheduleReload, que pone devReloadTimer a
 * 300 ms. Si llegan 20 cambios en 300 ms se reinicia el timer y solo hay un
 * recargado. Nunca se acumulan: es debounce. Se limpia el timer además en el
 * cierre y al crear la ventana, para no recarcar una ventana muerta.
 *
 * Y `process.env.MC_DEV === '1' && process.env.MC_HOT_RELOAD === '1'` que es
 * producto: main.js pasa la bandera con MC_DEV=1; si alguien pone MC_DEV=0 y
 * MC_HOT_RELOAD=1, el watcher NO se enciende. La doble comprobacion es
 * intencional: el hot-reload enscenara siempre detrás del modo dev.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- la ventana se define antes que la bd del usuario
 * -----------------------------------------------------------------------------
 * Este modulo se asigna al cargar main.js, pero la funcion NO se ejecuta hasta
 * que createWindow() sea llamada. No yevalúa rutas ni ajustes al cargarse. Se
 * garantiza llamando a createWindow() DESPUES de app.setPath('userData') y
 * las llamadas de config: si se adelantdl teniendo main.js, los datos iran al
 * perfil equivocado.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 3 -- el modal no se desactiva
 * -----------------------------------------------------------------------------
 * la notificacion de la contraseña de Perchance pasa por confirm() del
 * webview; comentar ese listener 'before-input-event' aqui no rompe nada
 * visible pero los dialogos de alert/confirm/prompt devuelven false en
 * silencio y los botones de la pagina parecen muertos. Por eso la cabecera lo
 * dice con mayusculita.
 */

const fs = require('fs');
const path = require('path');
const { BrowserWindow, session } = require('electron');
const { setMainWin } = require('../runtime');
const PermissionsHandlers = require('../permissions/handlers');

let devWatchers = [];
let devReloadTimer = null;


function createWindow() {
  for (const watcher of devWatchers) {
    try { watcher.close(); } catch {}
  }
  devWatchers = [];
  if (devReloadTimer) {
    clearTimeout(devReloadTimer);
    devReloadTimer = null;
  }
  const sess = session.fromPartition('persist:mc');
  PermissionsHandlers.setupSessionPermissionHandlers(sess);

  const win = setMainWin(new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, '..', '..', '..', 'assets', 'icon.png'),
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', '..', 'preload.js'),
      partition: 'persist:mc',
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      sandbox: true,
      enableRemoteModule: false,
      webviewTag: true
    }
  }));

  win.loadFile(path.join(__dirname, '..', '..', 'renderer.html'));
  // Perchance necesita alert/confirm/prompt (allow-modals del iframe + revelar
  // NSFW "show image"). NUNCA pongas disableDialogs aquí: confirm() devolvería
  // false en silencio y los botones parecerían muertos.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
      event.preventDefault();
      win.webContents.openDevTools({ mode: 'detach' });
    }
  });
  // ── Hot-reload en modo dev ──
  if (process.env.MC_DEV === '1' && process.env.MC_HOT_RELOAD === '1') {
    const watchPaths = [
      path.join(__dirname, '..', '..', '..', 'src'),
      path.join(__dirname, '..', '..', '..', 'modules'),
      path.join(__dirname, '..', '..', '..', 'preload.js')
    ];
    const scheduleReload = () => {
      if (devReloadTimer) clearTimeout(devReloadTimer);
      devReloadTimer = setTimeout(() => {
        devReloadTimer = null;
        if (win && !win.isDestroyed()) {
          console.log('[DEV] Hot-reload: recargando renderer...');
          win.webContents.reloadIgnoringCache();
        }
      }, 300);
    };
    for (const p of watchPaths) {
      try {
        const watcher = fs.watch(p, { recursive: true }, (evt, filename) => {
          if (filename && !filename.endsWith('.backup')) scheduleReload();
        });
        devWatchers.push(watcher);
      } catch {}
    }
    console.log('[DEV] Hot-reload activo para:', watchPaths.join(', '));
  }
  win.once('closed', () => {
    for (const watcher of devWatchers) {
      try { watcher.close(); } catch {}
    }
    devWatchers = [];
    if (devReloadTimer) {
      clearTimeout(devReloadTimer);
      devReloadTimer = null;
    }
  });
}

module.exports = { createWindow };
