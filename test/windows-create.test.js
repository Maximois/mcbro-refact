'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const leer = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const MAIN = leer('src/main/bootstrap.js');
const CREATE = leer('src', 'main', 'windows', 'create.js');
const codigo = (s) => s.slice(s.indexOf('*/') + 2);

describe('windows/create.js -- la extraccion', () => {
  test('bootstrap.js ya no define createWindow, lo registra dos veces', () => {
    assert.doesNotMatch(MAIN, /function createWindow\(\)/);
    assert.match(MAIN, /const WindowsCreate = require\('\.\/windows\/create'\);/);
    assert.equal((MAIN.match(/WindowsCreate\.createWindow\(\);/g) || []).length, 2,
      'una inicial y una de recrear tras cerrar');
  });

  test('el bloque salio completo: persist:mc, frame:false y sus prefeerences', () => {
    assert.match(CREATE, /session\.fromPartition\('persist:mc'\)/);
    assert.match(CREATE, /frame: false/);
    assert.match(CREATE, /preload: path\.join\(__dirname, '\.\.', '\.\.', '\.\.', 'preload\.js'\)/);
    assert.match(CREATE, /partition: 'persist:mc'/);
    assert.match(CREATE, /contextIsolation: true/);
    assert.match(CREATE, /webviewTag: true/);
    assert.match(CREATE, /setMainWin\(new BrowserWindow\(\{/);
    assert.match(CREATE, /win\.loadFile\(path\.join\(__dirname, '\.\.', '\.\.', 'renderer\.html'\)\);/);
  });

  test('las las* permisos se establecen en la propia sesion persist:mc', () => {
    const cuerpo = codigo(CREATE);
    const i = cuerpo.indexOf('function createWindow() {');
    assert.ok(i > -1);
    const bloque = cuerpo.slice(i, cuerpo.indexOf('win.once(\'closed\'', i));
    assert.match(bloque, /PermissionsHandlers\.setupSessionPermissionHandlers\(sess\);/);
  });

  test('hot-reload requiere AMBAS banderas, nunca una sola', () => {
    assert.match(codigo(CREATE), /if \(process\.env\.MC_DEV === '1' && process\.env\.MC_HOT_RELOAD === '1'\) \{/);
    assert.doesNotMatch(codigo(CREATE), /MC_DEV === '1' \|\| /);
  });

  test('FIXADO: hay debounce de 300 ms en el reload del watcher', () => {
    // Sin debounce, cada save toca watchers 3 veces y se recarga 3 veces
    // seguidas. Con 20 edits en 300 ms solo hay un reload: se reinicia el
    // timer y no se acumulan watchers.
    assert.match(codigo(CREATE), /const scheduleReload = \(\) => \{\s*if \(devReloadTimer\) clearTimeout\(devReloadTimer\);/);
    assert.match(codigo(CREATE), /devReloadTimer = setTimeout\(\(\) => \{\s*devReloadTimer = null;\s*if \(win && !win\.isDestroyed\(\)\) \{\s*console\.log\('\[DEV\] Hot-reload/);
  });

  test('FIXADO: el timer no dispara si la ventana ya murio', () => {
    assert.match(codigo(CREATE), /if \(win && !win\.isDestroyed\(\)\) \{\s*console\.log/);
  });

  test('los watchers se cierran al recrear la ventana o al cerrarla', () => {
    assert.match(codigo(CREATE), /for \(const watcher of devWatchers\) \{\s*try \{ watcher\.close\(\); \} catch \{\}\s*\}\s*devWatchers = \[\];/);
    assert.match(codigo(CREATE), /win\.once\('closed', \(\) => \{\s*for \(const watcher of devWatchers\)/);
    assert.match(codigo(CREATE), /devReloadTimer = null;/);
  });

  test('fs.watch se instala midiendo errores por carpeta, sin romper el todo', () => {
    assert.match(codigo(CREATE), /for \(const p of watchPaths\) \{\s*try \{\s*const watcher = fs\.watch\(p, \{ recursive: true \},/);
    assert.match(codigo(CREATE), /devWatchers\.push\(watcher\);/);
  });

  test('el listener de Ctrl+Shift+I no se comenta: es el equivalente a DevTools', () => {
    assert.match(codigo(CREATE), /if \(input\.type === 'keyDown' && input\.control && input\.shift && input\.key\.toLowerCase\(\) === 'i'\) \{\s*event\.preventDefault\(\);\s*win\.webContents\.openDevTools/);
  });
});