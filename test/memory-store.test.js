'use strict';

// src/main/memory/store.js hace require('electron'), asi que no se puede
// importar en un test de node plano.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const leer = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const MAIN = leer('src/main/bootstrap.js');
const STORE = leer('src', 'main', 'memory', 'store.js');
const codigo = (s) => s.slice(s.indexOf('*/') + 2);

describe('memory/store.js -- la extraccion', () => {
  test('bootstrap.js solo lo carga y lo registra', () => {
    assert.match(MAIN, /const MemoryStore = require\('\.\/memory\/store'\);/);
    assert.match(MAIN, /MemoryStore\.registerMemoryIpc\(\);/);
    assert.doesNotMatch(MAIN, /ipcMain\.handle\('memory:/);
    assert.doesNotMatch(MAIN, /ipcMain\.handle\('reminders:/);
    for (const canal of ['memory:list', 'memory:search', 'memory:add', 'memory:update',
      'memory:delete', 'memory:archive', 'memory:recent', 'reminders:list',
      'reminders:add', 'reminders:complete', 'reminders:delete']) {
      assert.match(STORE, new RegExp(`ipcMain\\.handle\\('${canal}'`), `falta ${canal}`);
    }
  });

  test('las rutas salen de userData, dentro de bootstrap.js (setPath antes del require)', () => {
    // Tiene que estar despues de app.setPath('userData', ...), que esta en la
    // linea 28; si no, las notas de esta maquina irían al perfil equivocado.
    const requireId = MAIN.indexOf("require('./memory/store')");
    const setPathId = MAIN.indexOf("app.setPath('userData'");
    assert.ok(requireId > setPathId, 'require de store.js ANTES que setPath');
    assert.match(STORE, /const MEMORY_DIR = path\.join\(app\.getPath\('userData'\), 'memory'\);/);
  });
});

describe('memory/store.js -- TRAMPA 1: lee y escribe la tabla entera cada vez', () => {
  test('cada handler carga con loadJson y guarda con saveJson, sin cache', () => {
    const cuerpo = codigo(STORE);
    const cargar = (cuerpo.match(/loadJson\(/g) || []).length;
    const guardar = (cuerpo.match(/saveJson\((?:ENTRIES_FILE|REMINDERS_FILE)/g) || []).length;
    // Modo setter: estos son puntos frágiles, pero el invariante es la
    // ESTREMA de que cada handler sigue usando loadJson + saveJson.
    assert.ok(cargar >= 11, 'al menos uno por canal de lectura y escritura');
    assert.ok(guardar >= 5, 'uno por handler que escribe');
    assert.equal((cuerpo.match(/new Map/g) || []).length, 0, 'sin cache en memoria');
  });

  test('FIXADO: un JSON roto devuelve el fallback, no retumba', () => {
    // Si fallara con throw, un archivo corrupto haria fallar TODA la app, y
    // la pagina de memoria ni siquiera podria archivar el sucio.
    assert.match(codigo(STORE), /function loadJson\(file, fallback = \[\]\) \{\s*try \{ if \(fs\.existsSync\(file\)\) return JSON\.parse\(fs\.readFileSync\(file, 'utf8'\)\); \} catch \{\}\s*return fallback;\s*\}/);
  });

  test('save siempre recrea el directorio, si hace falta', () => {
    assert.match(codigo(STORE), /function saveJson\(file, data\) \{\s*ensureDir\(path\.dirname\(file\)\);/);
  });
});

describe('memory/store.js -- TRAMPA 2: update con merge, no reemplazo', () => {
  test('el patch mergea, y updatedAt se actualiza', () => {
    assert.match(codigo(STORE), /entries\[idx\] = \{ \.\.\.entries\[idx\], \.\.\.patch, updatedAt: Date\.now\(\) \};/);
  });

  test('FIXADO: update devuelve Not found si el id no existe, NO retumba', () => {
    // Solo en el body de memory:update: la misma linea aparece en archive,
    // y matchear todo el archivo no caza mutarlo aqui.
    const bloque = codigo(STORE).split("ipcMain.handle('memory:update'")[1].split("ipcMain.handle")[0];
    assert.match(bloque, /if \(idx === -1\) return \{ error: 'Not found' \};/);
  });
});

describe('memory/store.js -- los ordenes son a proposito', () => {
  test('memory:list ordena por updatedAt, memory:recent por createdAt', () => {
    assert.match(codigo(STORE), /ipcMain\.handle\('memory:list'[\s\S]*?\(b\.updatedAt \|\| b\.createdAt \|\| 0\) - \(a\.updatedAt \|\| a\.createdAt \|\| 0\)/);
    assert.match(codigo(STORE), /ipcMain\.handle\('memory:recent'[\s\S]*?\(b\.createdAt \|\| 0\) - \(a\.createdAt \|\| 0\)/);
  });

  test('reminders:list va por dueDate, pendientes primero si lo piden', () => {
    assert.match(codigo(STORE), /let reminders = loadJson\(REMINDERS_FILE, \[\]\);\s*if \(filters\.pending\) reminders = reminders\.filter\(r => !r\.completed\);\s*return reminders\.sort\(\(a, b\) => \(a\.dueDate \|\| 0\) - \(b\.dueDate \|\| 0\)\);/);
  });

  test('memory:search busca en titulo, url y tags, y corta en 20', () => {
    assert.match(codigo(STORE), /\[en\.title, en\.summary, en\.description, en\.url, \.\.\.\(en\.tags \|\| \[\]\), \.\.\.\(en\.keywords \|\| \[\]\)\]/);
    assert.match(codigo(STORE), /\.slice\(0, 20\);/);
  });

  test('memory:recent solo ve activos', () => {
    assert.match(codigo(STORE), /return entries\.filter\(en => en\.status === 'active'\)\.sort/);
  });
});

describe('memory/store.js -- los defaults salen del entry mandado', () => {
  test('memory:add con campos faltantes no los deja undefined', () => {
    assert.match(codigo(STORE), /type: entry\.type \|\| 'note'/);
    assert.match(codigo(STORE), /importance: entry\.importance \|\| 'medium'/);
    assert.match(codigo(STORE), /status: entry\.status \|\| 'active'/);
    assert.match(codigo(STORE), /createdAt: now, updatedAt: now/);
  });

  test('reminders:add arranca sin completar y con prioridad normal', () => {
    assert.match(codigo(STORE), /completed: false/);
    assert.match(codigo(STORE), /priority: reminder\.priority \|\| 'normal'/);
  });

  test('reminders:complete marca completed y completedAt', () => {
    assert.match(codigo(STORE), /reminders\[idx\]\.completed = true;\s*reminders\[idx\]\.completedAt = Date\.now\(\);/);
  });

  test('memory:archive marca status archived y updatedAt', () => {
    assert.match(codigo(STORE), /entries\[idx\]\.status = 'archived';\s*entries\[idx\]\.updatedAt = Date\.now\(\);/);
  });
});

describe('memory/store.js -- los IDs y el nombre de archivo', () => {
  test('los archivos son entries.json y reminders.json en el userData', () => {
    assert.match(STORE, /const MEMORY_DIR = path\.join\(app\.getPath\('userData'\), 'memory'\);/);
    assert.match(STORE, /const ENTRIES_FILE = path\.join\(MEMORY_DIR, 'entries\.json'\);/);
    assert.match(STORE, /const REMINDERS_FILE = path\.join\(MEMORY_DIR, 'reminders\.json'\);/);
  });

  test('genId es Date.now en base36 + 6 chars aleatorios', () => {
    assert.match(codigo(STORE), /function genId\(\) \{ return Date\.now\(\)\.toString\(36\) \+ Math\.random\(\)\.toString\(36\)\.slice\(2, 8\); \}/);
  });
});