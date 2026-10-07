'use strict';

// STREAM_SCAN_SCRIPT vive dentro de un template literal en bootstrap.js y se
// ejecuta en la pagina del webview. Un backslash sin escapar ( \/ , \. , \d )
// se pierde al cocinar el literal y rompe el parseo del script entero: el
// handler 'streams:scan' cae al catch y devuelve [] para siempre, asi que el
// Stream Hunter deja de detectar cualquier stream.
//
// Estos tests cocinan el literal igual que lo hace Node y ejecutan el script
// resultante contra un DOM minimo.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src/main/bootstrap.js'), 'utf8');

function extraerScanScript() {
  const marca = 'const STREAM_SCAN_SCRIPT = `';
  const inicio = MAIN.indexOf(marca);
  assert.ok(inicio > -1, 'bootstrap.js debe definir STREAM_SCAN_SCRIPT');
  const desde = inicio + marca.length;
  const cierre = MAIN.slice(desde).match(/`;\r?\n/);
  assert.ok(cierre, 'STREAM_SCAN_SCRIPT debe cerrar con un backtick');
  const crudo = MAIN.slice(desde, desde + cierre.index);
  // Node evalua los escapes del literal: lo mismo que pasa en runtime
  return new Function('return `' + crudo + '`')();
}

function domMinimo({ videos = [], recursos = [] } = {}) {
  const crearVideo = (src) => ({
    tagName: 'VIDEO', src, currentSrc: src,
    querySelectorAll: () => [],
    closest: () => null, parentElement: null
  });
  const body = { parentElement: null, querySelector: () => null };
  const document = {
    body,
    querySelectorAll: (sel) => {
      if (sel.includes('video') || sel.includes('audio')) return videos;
      return [];
    },
    querySelector: () => null
  };
  const ventana = {
    __mcFound: [],
    __mcHooked: false,
    location: { href: 'https://ejemplo.test/pelicula' }
  };
  const contexto = {
    document, location: ventana.location, window: ventana,
    performance: { getEntriesByType: () => recursos.map(name => ({ name })) },
    XMLHttpRequest: function () {},
    console
  };
  contexto.globalThis = contexto;
  return { contexto, ventana };
}

describe('STREAM_SCAN_SCRIPT -- el script inyectado en el webview', () => {
  test('el literal cocina a un script que se puede parsear', () => {
    const script = extraerScanScript();
    assert.doesNotThrow(() => new vm.Script(script), 'el script cocido debe ser JS valido');
  });

  test('no deja escapes sueltos que el literal se coma', () => {
    const marca = 'const STREAM_SCAN_SCRIPT = `';
    const desde = MAIN.indexOf(marca) + marca.length;
    const cierre = MAIN.slice(desde).match(/`;\r?\n/);
    const crudo = MAIN.slice(desde, desde + cierre.index);
    const cocido = new Function('return `' + crudo + '`')();
    // \/ \. \d sueltos se vuelven / . d y dejan regex rotas (/^/...// )
    assert.doesNotMatch(cocido, /\/\^\/\(x\.com/, 'el regex de x.com quedo sin escapar');
    assert.match(cocido, /\/\^https\?:\\\/\\\/\(x\\\.com\|twitter\\\.com\)/);
    assert.match(cocido, /href\.match\(\/\^\\\/\(\[a-zA-Z0-9_\]/);
  });

  test('detecta el m3u8 de un <video> del DOM', () => {
    const script = extraerScanScript();
    const { contexto, ventana } = domMinimo({
      videos: [{
        tagName: 'VIDEO',
        src: 'https://cdn.ejemplo.test/hls/indice.m3u8',
        currentSrc: 'https://cdn.ejemplo.test/hls/indice.m3u8',
        querySelectorAll: () => [], closest: () => null, parentElement: null
      }]
    });
    const salida = vm.runInNewContext(script, contexto);
    const items = JSON.parse(salida);
    assert.equal(items.length, 1);
    assert.equal(items[0].url, 'https://cdn.ejemplo.test/hls/indice.m3u8');
    assert.match(items[0].via, /DOM:VIDEO/);
    assert.equal(items[0].pageUrl, 'https://ejemplo.test/pelicula');
    assert.equal(ventana.__mcFound.length, 1);
  });

  test('detecta un .mpd filtrado por performance.getEntriesByType', () => {
    const script = extraerScanScript();
    const { contexto } = domMinimo({ recursos: ['https://cdn.ejemplo.test/manifest.mpd?token=abc'] });
    const items = JSON.parse(vm.runInNewContext(script, contexto));
    assert.equal(items.length, 1);
    assert.match(items[0].url, /\.mpd\?token=abc$/);
    assert.equal(items[0].via, 'performance');
  });

  test('el regex de x.com acepta un post con video y descarta el perfil', () => {
    const script = extraerScanScript();
    const post = 'https://x.com/alguien/status/1234567890/video/1';
    const perfil = 'https://x.com/alguien';
    const conPost = domMinimo({ videos: [{
      tagName: 'VIDEO', src: post, currentSrc: post,
      querySelectorAll: () => [], closest: () => null, parentElement: null
    }] });
    assert.equal(JSON.parse(vm.runInNewContext(script, conPost.contexto)).length, 1);
    const conPerfil = domMinimo({ videos: [{
      tagName: 'VIDEO', src: perfil, currentSrc: perfil,
      querySelectorAll: () => [], closest: () => null, parentElement: null
    }] });
    assert.equal(JSON.parse(vm.runInNewContext(script, conPerfil.contexto)).length, 0);
  });

  test('ignora scripts, css y fuentes', () => {
    const script = extraerScanScript();
    const { contexto } = domMinimo({ recursos: [
      'https://ejemplo.test/app.js', 'https://ejemplo.test/estilo.css',
      'https://ejemplo.test/logo.svg', 'https://ejemplo.test/datos.json'
    ] });
    assert.equal(JSON.parse(vm.runInNewContext(script, contexto)).length, 0);
  });

  test('la captura de fetch queda enganchada tras el escaneo', () => {
    const script = extraerScanScript();
    const { contexto, ventana } = domMinimo();
    vm.runInNewContext(script, contexto);
    assert.equal(ventana.__mcHooked, true);
    assert.equal(typeof ventana.fetch, 'function');
    assert.equal(typeof contexto.XMLHttpRequest.prototype.open, 'function');
  });

  test('bootstrap.js devuelve la promesa del webview en vez de un array vacio', () => {
    // Sin return, el handler devolveria undefined y el renderer no tendria
    // nada que parsear aunque el script del webview haya encontrado medias.
    assert.match(MAIN, /return wv\.executeJavaScript\(\$\{JSON\.stringify\(STREAM_SCAN_SCRIPT\)\}\)/);
  });
});