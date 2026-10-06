'use strict';

// downloads/registry.js y downloads/fetch.js hacen require('electron'), asi que
// no se pueden importar en un test de node plano. Estos tests leen el fuente.
//
// Cada bloque fija UNA invariante que se rompio, o que se romperia al tocar el
// codigo sin querer. Los que importan son los que un fallo no delata: pausar una
// descarga HLS no lanza error, simplemente no pausa; y reanudar con el
// AbortController viejo hace que la descarga no continue, tampoco con error.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const leer = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const MAIN = leer('main.js');
const REG = leer('src', 'main', 'downloads', 'registry.js');
const FETCH = leer('src', 'main', 'downloads', 'fetch.js');
const HLS = leer('src', 'main', 'downloads', 'hls.js');
const FILE = leer('src', 'main', 'downloads', 'file.js');

// El JSDoc de los dos modulos NOMBRA las trampas que los tests comprueban
// (PauseSignal, AbortController, sender.session...), asi que las ausencias se
// buscan en el codigo, nunca en el texto.
const codigo = (s) => s.slice(s.indexOf('*/') + 2);

describe('downloads/registry.js -- el registro de descargas', () => {
  test('los tres canales de control se fueron de main.js', () => {
    assert.match(MAIN, /const DownloadsRegistry = require\('\.\/src\/main\/downloads\/registry'\);/);
    assert.match(MAIN, /DownloadsRegistry\.registerDownloadControlIpc\(\);/);
    for (const canal of ['dl-pause', 'dl-resume', 'dl-cancel']) {
      assert.ok(REG.includes(`ipcMain.handle('${canal}'`), `${canal} no esta en registry.js`);
      assert.doesNotMatch(MAIN, new RegExp(`ipcMain\\.handle\\('${canal}'`), `${canal} sigue en main.js`);
    }
  });

  test('dl-pause SOLO aborta en archivos directos, nunca en HLS', () => {
    // Es la asercion mas importante del archivo. En HLS, abortar el controller
    // tiraria los segmentos ya bajados del lote; el bucle espera en el limite y
    // reanuda sin perderlos. Si alguien quita el `type === 'file'`, pausar una
    // descarga HLS pierde progreso y no da ningun error visible.
    const bloque = REG.slice(REG.indexOf("ipcMain.handle('dl-pause'"), REG.indexOf("ipcMain.handle('dl-resume'"));
    assert.match(bloque, /if \(e\.type === 'file' && e\.controller\) e\.controller\.abort\(\);/);
  });

  test('dl-pause y dl-resume solo actúan sobre el estado que corresponde', () => {
    // Pausar algo ya pausado, o reanudar algo activo, no debe pasar: el
    // AbortController se recrea en cada reanudacion y eso no es gratis de
    // hacer por accidente.
    assert.match(REG, /if \(e && e\.state === 'active'\) \{\s*e\.state = 'paused';/);
    assert.match(REG, /if \(e && e\.state === 'paused'\) \{\s*e\.state = 'active';/);
  });

  test('dl-resume crea un AbortController NUEVO', () => {
    // Un AbortController ya abortado queda contaminado para siempre: reutilizarlo
    // hace que la descarga reanudada no continue. Y ni un error: simplemente se
    // queda quieta.
    assert.match(REG, /e\.controller = new AbortController\(\);/);
    assert.doesNotMatch(REG, /controller\.abort\(\);\s*}\s*}\s*\n\s*e\.controller/, 'no debe reusar el viejo');
  });

  test('dl-cancel aborta siempre, en cualquier estado', () => {
    const bloque = REG.slice(REG.indexOf("ipcMain.handle('dl-cancel'"));
    assert.match(bloque, /if \(e\) \{/);
    assert.match(bloque, /e\.state = 'cancelled';/);
    assert.match(bloque, /if \(e\.controller\) e\.controller\.abort\(\);/);
    assert.doesNotMatch(bloque, /state === 'active'/);
  });

  test('los tres canales devuelven { ok: true } aunque no haya nada que hacer', () => {
    // El renderer no distingue "pausada" de "no existia": si se dejara devolver
    // undefined, la UI se queda esperando un ok que no llega.
    assert.equal((REG.match(/return \{ ok: true \};/g) || []).length, 3);
  });

  test('dlRegister da un id unico de estado activo y con su propio controller', () => {
    assert.match(REG, /const entry = \{ id, url, type, state: 'active', controller: new AbortController\(\) \};/);
    assert.match(REG, /dlRegistry\.set\(id, entry\);/);
  });

  test('dlWaitIfPaused devuelve cancelled si se cancela mientras espera', () => {
    // Sin esto, cancelar una descarga HLS pausada la dejaria esperando para
    // siempre: el bucle seguiría vivo sin escribir nada.
    assert.match(REG, /if \(e\.state === 'cancelled'\) return resolve\('cancelled'\);/);
  });
});

describe('downloads/registry.js -- los bucles de descarga lo usan bien', () => {
// dl-hls se movió en el paso 16 y dl-file en el 17, así que los dos bucles de
  // descarga ya no están en el mismo archivo, ni en main.js. Lo que se fija aquí
  // es el invariante conjunto: los dos leen el signal en cada petición, los dos
  // borran su entrada, y los dos se registran con un tipo distinto.
  const BUCLES = HLS + '\n' + FILE;

  test('cada descarga se registra con su tipo, porque el tipo decide como se pausa', () => {
    assert.match(HLS, /DownloadsRegistry\.dlRegister\(id, url, 'hls'\)/);
    assert.match(FILE, /DownloadsRegistry\.dlRegister\(id, url, 'file'\)/);
    assert.equal((BUCLES.match(/DownloadsRegistry\.dlRegister\(/g) || []).length, 2);
  });

  test('el signal se lee en cada peticion, no se guarda al principio del bucle', () => {
    // TRAMPA 2 del módulo: si se guardara el signal al empezar, tras reanudar
    // seguiria leyendo el del controller viejo, ya abortado.
    //
    // Se fija la cuenta exacta a proposito. No para que no cambie nunca, sino
    // para que si cambia se vea en el diff del test: seis son las peticiones que
    // necesitan credenciales de la sesion (5 en hls, 1 en file), y un numero
    // distinto significa que alguien toco un bucle y no lo conto.
    assert.equal((HLS.match(/entry\.controller\.signal/g) || []).length, 5);
    assert.equal((FILE.match(/entry\.controller\.signal/g) || []).length, 1);
    // Y ninguna se cacheo en una variable, que es el bug de verdad.
    assert.doesNotMatch(BUCLES, /(?:const|let|var)\s+\w*signal\w*\s*=\s*entry\.controller\.signal/);
  });

  test('la entrada se borra en el finally de los dos bucles', () => {
    // Si se borrara antes, dl-pause llegaria tarde y no encontraria nada. Y si no
    // se borrara nunca, el Map creeria sin limite con cada descarga.
    assert.equal((HLS.match(/DownloadsRegistry\.dlRegistry\.delete\(id\)/g) || []).length, 1);
    assert.equal((FILE.match(/DownloadsRegistry\.dlRegistry\.delete\(id\)/g) || []).length, 1);
  });

  test('PauseSignal se captura con instanceof y continues, nunca se reporta como error', () => {
    // Si un catch generico lo tratara como fallo real, avisaria de un error que
    // el propio usuario acaba de provocar, y la descarga pasaria a fallida en
    // vez de pausada.
    assert.match(FILE, /if \(err instanceof DownloadsRegistry\.PauseSignal \|\| entry\.state === 'paused'\) continue;/);
    assert.doesNotMatch(FILE, /catch[\s\S]{0,80}PauseSignal[\s\S]{0,120}ACTIONS\.emit\('dl-error'/);
  });
});

describe('downloads/fetch.js -- el transporte', () => {
  test('se fue de main.js y se importa con prefijo', () => {
    assert.match(MAIN, /const DownloadsFetch = require\('\.\/src\/main\/downloads\/fetch'\);/);
    assert.doesNotMatch(MAIN, /(?<![\w.])chromiumFetch\(/);
    assert.doesNotMatch(MAIN, /(?<![\w.])mediaRequestHeaders\(/);
    assert.doesNotMatch(MAIN, /(?<![\w.])getSessionFetch\(/);
  });

  test('prefiere el fetch de Chromium, que es el que ve las cookies', () => {
    // Un fetch de Node no ve el cookieStore de la sesion: la descarga de un
    // archivo con login daria 401 y el usuario no tendria ni idea de por que.
    assert.match(FETCH, /ses\.fetch\(url, opts\)/);
    assert.match(codigo(FETCH), /credentials: 'include'/);
  });

  test('sessionFetch se resuelve UNA vez, al cargar el modulo', () => {
    // Si se comprobara por peticion se pagaria el coste en cada segmento de HLS,
    // que son miles. Y el resultado no puede cambiar durante la vida del
    // proceso. Ver TRAMPA 1 del modulo.
    assert.match(FETCH, /^const sessionFetch = getSessionFetch\(\);$/m);
    const fn = FETCH.slice(FETCH.indexOf('async function chromiumFetch'));
    assert.doesNotMatch(fn, /getSessionFetch\(/);
  });

  test('el Referer se deduce de la URL solo si la pagina no lo pasa', () => {
    // Si la pagina lo pasa, ese gana: es el referer real, y el de la URL seria
    // una mentira que algunos CDNs comprueban.
    const n = (FETCH.match(/if \(!headers\['Referer'\]\) try \{ headers\['Referer'\] = new URL\(url\)\.origin \+ '\/'; \} catch \{\}/g) || []).length;
    assert.equal(n, 2, 'en el camino de Chromium y en el de fallback con cookies');
  });

  test('el fallback con Node tiene DOS ramas a proposito', () => {
    // Si `cookies.get` falla (URL invalida, sesion destruida) se reintenta sin
    // cookies en vez de rendirse. La segunda rama NO lleva Referer deduced, y no
    // es un descuido: es la que se usa cuando ni la URL se pudo parsear.
    const cuerpo = codigo(FETCH);
    assert.equal((cuerpo.match(/UA_FALLBACK/g) || []).length, 3, 'la constante, dos usos y el require');
    assert.equal((cuerpo.match(/return fetch\(url, \{ headers, signal \}\);/g) || []).length, 2);
  });

  test('el fallback declara el UA de Chromium a mano', () => {
    // Solo se usa sin `session.fetch`. Con Chromium nativo el UA lo pone el
    // navegador, y mandarle otro seria mentirle.
    assert.match(FETCH, /const UA_FALLBACK = 'Mozilla\/5\.0/);
  });

  test('downloadSegment y resolveUrl se fueron con hls.js en el paso 16', () => {
    assert.match(HLS, /async function downloadSegment\(/);
    assert.match(HLS, /function resolveUrl\(/);
    assert.doesNotMatch(MAIN, /function downloadSegment\(/);
    assert.doesNotMatch(MAIN, /function resolveUrl\(/);
  });
});