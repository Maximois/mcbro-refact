'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  AUTH_DOMAINS,
  isAuthDomain,
  isAuthRedirectFlow,
  isAuthPopupUrl,
  baseNavigationDomain,
  MULTI_LABEL_PUBLIC_SUFFIXES,
  PCH_CHROME_MAJOR,
  PERCHANCE_UA,
  UA_WHATSAPP,
} = require('../src/main/navigation/domains');

describe('isAuthDomain', () => {
  test('reconoce subdominios reales de la lista', () => {
    assert.equal(isAuthDomain('accounts.google.com'), true);
    assert.equal(isAuthDomain('login.microsoftonline.com'), true);
    assert.equal(isAuthDomain('auth.x.ai'), true);
  });

  // Esta es la trampa que el codigo documenta: sin el punto delante del
  // sufijo, 'evil-google.com'.endsWith('google.com') es true.
  test('NO reconoce hosts que solo terminan igual', () => {
    assert.equal(isAuthDomain('evil-google.com'), false);
    assert.equal(isAuthDomain('notgoogle.com'), false);
    assert.equal(isAuthDomain('fakegithub.com'), false);
  });

  test('normaliza mayusculas y punto inicial', () => {
    assert.equal(isAuthDomain('.GITHUB.COM'), true);
    assert.equal(isAuthDomain('GITHUB.com'), true);
  });

  test('rechaza vacios y basura', () => {
    assert.equal(isAuthDomain(''), false);
    assert.equal(isAuthDomain(null), false);
    assert.equal(isAuthDomain(undefined), false);
  });
});

describe('isAuthRedirectFlow', () => {
  test('basta con que uno de los dos sea dominio de auth', () => {
    assert.equal(isAuthRedirectFlow('grok.com', 'accounts.google.com'), true);
    assert.equal(isAuthRedirectFlow('auth.x.ai', 'x.com'), true);
    assert.equal(isAuthRedirectFlow('x.com', 'auth.x.ai'), true);
  });

  test('exige al menos uno', () => {
    assert.equal(isAuthRedirectFlow('example.com', 'other.org'), false);
    assert.equal(isAuthRedirectFlow('', ''), false);
  });
});

describe('isAuthPopupUrl', () => {
  test('extrae el hostname y lo consulta', () => {
    assert.equal(isAuthPopupUrl('https://auth.x.ai/oauth/authorize?x=1'), true);
    assert.equal(isAuthPopupUrl('https://example.com/login'), false);
  });

  test('una URL invalida no lanza: devuelve false', () => {
    assert.equal(isAuthPopupUrl('no-es-una-url'), false);
    assert.equal(isAuthPopupUrl(''), false);
  });
});

describe('baseNavigationDomain', () => {
  test('reduce a dos etiquetas', () => {
    assert.equal(baseNavigationDomain('a.b.com'), 'b.com');
    assert.equal(baseNavigationDomain('www.ejemplo.com'), 'ejemplo.com');
  });

  test('respeta los sufijos compuestos de la lista', () => {
    // 'a.b.com.mx' -> partes [a,b,com,mx], sufijo 'com.mx' esta en la lista, asi
    // que se quedan las TRES ultimas etiquetas, no las dos.
    assert.equal(baseNavigationDomain('a.b.com.mx'), 'b.com.mx');
    assert.equal(baseNavigationDomain('www.ejemplo.co.uk'), 'ejemplo.co.uk');
    assert.equal(MULTI_LABEL_PUBLIC_SUFFIXES.has('com.mx'), true);
  });

  test('un host de una o dos etiquetas se devuelve tal cual', () => {
    assert.equal(baseNavigationDomain('ejemplo.com'), 'ejemplo.com');
    assert.equal(baseNavigationDomain('localhost'), 'localhost');
  });

  test('normaliza punto inicial y punto final', () => {
    assert.equal(baseNavigationDomain('.www.ejemplo.com.'), 'ejemplo.com');
  });
});

describe('constantes de User-Agent', () => {
  test('la UA de Perchance deriva del motor real, no de un numero fijo', () => {
    // Declarar un Chrome mayor que el motor hace que la web sirva features que
    // el motor no soporta. Ver la cabecera del modulo.
    assert.equal(PERCHANCE_UA.includes(`Chrome/${PCH_CHROME_MAJOR}.0.0.0`), true);
    // Fuera de Electron `process.versions.chrome` no existe, asi que entra el
    // fallback. Que sea 124 aqui y el motor real dentro de Electron es
    // justamente lo que hay que comprobar, no un valor fijo.
    const real = process.versions.chrome;
    assert.equal(PCH_CHROME_MAJOR, real ? real.split('.')[0] : '124');
  });

  test('las dos UAs son distintas', () => {
    assert.notEqual(UA_WHATSAPP, PERCHANCE_UA);
  });
});

describe('AUTH_DOMAINS', () => {
  test('es una lista real, no vacia ni degenerada', () => {
    assert.ok(Array.isArray(AUTH_DOMAINS));
    assert.ok(AUTH_DOMAINS.length > 50);
  });

  test('no tiene entradas vacias ni con espacios', () => {
    for (const domain of AUTH_DOMAINS) {
      assert.equal(typeof domain, 'string');
      assert.equal(domain, domain.trim());
      assert.notEqual(domain, '');
    }
  });

  test('cada entrada coincide con su propio predicado', () => {
    for (const domain of AUTH_DOMAINS) {
      assert.equal(isAuthDomain(domain), true, `${domain} deberia ser dominio de auth`);
    }
  });
});