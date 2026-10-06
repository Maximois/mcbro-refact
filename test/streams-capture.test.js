'use strict';

// capture.js hace require('electron'), asi que no se importa en un test de node
// plano. Estos tests leen el fuente.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const leer = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const MAIN = leer('main.js');
const CAPTURE = leer('src', 'main', 'streams', 'capture.js');
const HEADERS = leer('src', 'main', 'net', 'headers.js');
const codigo = (s) => s.slice(s.indexOf('*/') + 2);

describe('streams/capture.js -- la extraccion', () => {
  test('main.js lo registra y los helpers ya no viven alli', () => {
    assert.match(MAIN, /const StreamCapture = require\('\.\/src\/main\/streams\/capture'\);/);
    assert.match(MAIN, /StreamCapture\.registerStreamCaptureIpc\(\);/);
    for (const fn of ['findHlsPlayerEntry', 'findStreamEntryReferer', 'consumeStreamEntryReferer']) {
      assert.match(CAPTURE, new RegExp(`function ${fn}\\(`), `${fn} deberia estar en capture.js`);
      assert.doesNotMatch(MAIN, new RegExp(`function ${fn}\\(`), `${fn} sigue en main.js`);
    }
    assert.doesNotMatch(MAIN, /streamPlayerReferers = new Map/);
    assert.doesNotMatch(MAIN, /streamEntryReferers = new Map/);
    assert.doesNotMatch(MAIN, /let streamHlsCaptureEnabled/);
  });

  test('los tres handlers ya no estan en main.js', () => {
    assert.doesNotMatch(MAIN, /ipcMain\.handle\('streams:hls-capture'/);
    assert.doesNotMatch(MAIN, /ipcMain\.handle\('streams:hls-player-referer'/);
    assert.doesNotMatch(MAIN, /ipcMain\.handle\('streams:entry-referer'/);
    assert.match(codigo(CAPTURE), /ipcMain\.handle\('streams:hls-capture'/);
    assert.match(codigo(CAPTURE), /ipcMain\.handle\('streams:hls-player-referer'/);
    assert.match(codigo(CAPTURE), /ipcMain\.handle\('streams:entry-referer'/);
  });

  test('headers.js recibe los 3 deps de capture.js', () => {
    assert.match(MAIN, /isStreamHlsCaptureEnabled: StreamCapture\.isStreamHlsCaptureEnabled,/);
    assert.match(MAIN, /consumeStreamEntryReferer: StreamCapture\.consumeStreamEntryReferer,/);
    assert.match(MAIN, /findHlsPlayerEntry: StreamCapture\.findHlsPlayerEntry,/);
    assert.match(HEADERS, /const \{ isStreamHlsCaptureEnabled, consumeStreamEntryReferer, findHlsPlayerEntry \} = deps;/);
  });

  test('streams:scan se quedo en main.js: no cierra nada de aqui', () => {
    // El scanner lista streams en una pagina, no los captura. Su flujo
    // depende del renderer y del adblocker, y el plan no lo pide.
    assert.match(MAIN, /ipcMain\.handle\('streams:scan'/);
    assert.doesNotMatch(codigo(CAPTURE), /streams:scan/);
  });
});

describe('streams/capture.js -- TRAMPA 1: el flag no flippea al preguntar', () => {
  test('el handler solo cambia el estado con un booleano explicito', () => {
    // Si pasara a `streamHlsCaptureEnabled = !!active`, una "pregunta"
    // (undefined) lo pondria a false siempre.
    assert.match(codigo(CAPTURE), /if \(typeof active === 'boolean'\) streamHlsCaptureEnabled = active;/);
    assert.doesNotMatch(codigo(CAPTURE), /streamHlsCaptureEnabled = !!active/);
  });

  test('FIXADO: arranca apagado, por defecto', () => {
    // Si empezara encendido, toda pagina con .m3u8 pasaria por el redirect
    // de captura sin que el usuario lo pidiera.
    assert.match(codigo(CAPTURE), /let streamHlsCaptureEnabled = false;/);
  });

  test('el consumidor lee el flag por getter, nunca por valor', () => {
    assert.match(codigo(CAPTURE), /function isStreamHlsCaptureEnabled\(\) \{ return streamHlsCaptureEnabled; \}/);
    assert.match(MAIN, /isStreamHlsCaptureEnabled: StreamCapture\.isStreamHlsCaptureEnabled/);
    assert.match(HEADERS, /if \(isStreamHlsCaptureEnabled\(\) && /);
  });
});

describe('streams/capture.js -- TRAMPA 2: dos tablas con TTL distintos', () => {
  test('entry referers: TTL corto, los player: TTL largo', () => {
    // Entry: 30 s. Al primer request valido se consume y se borra
    // (single-use por referer). Player: 15 min, para la proxima peticion
    // del mismo video.
    assert.match(codigo(CAPTURE), /expiresAt: Date\.now\(\) \+ 30000/);
    assert.match(codigo(CAPTURE), /expiresAt: Date\.now\(\) \+ 15 \* 60 \* 1000/);
  });

  test('los dos se borran al pasar de tamaño 100', () => {
    assert.equal((CAPTURE.match(/while \(streamPlayerReferers\.size > 100\)/g) || []).length, 1);
    assert.equal((CAPTURE.match(/while \(streamEntryReferers\.size > 100\)/g) || []).length, 1);
  });

  test('los expirados se descartan al leer, no al insertar', () => {
    assert.match(codigo(CAPTURE), /if \(entry\.expiresAt <= Date\.now\(\)\) \{\s*streamPlayerReferers\.delete\(token\);\s*continue;\s*\}/);
    assert.match(codigo(CAPTURE), /if \(entry\.expiresAt <= Date\.now\(\)\) \{\s*streamEntryReferers\.delete\(key\);\s*return null;\s*\}/);
  });

  test('consumeStreamEntryReferer borra y devuelve en una sola operacion', () => {
    // Si el lookup y el borrado estuviesen separados, un segundo request
    // con el mismo token reutilizaria el referer: el token debe ser de un
    // solo uso para que solo el primer request que lo conoce consiga el
    // referer "autorizado".
    assert.match(codigo(CAPTURE), /function consumeStreamEntryReferer\(details\) \{/);
    const cuerpo = codigo(CAPTURE).split('function consumeStreamEntryReferer')[1];
    assert.match(cuerpo, /streamEntryReferers\.delete\(match\.key\);/);
    assert.match(HEADERS, /const entryReferer = consumeStreamEntryReferer\(d\);/);
  });
});

describe('streams/capture.js -- TRAMPA 3: quien puede escribir en la tabla', () => {
  test('el token de entry es mchls+slug y el sender debe ser ese token', () => {
    assert.match(codigo(CAPTURE), /if \(!\/\^mchls\[a-z0-9-\]\{8,100\}\$\/i\.test\(token \|\| ''\) \|\| !senderUrl\.includes\(token\)\) return false;/);
  });

  test('los tokens de player llevan 8-100 chars alfanumericos', () => {
    assert.match(codigo(CAPTURE), /if \(!\/\^\[a-z0-9-\]\{8,100\}\$\/i\.test\(token \|\| ''\)\) return false;/);
  });

  test('el sender solo puede ser host o player, con el player validado por token', () => {
    assert.match(codigo(CAPTURE), /const isHostRenderer = event\.sender === getMainWin\(\)\?\.webContents;/);
    assert.match(codigo(CAPTURE), /if \(!isHostRenderer && !isPlayerRenderer\) return false;/);
    assert.match(codigo(CAPTURE), /if \(isPlayerRenderer && existing\?\.webContentsId && existing\.webContentsId !== event\.sender\.id\) return false;/);
  });

  test('el referer solo acepta http/https', () => {
    assert.match(codigo(CAPTURE), /if \(normalizedReferer && !\/\^https\?:\\\/\\\/\/i\.test\(normalizedReferer\]?/);
    assert.match(codigo(CAPTURE), /if \(!\/\^https\?:\$\/i\.test\(requestUrl\.protocol\) \|\| !\/\^https\?:\$\/i\.test\(refererUrl\.protocol\)\) return false;/);
  });
});

describe('streams/capture.js -- los handlers', () => {
  test('FIXADO: hls-capture devuelve el estado resultante', () => {
    // Asi el renderer no tiene que adivinar si su toggle funciono: lo que
    // devuelve ES el estado, y aparece en el header de debug.
    assert.match(codigo(CAPTURE), /if \(typeof active === 'boolean'\) streamHlsCaptureEnabled = active;\s*return streamHlsCaptureEnabled;/);
  });

  test('hls-player-referer enlaza el webContentsId correcto', () => {
    // Si es player renderer, el id es el del que llama; si es host, se
    // conserva el existente o null. Mezclarlos haria que el referer se asocie
    // al webContents equivocado.
    assert.match(codigo(CAPTURE), /webContentsId: isPlayerRenderer \? event\.sender\.id : \(existing\?\.webContentsId \|\| null\),/);
  });
});