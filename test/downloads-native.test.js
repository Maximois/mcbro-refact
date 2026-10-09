'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MOD = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'downloads', 'native.js'),
  'utf8'
);
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src/main/bootstrap.js'), 'utf8');
// El docstring del modulo nombra el estado que bootstrap.js ya no debe tener, asi
// que las ausencias se buscan solo en el codigo, tras el primer */.
const codigo = MOD.slice(MOD.indexOf('*/') + 2);

const CUENTA = (re) => (MAIN.match(re) || []).length;
const CANALES = ['dl-native-pause', 'dl-native-resume', 'dl-native-cancel', 'dl-native-retry'];

describe('downloads/native.js - el modulo', () => {
  test('el handler llega entero, con su will-download', () => {
    assert.match(codigo, /function registerNativeDownloadHandler\(sess\) \{/);
    assert.match(codigo, /sess\.on\('will-download', \(event, item, webContents\) => \{/);
    assert.match(codigo, /nativeDlRegistry\.set\(dlId, \{ id: dlId, item, url, filename, type, webContentsId: webContents\?\.id, state: 'active' \}\);/);
  });

  test('los cuatro IPC de control quedan dentro del modulo', () => {
    assert.match(codigo, /function registerNativeDownloadIpc\(\) \{/);
    for (const ch of CANALES) {
      assert.match(codigo, new RegExp(`ipcMain\\.handle\\('${ch}'`));
      // Indentados: la comprobacion anterior no distingue 'suelto a nivel de
      // modulo' de 'dentro de la funcion', que es justo lo que se quiere ver.
      assert.ok(
        codigo.split('\n').some((l) => l.startsWith(`  ipcMain.handle('${ch}'`)),
        `${ch} deberia estar indentado dentro de registerNativeDownloadIpc()`
      );
    }
    assert.match(codigo, /module\.exports = \{\s*registerNativeDownloadHandler,\s*registerNativeDownloadIpc,\s*\};/);
  });

  test('el estado no se escapa: ni el Map ni el testigo', () => {
    assert.match(codigo, /^const nativeDlRegistry = new Map\(\);/m);
    assert.match(codigo, /^let pendingNativeRetryId = null;$/m);
    const exportado = MOD.slice(MOD.indexOf('module.exports'));
    assert.doesNotMatch(exportado, /nativeDlRegistry/);
    assert.doesNotMatch(exportado, /pendingNativeRetryId/);
  });

  test('el testigo se consume una sola vez, no se queda puesto', () => {
    // La trampa de este modulo: si pendingNativeRetryId sobrevive a una URL que
    // no dispara will-download, el siguiente will-download de cualquier pagina
    // hereda un id de reintento equivocado.
    assert.match(
      codigo,
      /const dlId = pendingNativeRetryId \|\| \('dl-native-'[\s\S]*?pendingNativeRetryId = null;/
    );
  });

  test('Perchance se salta, y el filtro mira el host de la PAGINA', () => {
    // Si mirara el host de la URL descargada en vez del de la pagina, una
    // descarga hecha desde una pagina de Perchance de un host de terceros se
    // colaria por este modulo y competiria con su propio handler.
    assert.match(codigo, /const host = new URL\(pageUrl\)\.hostname\.toLowerCase\(\);/);
    assert.match(codigo, /if \(host === 'perchance\.org' \|\| host\.endsWith\('\.perchance\.org'\)\) return;/);
    assert.match(codigo, /const pageUrl = wc && !wc\.isDestroyed\(\) \? wc\.getURL\(\) \|\| '' : '';/);
    // Y el descarte tiene que ocurrir antes de tocar la descarga, no despues.
    assert.ok(
      codigo.indexOf("endsWith('.perchance.org')) return;") < codigo.indexOf('const url = item.getURL()'),
      'el filtro de Perchance deberia ir antes de leer la URL de la descarga'
    );
  });

  test('la poda a 200 filtra por completedAt, no por tamano del Map', () => {
    // Un `nativeDlRegistry.size > 200` borraria descargas en curso y dejaria al
    // renderer sin entrada para actualizarlas: las activas no tienen completedAt.
    assert.match(
      codigo,
      /const completed = \[\.\.\.nativeDlRegistry\.entries\(\)\]\s*\.filter\(\(\[, value\]\) => value\.completedAt\)\s*\.sort\(\(a, b\) => a\[1\]\.completedAt - b\[1\]\.completedAt\);/
    );
    assert.match(codigo, /while \(completed\.length > 200\) \{\s*nativeDlRegistry\.delete\(completed\.shift\(\)\[0\]\);\s*\}/);
    assert.doesNotMatch(codigo, /nativeDlRegistry\.size > 200/);
  });
});

describe('downloads/native.js - reanudar no reinicia en silencio', () => {
  // item.resume() cuando el servidor no soporta Range (206) hace que Chromium
  // relance la descarga desde cero. La compuerta canResume() evita ese reinicio
  // silencioso: si no se puede reanudar, devuelve el motivo y nada toca al item.
  test('canResume() decide antes de llamar a item.resume()', () => {
    assert.match(codigo, /if \(!entry\.item\.canResume\(\)\) return \{ ok: false, reason: 'no-resume-support' \};/);
    assert.ok(
      codigo.indexOf('canResume()') > -1 &&
      codigo.indexOf("entry.item.resume()") > -1 &&
      codigo.indexOf('canResume()') < codigo.indexOf("entry.item.resume()"),
      'la compuerta canResume() debe ir antes del resume()'
    );
  });
});

describe('downloads/native.js - el cableado en bootstrap.js', () => {
  test('las dos sesiones que capturan descargas lo llaman, cada una en su sitio', () => {
    // Principal desde bootstrap.js; la extra desde su modulo (paso 13). Se busca sin
    // prefijo porque los dos estilos de importacion son validos en este repo.
    const extra = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'sessions', 'extra.js'),
      'utf8'
    );
    assert.match(MAIN, /DownloadsNative\.registerNativeDownloadHandler\(sess\);/);
    assert.match(MAIN, /const DownloadsNative = require\('\.\/downloads\/native'\);/);
    assert.match(extra, /registerNativeDownloadHandler\(sess\);/);
    assert.match(extra, /require\('\.\.\/downloads\/native'\)/);
    const total = (MAIN + extra).match(/(?:\w+\.)?registerNativeDownloadHandler\(sess\);/g) || [];
    assert.equal(total.length, 2, 'principal + extra');
    assert.equal(CUENTA(/DownloadsNative\.registerNativeDownloadIpc\(\);/g), 1);
  });

  test('ninguna llamada sin cualificar en bootstrap.js', () => {
    // Sin prefijo seria ReferenceError en runtime: la funcion ya no existe alli.
    assert.doesNotMatch(MAIN, /(?<![.\w])registerNativeDownloadHandler\(/);
    assert.doesNotMatch(MAIN, /(?<![.\w])registerNativeDownloadIpc\(/);
  });

  test('el handler y su estado desaparecieron de bootstrap.js', () => {
    // Si se quedara una COPIA del Map, las dos se desincronizan en silencio:
    // el modulo registraria descargas que bootstrap.js no ve.
    assert.doesNotMatch(MAIN, /nativeDlRegistry/);
    assert.doesNotMatch(MAIN, /pendingNativeRetryId/);
    assert.doesNotMatch(MAIN, /function registerNativeDownloadHandler/);
  });

  test('los canales de control no se registran dos veces', () => {
    // Un ipcMain.handle repetido sobre el mismo canal lanza al arrancar.
    for (const ch of CANALES) {
      assert.ok(!MAIN.includes(`'${ch}'`), `${ch} sigue registrado a mano en bootstrap.js`);
    }
  });

  test('lo que se emitio desde el handler sigue saliendo igual', () => {
    // registerNativeDownloadIpc no emite nada, pero el handler emite hacia el
    // renderer. Si estos canales desaparecieran, el panel dejaria de moverse.
    for (const ch of ['dl-native-tab', 'dl-native', 'dl-native-progress', 'dl-native-done']) {
      assert.ok(codigo.includes(`'${ch}'`), `el handler deberia seguir emitiendo ${ch}`);
    }
  });
});