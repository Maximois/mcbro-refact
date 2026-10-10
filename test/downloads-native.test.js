'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MOD = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'downloads', 'native.js'),
  'utf8'
);
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src/main/bootstrap.js'), 'utf8');
// El docstring del modulo nombra el estado que bootstrap.js ya no debe tener, asi
// que las ausencias se buscan solo en el codigo, tras el primer */.
const codigo = MOD.slice(MOD.indexOf('*/') + 2);

const CUENTA = (re) => (MAIN.match(re) || []).length;
const CANALES = ['dl-native-pause', 'dl-native-resume', 'dl-native-cancel', 'dl-native-retry', 'dl-native-state'];

describe('downloads/native.js - el modulo', () => {
  test('el codigo compila (esto frena un archivo roto colado por las aserciones de texto)', () => {
    // Las demas aserciones leen el archivo como texto, asi que un error de
    // sintaxis no las afectaria. vm.Script lo detecta sin ejecutar nada.
    assert.doesNotThrow(() => new vm.Script(codigo), 'native.js debe ser JS valido');
  });

  test('el handler llega entero, con su will-download', () => {
    assert.match(codigo, /function registerNativeDownloadHandler\(sess\) \{/);
    assert.match(codigo, /sess\.on\('will-download', \(event, item, webContents\) => \{/);
    // El registro guarda pageUrl/savePath/ts ademas de lo minimo: son los que
    // permiten reanudar SIN DownloadItem tras reiniciar (persistencia).
    assert.match(codigo, /nativeDlRegistry\.set\(dlId, \{\s*id: dlId, item, url, filename, type, totalBytes, webContentsId: webContents\?\.id,\s*pageUrl, savePath, ts: Date\.now\(\), state: 'active'\s*\}\);/);
  });

  test('los IPC de control quedan dentro del modulo', () => {
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
  // item.resume() de Chromium REINICIA en silencio cuando el servidor no
  // contesta 206 (caso de casi todos los hosts de descargas directas). La
  // ruta unica es el reanudador con Range propio: nunca item.resume().
  test('item.resume() nunca se llama: el Range propio es la via unica', () => {
    assert.doesNotMatch(codigo, /item\.resume\(\);/, 'Chromium reinicia en silencio si el servidor no da 206');
    assert.doesNotMatch(codigo, /canResume\(/, 'la compuerta canResume() desaparecio: ya no se decide ahi); reanudar usa Range propio');
    assert.match(codigo, /resumeNativeWithRange\(entry, targetUrl\)\.then/);
    assert.match(codigo, /function resumeNativeWithRange\(entry, targetUrl\)/);
  });

  test('el reanudador con Range usa Range desde el byte del parcial (.crdownload)', () => {
    assert.match(codigo, /const partial = savePath \+ '\.crdownload';/);
    assert.match(codigo, /headers\.Range = 'bytes=' \+ startByte \+ '-'/);
    assert.match(codigo, /hasPartial && status === 206/);
    assert.match(codigo, /hasPartial && status === 200/);
    assert.doesNotMatch(codigo, /fs\.(unlink|rm|rmSync)\(partial\)/, 'no debe borrarse el parcial al fallar');
  });

  test('un 200 (servidor que ignora Range) continua saltando bytes, sin reiniciar', () => {
    // El servidor manda el cuerpo entero: se descartan los primeros startByte
    // bytes en el stream y el resto se agrega al parcial. No hay cero de nuevo.
    assert.match(codigo, /checkHtml: true, skipBytes: startByte/);
    assert.match(codigo, /if \(skip > 0\) \{/);
    assert.match(codigo, /chunk = chunk\.slice\(skip\);/);
    // Si el cuerpo del 200 es HTML (enlace expirado) NUNCA se toca el parcial.
    assert.match(codigo, /ct\.includes\('text\/html'\) \|\| \/\^<\(\?:!doctype\|html\|head\|body\|title\)\/\.test\(head\)/);
    assert.match(codigo, /return finish\('no-resume-support'\);/);
    assert.doesNotMatch(codigo, /fs\.(unlink|rm|rmSync)\(partial\)/);
  });

  test('sin parcial no se congela: se reinicia desde cero avisando al panel', () => {
    // Chromium borra el .crdownload al salir o el user lo limpió: el Range sin
    // parcial fallaría con 'no-partial' y la fila quedaría muerta. Ahí se hace
    // un arranque nuevo con el stream propio (la fila AVANZA).
    assert.match(codigo, /!hasPartial && \(status === 206 \|\| status === 200\)/);
    assert.match(codigo, /startByte: 0, totalBytes, checkHtml: true/);
    assert.match(codigo, /dl-native-note/);
    assert.match(codigo, /No había archivo parcial: se reinicia desde cero/);
    assert.doesNotMatch(codigo, /return resolve\('no-partial'\)/, 'ya no existe el fallo que congelaba');
  });

  test('si el archivo ya está completo en disco se cierra como done', () => {
    // App cerrada justo al terminar: el estado decía paused pero el archivo
    // entero está. No se vuelve a descargar nada.
    assert.match(codigo, /fs\.stat\(savePath, \(saveErr, sf\) => \{/);
    assert.match(codigo, /finishNativeAsDone\(entry, savePath, sf\.size\);/);
  });

  test('un 416 con el parcial al total se resuelve como done', () => {
    assert.match(codigo, /hasPartial && status === 416 && totalBytes > 0 && startByte >= totalBytes/);
    assert.match(codigo, /finishNativeAsDone\(entry, savePath, startByte\);/);
  });

  test('el cierre como done sale por un solo helper compartido', () => {
    assert.match(codigo, /function finishNativeAsDone\(entry, savePath, totalBytes\)/);
    assert.match(codigo, /ACTIONS\.emit\('dl-native-done'/);
  });

  test('MediaFire se re-mintia a traves del extractor, antes de lanzar el Range', () => {
    assert.match(codigo, /const ex = pickExtractor\(entry\.url\);/);
    assert.match(codigo, /const minted = await ex\.mint\(entry\.pageUrl \|\| entry\.url\);/);
    assert.match(codigo, /reason: ex\.name \+ '-remint-fail'/);
    assert.doesNotMatch(codigo, /mintMediaFireUrl\(/);
    assert.doesNotMatch(codigo, /isMediaFireUrl\(/);
  });

  test('la entrada stale (sin DownloadItem) se reconstruye desde los datos del renderer', () => {
    // App reiniciada: el registro estaba vacio y el renderer manda saved.
    assert.match(codigo, /function makeStaleEntry\(id, saved\)/);
    assert.match(codigo, /if \(!saved\.url\) return \{ ok: false \};/);
    assert.match(codigo, /entry = makeStaleEntry\(id, saved\);/);
    assert.match(codigo, /savePath: resolveSafePath\(dlDir, filename\) \|\| path\.join\(dlDir, 'descarga'\),/);
  });

  test('cancelar aborta un reanudador con Range en vuelo, con o sin item vivo', () => {
    assert.match(codigo, /entry\.fallbackAbort = true;/);
    assert.match(codigo, /entry\.fallbackReq\.destroy\(\)/);
    assert.match(codigo, /if \(entry\.item\) entry\.item\.cancel\(\);/);
  });
});

describe('downloads/native.js - persistencia del estado', () => {
  test('el registro resumible se persiste en un JSON de userData', () => {
    assert.match(codigo, /path\.join\(app\.getPath\('userData'\), 'dl-state\.json'\)/);
    assert.match(codigo, /function persistDownloadEntries\(\)/);
    assert.match(codigo, /function loadDlState\(\)/);
    assert.match(codigo, /function saveDlStateSoon\(\)/);
  });

  test('solo se persisten activas|pausadas (las terminadas salen del JSON)', () => {
    assert.match(codigo, /\.filter\(\(e\) => e && \(e\.state === 'active' \|\| e\.state === 'paused'\)\)/);
    assert.doesNotMatch(codigo, /e\.state === 'done'/);
  });

  test('al recargar, las perseguidas entran al registro como paused con item null', () => {
    // Sin DownloadItem, el reanudador con Range lee el .crdownload del disco.
    assert.match(codigo, /state: 'paused', fallbackAbort: false, fallbackReq: null, item: null/);
    assert.match(codigo, /const savePath = resumeEntrySavePath\(entry\);/);
    assert.match(codigo, /if \(entry\.item && typeof entry\.item\.getSavePath === 'function'\) return entry\.item\.getSavePath\(\);/);
  });

  test('dl-native-state devuelve a mitad de vuelo lo que el renderer debe mostrar', () => {
    assert.match(codigo, /ipcMain\.handle\('dl-native-state'/);
    assert.match(codigo, /state: 'interrupted', native: true/);
  });
});

describe('downloads/native.js - extractores (net.js + extractors/)', () => {
  test('net.js, extractors/ y extractors/index compilan', () => {
    for (const rel of ['src/main/downloads/net.js',
      'src/main/downloads/extractors/mediafire.js',
      'src/main/downloads/extractors/generic.js',
      'src/main/downloads/extractors/index.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      try { new vm.Script(src); } catch (e) { throw new Error(`${rel} no compila: ${e.message}`); }
    }
  });

  test('net.js expone el cliente HTTP con redirects y el User-Agent', () => {
    const net = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'downloads', 'net.js'),
      'utf8'
    );
    assert.match(net, /module\.exports = \{ BROWSER_UA, fetchWithRedirects \};/);
    assert.match(net, /301, 302, 303, 307, 308\]\.includes\(status\)/);
    assert.match(net, /Array\.isArray\(res\.headers\.location\) \? res\.headers\.location\[0\] : res\.headers\.location/);
    assert.doesNotMatch(net, /res\.headers\.location\[0\] \|\| res\.headers\.location/, 'location[0] sobre un string es el primer char: rompia los redirects');
  });

  test('mediafire.js es un extractor: { name, match, mint }', () => {
    const mf = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'downloads', 'extractors', 'mediafire.js'),
      'utf8'
    );
    assert.match(mf, /module\.exports = \{ name: 'mediafire', match, mint \};/);
    assert.match(mf, /const MEDIAFIRE_HOST_RE = \/\(\^\|\\\.\)mediafire\\\.com\$\/i;/);
    assert.match(mf, /function extractDirectUrl\(html, quickKey\)/);
    assert.match(mf, /download\[0-9\]\+\(\?:-\[a-z0-9\]\+\)\?\\\.mediafire\\\.com/);
    assert.match(mf, /return `https:\/\/download\$\{server\[1\]\}\.mediafire\.com\/\$\{hash\[1\]\}\/\$\{quickKey\}\/\$\{fn\}`;/);
  });

  test('generic.js matchea cualquier http(s) y no sabe re-mintiar', () => {
    const g = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'downloads', 'extractors', 'generic.js'),
      'utf8'
    );
    assert.match(g, /module\.exports = \{ name: 'generic', match \};/);
    assert.match(g, /function match\(u\)/);
    assert.match(g, /String\(u\)/);
  });

  test('index.js registra mediafire y cae en generic para el resto', () => {
    const idx = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'downloads', 'extractors', 'index.js'),
      'utf8'
    );
    assert.match(idx, /const EXTRACTORS = \[mediafire\];/);
    assert.match(idx, /function pickExtractor\(url\)/);
    assert.match(idx, /return generic;/);
    assert.doesNotMatch(idx, /pixeldrain/);
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