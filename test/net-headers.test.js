'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// net/headers.js hace require('electron') de forma indirecta (via sus
// imports), asi que no se importa en un test de node plano: se lee el fuente.
const MOD = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'net', 'headers.js'),
  'utf8'
);
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src/main/bootstrap.js'), 'utf8');
const codigo = MOD.slice(MOD.indexOf('*/') + 2);

describe('net/headers.js — los tres interceptores estan en el modulo', () => {
  test('onBeforeSendHeaders, onHeadersReceived y cookies.on changed', () => {
    assert.match(MOD, /sess\.webRequest\.onBeforeSendHeaders\(/);
    assert.match(MOD, /sess\.webRequest\.onHeadersReceived\(/);
    assert.match(MOD, /sess\.cookies\.on\('changed'/);
    // Los tres de la sesion principal ya no estan en bootstrap.js. El de WhatsApp si
    // sigue, y es correcto: cuelga de waSess y se va con su sesion (paso 13).
    assert.doesNotMatch(MAIN, /sess\.webRequest\.onBeforeSendHeaders/);
    assert.doesNotMatch(MAIN, /sess\.webRequest\.onHeadersReceived/);
    assert.doesNotMatch(MAIN, /sess\.cookies\.on\('changed'/);
  });

  test('el interceptor de WhatsApp vive en su sesion, no en bootstrap.js', () => {
    const wa = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'sessions', 'whatsapp.js'), 'utf8');
    assert.match(wa, /waSess\.webRequest\.onBeforeSendHeaders/);
    assert.match(MOD, /setHdr\('sec-ch-ua'/);
    assert.match(MOD, /WhatsApp \(regla especial\)/);
    // Es el único que queda en el repo, y es el único permitido: cuelga de
    // waSess, o sea que solo aplica a la sesión de WhatsApp.
    const restantesMain = MAIN.match(/\.webRequest\.onBeforeSendHeaders/g) || [];
    const restantesWa = wa.match(/\.webRequest\.onBeforeSendHeaders/g) || [];
    assert.equal(restantesMain.length + restantesWa.length, 1, 'solo debe quedar el de la sesion de WhatsApp');
  });

  // El registro se hace con la sesion ya resuelta: el modulo no debe decidir
  // que particion es, porque cada sesion (principal, aislada) tiene la suya.
  test('recibe la sesion por parametro y no llama a fromPartition', () => {
    assert.match(MOD, /function installHeaderInterceptors\(sess, deps\) \{/);
    // Con la llamada, no con el nombre: el JSDoc menciona fromPartition al
    // explicar justamente que no se llama.
    assert.doesNotMatch(codigo, /fromPartition\s*\(/);
  });

  // Este test existe por un bug real: la llamada se comio en bootstrap.js sin el
  // prefijo Headers. node --check lo acepta (es una referencia libre, no un
  // error de sintaxis) y los tests de arriba pasaban igual, porque solo
  // comprueban que el MODULO tenga los interceptores, no que bootstrap.js lo llame.
  // Solo el boot-smoke lo veia, y antes daba verde: el ReferenceError salia
  // despues de crear la ventana. Por eso el smoke ahora lee el log.
  test('bootstrap.js lo llama cualificado', () => {
    assert.match(MAIN, /Headers\.installHeaderInterceptors\(sess, \{/);
    assert.doesNotMatch(MAIN, /[^.\w]installHeaderInterceptors\(/);
  });

  test('los tres helpers de streams se pasan en deps', () => {
    const llamada = MAIN.match(/Headers\.installHeaderInterceptors\(sess, \{([\s\S]*?)\}\);/);
    assert.ok(llamada, 'no se encontro la llamada con su bloque deps');
    assert.match(llamada[1], /isStreamHlsCaptureEnabled: StreamCapture\.isStreamHlsCaptureEnabled,/);
    assert.match(llamada[1], /consumeStreamEntryReferer: StreamCapture\.consumeStreamEntryReferer,/);
    assert.match(llamada[1], /findHlsPlayerEntry: StreamCapture\.findHlsPlayerEntry,/);
  });
});

describe('net/headers.js — deps: los helpers de streams llegan inyectados', () => {
  test('falla ruidosamente si deps esta incompleto', () => {
    assert.match(MOD, /if \(typeof isStreamHlsCaptureEnabled !== 'function' \|\|/);
    assert.match(MOD, /throw new Error\('installHeaderInterceptors: deps incompleto'\)/);
  });

  // El flag es un `let` de capture.js. Si el modulo lo capturara por valor al
  // registrarse, se congelaria en false y la captura HLS no cambiaria.
  test('el flag de captura HLS se lee por getter, no por valor', () => {
    assert.match(MAIN, /isStreamHlsCaptureEnabled: StreamCapture\.isStreamHlsCaptureEnabled/);
    assert.match(MOD, /if \(isStreamHlsCaptureEnabled\(\) && /);
    assert.doesNotMatch(codigo, /[^.]\bstreamHlsCaptureEnabled\b(?!\s*[:(])/);
  });

  // El delete del Map es parte del CONSUMO: separar lookup y borrado permitiria
  // que un segundo request del mismo token reutilizara el referer. La
  // implementacion vive ahora en src/main/streams/capture.js (paso 20);
  // bootstrap.js solo la inyecta como dep.
  const CAPTURE = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'streams', 'capture.js'),
    'utf8'
  );
  test('lookup y borrado del referer van juntos en consumeStreamEntryReferer', () => {
    assert.match(
      CAPTURE,
      /function consumeStreamEntryReferer\(details\) \{\s*\n\s*const match = findStreamEntryReferer\(details\);\s*\n\s*if \(!match\) return null;\s*\n\s*streamEntryReferers\.delete\(match\.key\);\s*\n\s*return match\.entry;/
    );
    assert.match(MOD, /const entryReferer = consumeStreamEntryReferer\(d\);/);
    // Y el modulo ya no toca el Map.
    assert.doesNotMatch(codigo, /streamEntryReferers/);
    assert.doesNotMatch(codigo, /findStreamEntryReferer\b/);
  });

  test('bootstrap.js pasa los 3 deps en la llamada', () => {
    const m = MAIN.match(/installHeaderInterceptors\(sess, \{([\s\S]*?)\}\);/);
    assert.ok(m, 'no encuentro la llamada con deps');
    for (const d of ['isStreamHlsCaptureEnabled', 'consumeStreamEntryReferer', 'findHlsPlayerEntry']) {
      assert.ok(m[1].includes(d), `falta el dep ${d}`);
    }
  });
});

describe('net/headers.js — las excepciones cortan antes de filtrar', () => {
  // Si el return temprano de Perchance o de los dominios de auth se moviera
  // despues, la sesion de Perchance recibiria Accept-Language y el aislamiento
  // de cookies, y Cloudflare/Turnstile volveria a romperse.
  test('Perchance se detecta por host antes de tocar cabeceras', () => {
    const i = MOD.indexOf('if (isPerchanceHost(targetHost) || isPerchanceHost(docHost))');
    const j = MOD.indexOf("headers['Accept-Language']");
    assert.ok(i > -1 && j > -1, 'no encuentro los dos puntos');
    assert.ok(i < j, 'la excepcion de Perchance debe ir antes que Accept-Language');
    assert.match(MOD, /headers\['User-Agent'\] = PERCHANCE_UA;/);
  });

  test('los dominios de auth devuelven las cabeceras intactas', () => {
    assert.match(
      MOD,
      /if \(isAuthDomain\(targetHost\) \|\| isAuthDocument \|\| isAuthRedirectFlow\(targetHost, docHost\)\) \{\s*\n\s*return cb\(\{ requestHeaders: headers \}\);/
    );
    assert.match(
      MOD,
      /if \(isAuthDomain\(host\) \|\| isAuthDomain\(docHost\) \|\| isAuthRedirectFlow\(host, docHost\)\) \{\s*\n\s*return cb\(\{ responseHeaders \}\);/
    );
  });
});

describe('net/headers.js — onHeadersReceived no bloquea si algo falla', () => {
  // El catch cae en cb({}), que es "dejar pasar". Si algun dia pasara a
  // cb({ cancel: true }) seria un cambio de comportamiento muy serio.
  test('el catch deja pasar la respuesta', () => {
    assert.match(MOD, /catch \(e\) \{ \/\* ignore header parse errors \*\/ \}\s*\n\s*cb\(\{\}\);/);
    assert.doesNotMatch(codigo, /cancel:\s*true/);
  });
});

describe('net/headers.js — los contenedores de video embebidos no se niegan con X-Frame-Options', () => {
  // luluvdo.com (y otros contenedores) se cargan en iframes y mandan
  // X-Frame-Options: deny; Chromium se niega a pintar el marco. El strip de
  // x-frame-options y de frame-ancestors solo aplica a iframes (subFrame/object)
  // cuyo host esta en la allowlist de VIDEO_HOSTS, no a toda la navegacion.
  test('importa isVideoHost y lo usa con el host en subFrame', () => {
    assert.match(MOD, /isTrustedResource, isVideoHost } = require\('\.\.\/\.\.\/\.\.\/modules\/adblocker\/main'\)/);
    const i = MOD.indexOf('x-frame-options');
    const j = MOD.indexOf('isVideoHost(host)');
    assert.ok(i > -1 && j > -1, 'no encuentro el strip de XFO ni isVideoHost');
    const seg = MOD.slice(Math.max(0, i - 500), i + 900);
    assert.match(seg, /isSubFrame && isVideoHost\(host\)/);
    assert.match(seg, /subframe/);
  });

  test('el strip de XFO es condicional a iframe y host de video', () => {
    assert.match(codigo, /if \(isSubFrame && isVideoHost\(host\)\) \{/);
    assert.match(codigo, /x-frame-options/);
    assert.match(codigo, /frame-ancestors/);
  });
});

describe('net/headers.js — nada quedo colgando en bootstrap.js', () => {
  test('los simbolos que el modulo ahora importa no se usan sueltos', () => {
    for (const s of ['isTrustedResource', 'resolveCookieAction', 'addCookiesBlocked',
      'getAllowlistPolicyForHost', 'PERCHANCE_UA', 'isAuthRedirectFlow', 'isAuthDomain',
      'cookieRemovalUrl', 'getMainWin']) {
      const rx = new RegExp(`(?<![.\\w])${s}\\b`);
      if (rx.test(MAIN) && !new RegExp(`const .*\\b${s}\\b`).test(MAIN)) {
        // Solo es legitimo si bootstrap.js lo declara o lo reexporta; en ningun caso
        // debe seguir usandolo sin calificar por una extraccion a medias.
        throw new Error(`${s} se usa sin calificar en bootstrap.js`);
      }
    }
  });
});