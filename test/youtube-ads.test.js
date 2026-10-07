'use strict';

// YT_AD_SCRIPT vive dentro de un template literal en preload/selection-bridge.js
// y corre en el MUNDO PRINCIPAL de YouTube (webFrame.executeJavaScript). Un
// backslash sin escapar ( \/ , \. , \d ) se pierde al cocinar el literal y
// rompe el parseo del script entero, asi que estos tests lo cocinan igual que
// Node y lo ejecutan contra un DOM minimo: si el literal se rompe, el test
// falla en vez de dejar el adblock de YouTube muerto en silencio.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload', 'selection-bridge.js'), 'utf8');

function extraerScript() {
  const marca = 'const YT_AD_SCRIPT = `';
  const inicio = PRELOAD.indexOf(marca);
  assert.ok(inicio > -1, 'selection-bridge.js debe definir YT_AD_SCRIPT');
  const desde = inicio + marca.length;
  const cierre = PRELOAD.slice(desde).match(/`;\r?\n/);
  assert.ok(cierre, 'YT_AD_SCRIPT debe cerrar con backtick');
  const crudo = PRELOAD.slice(desde, desde + cierre.index);
  // Node evalua los escapes del literal: lo mismo que pasa en runtime
  return new Function('return `' + crudo + '`')();
}

function respuestaJson(datos, url) {
  return {
    ok: true, status: 200, statusText: 'OK', url,
    headers: { get: () => 'application/json; charset=utf-8' },
    clone() {
      const copia = JSON.parse(JSON.stringify(datos));
      return { json: () => Promise.resolve(copia) };
    }
  };
}

function ResponsePoli(body, init) {
  this.body = body;
  this.status = (init && init.status) || 200;
  this.statusText = (init && init.statusText) || '';
  this.headers = (init && init.headers) || null;
}

function crearContexto(opciones = {}) {
  const sandbox = {
    console: opciones.console || console,
    Response: ResponsePoli,
    XMLHttpRequest: opciones.XMLHttpRequest || function () {},
    document: opciones.document || { querySelector: () => null, querySelectorAll: () => [] },
    fetch: opciones.fetch || (() => Promise.resolve(null)),
    setInterval: (fn) => { sandbox.__tick = fn; return 1; }
  };
  sandbox.window = sandbox;
  if (opciones.previa) sandbox.ytInitialPlayerResponse = opciones.previa;
  vm.createContext(sandbox);
  vm.runInContext(extraerScript(), sandbox);
  return sandbox;
}

function fakeFetch() {
  const state = { req: null, ultima: null };
  state.fn = (url, init) => {
    state.req = { url, init };
    state.ultima = respuestaJson({
      adPlacements: [{ anuncio: true }],
      playerAds: [1], adSlots: [2],
      videoDetails: { title: 'video' }
    }, url);
    return Promise.resolve(state.ultima);
  };
  return state;
}

function FakeXHR() {
  this.listeners = {};
  this.responseType = '';
}
FakeXHR.prototype.open = function (method, url) { this.__url = url; };
FakeXHR.prototype.addEventListener = function (evento, fn) {
  (this.listeners[evento] || (this.listeners[evento] = [])).push(fn);
};
FakeXHR.prototype.send = function (body) {
  this.__sentBody = body;
  this.__raw = JSON.stringify({
    adPlacements: [{ anuncio: true }],
    playerAds: [1], adSlots: [2],
    videoDetails: { title: 'xhr' }
  });
  (this.listeners.load || []).forEach(fn => fn.call(this));
};
Object.defineProperty(FakeXHR.prototype, 'responseText', {
  configurable: true, get() { return this.__raw; }
});
Object.defineProperty(FakeXHR.prototype, 'response', {
  configurable: true, get() { return this.__raw; }
});

describe('YT_AD_SCRIPT: recorta la metadata de anuncios del player', () => {
  test('el literal se cocina entero (sin backticks ni ${ sueltos)', () => {
    const codigo = extraerScript();
    assert.ok(codigo.includes('/youtubei/v1/player'), 'debe parchear /youtubei/v1/player');
    assert.ok(!codigo.includes('`${'), 'no debe quedar interpolacion sin cerrar');
    assert.doesNotThrow(() => new Function(codigo));
  });

  test('trampa la carga fria: el inline ytInitialPlayerResponse llega ya podado', () => {
    const ctx = crearContexto();
    ctx.ytInitialPlayerResponse = {
      videoDetails: { title: 't' },
      adPlacements: [1], playerAds: [2], adSlots: [3]
    };
    assert.equal(ctx.ytInitialPlayerResponse.adPlacements, undefined);
    assert.equal(ctx.ytInitialPlayerResponse.playerAds, undefined);
    assert.equal(ctx.ytInitialPlayerResponse.adSlots, undefined);
    assert.equal(ctx.ytInitialPlayerResponse.videoDetails.title, 't');
    // reasignacion (navegacion SPA) vuelve a podar
    ctx.ytInitialPlayerResponse = { adPlacements: [9], videoDetails: { title: 'otro' } };
    assert.equal(ctx.ytInitialPlayerResponse.adPlacements, undefined);
    assert.equal(ctx.ytInitialPlayerResponse.videoDetails.title, 'otro');
  });

  test('si el objeto ya existia al inyectar, lo poda en el sitio', () => {
    const ctx = crearContexto({
      previa: { adPlacements: [1], playerAds: [2], videoDetails: { title: 'frio' } }
    });
    assert.equal(ctx.ytInitialPlayerResponse.adPlacements, undefined);
    assert.equal(ctx.ytInitialPlayerResponse.playerAds, undefined);
    assert.equal(ctx.ytInitialPlayerResponse.videoDetails.title, 'frio');
  });

  test('Object.assign sobre la respuesta no puede reinsertar campos de anuncio', () => {
    const ctx = crearContexto({ previa: { videoDetails: { title: 'x' } } });
    Object.assign(ctx.ytInitialPlayerResponse, { adPlacements: [1], playerAds: [2] });
    assert.equal(ctx.ytInitialPlayerResponse.adPlacements, undefined);
    assert.equal(ctx.ytInitialPlayerResponse.playerAds, undefined);
    // tambien en la ruta del setter, aunque el objeto nuevo viniera "limpio"
    ctx.ytInitialPlayerResponse = { videoDetails: { title: 'y' } };
    Object.assign(ctx.ytInitialPlayerResponse, { adBreakParams: [3] });
    assert.equal(ctx.ytInitialPlayerResponse.adBreakParams, undefined);
    assert.equal(ctx.ytInitialPlayerResponse.videoDetails.title, 'y');
  });

  test('si la trampa no se puede instalar, vuelve a podar en load', () => {
    const listeners = [];
    const sandbox = {
      console,
      Response: ResponsePoli,
      XMLHttpRequest: function () {},
      document: { querySelector: () => null, querySelectorAll: () => [] },
      fetch: () => Promise.resolve(null),
      setInterval: () => 1,
      addEventListener: (evento, fn) => listeners.push({ evento, fn })
    };
    sandbox.window = sandbox;
    Object.defineProperty(sandbox, 'ytInitialPlayerResponse', {
      value: { adPlacements: [1], videoDetails: { title: 'frio' } },
      writable: true, configurable: false
    });
    vm.createContext(sandbox);
    vm.runInContext(extraerScript(), sandbox);
    // YouTube reescribe el objeto entero: sin trampa el crudo entra
    sandbox.ytInitialPlayerResponse = { adPlacements: [2], videoDetails: { title: 'nuevo' } };
    assert.equal(sandbox.ytInitialPlayerResponse.adPlacements.length, 1);
    const carga = listeners.find(l => l.evento === 'load');
    assert.ok(carga, 'debe registrar un reintento en load');
    carga.fn();
    assert.equal(sandbox.ytInitialPlayerResponse.adPlacements, undefined);
    assert.equal(sandbox.ytInitialPlayerResponse.videoDetails.title, 'nuevo');
  });

  test('el fetch de /player devuelve JSON sin campos de anuncio', async () => {
    const fake = fakeFetch();
    const ctx = crearContexto({ fetch: fake.fn });
    const res = await ctx.fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      body: JSON.stringify({ videoId: 'abc' })
    });
    const datos = JSON.parse(res.body);
    assert.equal(datos.adPlacements, undefined);
    assert.equal(datos.playerAds, undefined);
    assert.equal(datos.adSlots, undefined);
    assert.equal(datos.videoDetails.title, 'video');
    assert.ok(String(fake.req.init.body).includes('isInlinePlaybackNoAd'),
      'el request /player debe pedir sin inline ads (lado servidor)');
  });

  test('los endpoints que no son de player pasan intactos', async () => {
    const fake = fakeFetch();
    const ctx = crearContexto({ fetch: fake.fn });
    const res = await ctx.fetch('https://www.youtube.com/youtubei/v1/browse', {
      method: 'POST',
      body: JSON.stringify({ browseId: 'x' })
    });
    assert.equal(res, fake.ultima, 'no debe reconstruir respuestas que no son del player');
    assert.equal(fake.req.init.body, JSON.stringify({ browseId: 'x' }),
      'no debe tocar el body de otros endpoints');
  });

  test('el XHR de /player se poda en load y el body sale con la senal', () => {
    const ctx = crearContexto({ XMLHttpRequest: FakeXHR });
    const xhr = new ctx.XMLHttpRequest();
    xhr.open('POST', 'https://www.youtube.com/youtubei/v1/player');
    xhr.send(JSON.stringify({ videoId: 'z' }));
    assert.ok(String(xhr.__sentBody).includes('isInlinePlaybackNoAd'));
    const datos = JSON.parse(xhr.responseText);
    assert.equal(datos.adPlacements, undefined);
    assert.equal(datos.videoDetails.title, 'xhr');

    const otro = new ctx.XMLHttpRequest();
    otro.open('POST', 'https://www.youtube.com/youtubei/v1/browse');
    otro.send('{"x":1}');
    assert.equal(otro.__sentBody, '{"x":1}');
    assert.equal(JSON.parse(otro.responseText).adPlacements.length, 1,
      'los endpoints que no son de player no deben podarse');
  });

  test('red de seguridad: si aun asi hay overlay, hace click en Saltar', () => {
    const estado = { adShowing: true, clicks: 0, banner: { style: {} } };
    const documento = {
      querySelector(sel) {
        if (!estado.adShowing) return null;
        if (sel.indexOf('.ytp-skip-ad-button') !== -1) return { click: () => { estado.clicks++; } };
        if (sel.indexOf('.ytp-ad-overlay-ad-container') !== -1) return estado.banner;
        if (sel.indexOf('#movie_player.ad-showing') !== -1) return {};
        return null;
      },
      querySelectorAll: () => []
    };
    const ctx = crearContexto({ document: documento });
    assert.equal(typeof ctx.__tick, 'function', 'debe registrar el intervalo de seguridad');
    ctx.__tick();
    assert.equal(estado.clicks, 1, 'debe saltar el anuncio');
    assert.equal(estado.banner.style.display, 'none', 'debe ocultar el banner overlay');
    estado.adShowing = false;
    ctx.__tick();
    assert.equal(estado.clicks, 1, 'sin anuncio no debe tocar nada');
  });

  test('oculta el anuncio del feed en su contenedor mas externo (sin celda fantasma)', () => {
    const ocultos = [];
    const st = (id) => ({ setProperty: (p, v) => ocultos.push(id + ':' + p + '=' + v) });
    const richItem = { style: st('rich'), parentElement: null, closest: () => richItem };
    const slot = { style: st('slot'), closest: () => richItem, parentElement: richItem };
    const adRender = { style: st('ad'), closest: () => slot, parentElement: slot };

    const documento = {
      querySelector: () => null,
      querySelectorAll(sel) {
        if (sel.indexOf('ytd-in-feed-ad-layout-renderer') !== -1) return [adRender];
        return [];
      }
    };
    const ctx = crearContexto({ document: documento });
    ctx.__tick();
    assert.ok(ocultos.includes('rich:display=none'),
      'debe ocultarse el rich-item externo, el contenedor mas lejano');
    assert.ok(!ocultos.includes('ad:display=none'),
      'no debe ocultarse el renderer interno, eso dejaba la celda vacia');
  });

  test('el intervalo pausa el media de un anuncio de feed y oculta el item con insignia', () => {
    let pausados = 0;
    const ocultos = [];
    const st = (id) => ({ setProperty: (p) => ocultos.push(id) });
    const richItem = { style: st('rich'), parentElement: null };
    const badgeNodo = { closest: () => richItem };
    const conVideo = {
      style: st('feed'),
      closest: () => null,
      querySelectorAll: () => [{ pause: () => pausados++ }, { pause: () => pausados++ }]
    };
    const documento = {
      querySelector: () => null,
      querySelectorAll(sel) {
        if (sel.indexOf('ytd-ad-slot-renderer') !== -1) return [conVideo];
        if (sel.indexOf('.ytBadgeShapeAd') !== -1) return [badgeNodo];
        return [];
      }
    };
    const ctx = crearContexto({ document: documento });
    ctx.__tick();
    assert.ok(ocultos.includes('feed'), 'el anuncio con video debe ocultarse');
    assert.ok(ocultos.includes('rich'), 'el item con insignia Patrocinado debe ocultarse');
    assert.equal(pausados, 2, 'ocultar no corta el audio: hay que pausar el media');
  });

  test('get_watch no se re-serializa pero su body sigue pidiendo sin inline ads', async () => {
    const fake = fakeFetch();
    const ctx = crearContexto({ fetch: fake.fn });
    const res = await ctx.fetch('https://www.youtube.com/youtubei/v1/get_watch', {
      method: 'POST',
      body: JSON.stringify({ videoId: 'x' })
    });
    assert.equal(res, fake.ultima, 'la respuesta de get_watch pasa intacta (evita re-serializar en cada navegacion)');
    assert.ok(String(fake.req.init.body).includes('isInlinePlaybackNoAd'));
  });

  test('el fetch de /player anota en __mcYtAdsLog que la respuesta era JSON', async () => {
    const fake = fakeFetch();
    const ctx = crearContexto({ fetch: fake.fn });
    await ctx.fetch('https://www.youtube.com/youtubei/v1/player', { method: 'POST', body: '{}' });
    assert.ok(Array.isArray(ctx.__mcYtAdsLog));
    assert.equal(ctx.__mcYtAdsLog.length, 1);
    assert.equal(ctx.__mcYtAdsLog[0].json, true);
    assert.match(ctx.__mcYtAdsLog[0].contentType, /json/);
  });

  test('si /player deja de responder JSON, queda asentado y avisa', async () => {
    const alertas = [];
    const proto = {
      ok: true, status: 200, statusText: 'OK',
      url: 'https://www.youtube.com/youtubei/v1/player',
      headers: { get: () => 'application/x-protobuf' }
    };
    const ctx = crearContexto({
      fetch: () => Promise.resolve(proto),
      console: { warn: (m) => alertas.push(m) }
    });
    const res = await ctx.fetch('https://www.youtube.com/youtubei/v1/player', { method: 'POST', body: '' });
    assert.equal(res, proto, 'sin JSON no debe reconstruir la respuesta');
    assert.equal(ctx.__mcYtAdsLog[0].json, false);
    assert.equal(ctx.__mcYtAdsLog[0].contentType, 'application/x-protobuf');
    assert.equal(alertas.length, 1, 'debe dejar un warn en la consola del guest');
  });
});

describe('inyeccion del script', () => {
  test('se inyecta en el mundo principal solo en documentos de YouTube', () => {
    assert.match(PRELOAD, /webFrame\.executeJavaScript\(YT_AD_SCRIPT/);
    assert.ok(PRELOAD.includes("host === 'youtube.com'"));
    assert.ok(PRELOAD.includes("youtube-nocookie.com"));
  });
});
