'use strict';

// friendlyFileName vive dentro de src/renderer.html (no es un modulo de node y
// el renderer no se importa aqui). Se extrae el codigo tal cual para probar su
// comportamiento real y no una copia que se pueda quedar vieja.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.html'), 'utf8');

const friendlyFileName = (() => {
  const start = HTML.indexOf('function friendlyFileName(');
  assert.notEqual(start, -1, 'friendlyFileName deberia existir en src/renderer.html');
  let depth = 0;
  for (let i = start; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}') {
      depth--;
      if (depth === 0) return eval('(' + HTML.slice(start, i + 1) + ')'); // eslint-disable-line no-eval
    }
  }
  throw new Error('friendlyFileName no cierra bien: se cambio la funcion sin actualizar este test');
})();

const M3U8 = 'https://cdn.ejemplo-cdn.net/hls/master.m3u8';
const nombre = (pageUrl, displayName) => friendlyFileName(M3U8, 'HLS', pageUrl, displayName);

describe('friendlyFileName -- nombre especifico primero', () => {
  test('usa el nombre que aporta Stream Hunter cuando no es una URL', () => {
    assert.equal(nombre('https://ejemplo.com/ver/x/1', 'Dark Summoner E1'), 'Dark_Summoner_E1');
  });

  test('una URL en displayName no cuenta como nombre especifico', () => {
    // displayName que en la practica es la propia pagina: debe ganar la ruta.
    assert.equal(nombre('https://vww.monoschinos2.net/ver/x/1', 'https://vww.monoschinos2.net/ver/x/1'),
      'ver_x_1');
  });
});

describe('friendlyFileName -- la ruta de la barra manda', () => {
  test('usa solo la ruta, sin dominio ni protocolo', () => {
    assert.equal(
      nombre('https://vww.monoschinos2.net/ver/dark-summoner-to-dekiteiru-episodio-1/1791244614780'),
      'ver_dark-summoner-to-dekiteiru-episodio-1_1791244614780');
  });

  test('las dos variantes de subdominio dan el MISMO nombre', () => {
    const conVww = nombre('https://vww.monoschinos2.net/ver/ep-1/99');
    const conWww = nombre('https://www.monoschinos2.net/ver/ep-1/99');
    const pelado = nombre('https://monoschinos2.net/ver/ep-1/99');
    assert.equal(conVww, pelado);
    assert.equal(conWww, pelado);
    assert.equal(conVww, 'ver_ep-1_99');
  });

  test('el nombre no empieza nunca por protocolo ni por www/vww', () => {
    for (const u of [
      'https://vww.ejemplo.com/a/b',
      'https://www.ejemplo.com/a/b',
      'http://www.ejemplo.com/a/b',
    ]) {
      assert.doesNotMatch(nombre(u), /^(https?:|www\.|vww\.)/, `no deberia colarse el prefijo en ${u}`);
    }
  });

  test('ignora la query string de la barra', () => {
    assert.equal(nombre('https://ejemplo.com/ver/x/1?token=abc'), 'ver_x_1');
  });
});

describe('friendlyFileName -- nombres genericos caen al dominio', () => {
  test('ruta generica: antepone el host', () => {
    assert.equal(nombre('https://ejemplo.com/index'), 'ejemplo.com_index');
    assert.equal(nombre('https://ejemplo.com/ver'), 'ejemplo.com_ver');
    assert.equal(nombre('https://ejemplo.com/ver/'), 'ejemplo.com_ver');
    assert.equal(nombre('https://ejemplo.com/watch'), 'ejemplo.com_watch');
    assert.equal(nombre('https://ejemplo.com/player'), 'ejemplo.com_player');
    assert.equal(nombre('https://ejemplo.com/ab'), 'ejemplo.com_ab');
  });

  test('sin ruta se queda con el host', () => {
    assert.equal(nombre('https://www.ejemplo.com/'), 'ejemplo.com');
  });
});

describe('friendlyFileName -- nunca nombra desde la URL del fetch', () => {
  test('sin pageUrl devuelve la marca en vez del nombre del CDN', () => {
    // El nombre NO debe salir de M3U8 (cdn.ejemplo-cdn.net/hls/master).
    assert.equal(friendlyFileName(M3U8, 'HLS', undefined, undefined), 'media');
  });

  test('pageUrl ausente no cae al hostname de la media', () => {
    const r = friendlyFileName('https://cdn.ejemplo-cdn.net/video/ep1.mp4', 'MP4', null, '');
    assert.doesNotMatch(r, /cdn|ejemplo-cdn/i);
  });
});