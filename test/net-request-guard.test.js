'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MOD = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'net', 'request-guard.js'),
  'utf8'
);
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const codigo = MOD.slice(MOD.indexOf('*/') + 2);

// Regresion del movimiento mecanico: un caracter perdido dentro de un regex no
// lo detecta node --check si el archivo sigue siendo JS valido... en realidad
// si, pero el punto es que el cuerpo tiene que coincidir con lo que estaba.
describe('net/request-guard.js — el cuerpo movido', () => {
  test('stripUrlQuery corta por query y por fragmento', () => {
    // El slash de cierre del regex se perdio una vez al escribir el archivo.
    assert.match(codigo, /return String\(url \|\| ''\)\.split\(\/\[\?#\]\/\)\[0\];/);
    assert.doesNotMatch(codigo, /split\(\/\[\?#\]\)/);
  });

  test('los dos helpers viajan con el guardian, no se quedan en main.js', () => {
    assert.match(MOD, /function stripUrlQuery\(url\) \{/);
    assert.match(MOD, /function requestDocumentUrl\(details\) \{/);
    assert.doesNotMatch(MAIN, /function stripUrlQuery\(/);
    assert.doesNotMatch(MAIN, /function requestDocumentUrl\(/);
  });

  test('las dos sesiones que lo usan lo llaman, cada una en su sitio', () => {
    // La principal se monta en modules-loader.js desde main.js; la extra, desde
    // su modulo de sesion (paso 13).
    // El nombre se busca sin prefijo a proposito: main.js lo llama como
    // RequestGuard.createRequestGuard() y extra.js lo importa suelto, y los dos
    // estilos son validos. Lo que no vale es que se llame sin haberla importado.
    const loader = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'modules-loader.js'),
      'utf8'
    );
    assert.match(loader, /RequestGuard\.createRequestGuard\(\)/);
    assert.match(
      MAIN,
      /const RequestGuard = require\('\.\/src\/main\/net\/request-guard'\);/
    );
    const extra = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'sessions', 'extra.js'),
      'utf8'
    );
    assert.match(extra, /createRequestGuard\(\)/);
    assert.match(extra, /require\('\.\.\/net\/request-guard'\)/);
    const total = (loader + extra).match(/(?:\w+\.)?createRequestGuard\(\)/g) || [];
    assert.equal(total.length, 2, 'la principal y la sesion extra');
    assert.doesNotMatch(MAIN, /(?<![.\w])createRequestGuard\(/);
    assert.doesNotMatch(MAIN, /(?<![.\w])stripUrlQuery\(/);
    assert.doesNotMatch(MAIN, /(?<![.\w])requestDocumentUrl\(/);
  });
});

// Esta es la parte que un test de "esta el codigo" no vigila, y es la que
// importa: el guardian no es un if/else de casos equivalentes, es una cascada
// donde cada capa puede ganarle a la siguiente.
describe('net/request-guard.js — el orden de la cascada', () => {
  const capas = [
    ['reglas por recurso (resourceRules)', 'CFG.resourceRules'],
    ['capa site-scoped', 'if (!siteOverridesBlock) {'],
    ['dentro: site-scoped antes que globales', 'siteScopedBlocks.some'],
    ['dentro: globales despues, con el bypass de auth', '!NavDomains.isAuthDomain(requestHost)'],
    ['httpsOnly', 'CFG.httpsOnly && isMainFrame'],
    ['bypass site:allow del documento', 'if (PermissionsAdapters.isSitePermissionAllowed(host)) return null;'],
    ['bypass de Google', 'if (isGoogleDocumentHost(documentHost)) {'],
    ['bypass de auth', 'if (NavDomains.isAuthDomain(requestHost) || NavDomains.isAuthDomain(documentHost)) return null;'],
    ['permisos de contenido (lo ULTIMO)', "getPermissionRuleForHost(host, 'images')"],
  ];

  for (const [nombre, marca] of capas) {
    test(`${nombre} sigue en su sitio`, () => {
      const i = codigo.indexOf(marca);
      assert.notEqual(i, -1, `no encuentro: ${marca}`);
      return i;
    });
  }

  // El contraste site-scoped / globales es deliberado: las site-scoped aplican
  // siempre, las globales no en dominios auth. Invertir el orden rompe el login.
  test('site-scoped se evalua antes que las globales', () => {
    assert.ok(
      codigo.indexOf('siteScopedBlocks.some') < codigo.indexOf('!NavDomains.isAuthDomain(requestHost)'),
      'las site-scoped tienen que comprobarse primero: son las que no tienen bypass'
    );
  });

  // La frase que resume el orden es: los bloqueos ganan, los permisos de
  // contenido no aplican en Google ni en la cadena OAuth.
  //
  // Los bypass cortan ANTES de la capa de permisos de contenido. Escrito al
  // reves (que fue como se documento la primera vez), el test lo detecta: en
  // Google se permitirian los hosts de anuncios, y en un login los permisos de
  // contenido cortarian la cadena OAuth.
  test('los bypass cortan ANTES de los permisos de contenido', () => {
    const permisos = codigo.indexOf("getPermissionRuleForHost(host, 'images')");
    assert.ok(permisos > 0, 'no encuentro la capa de permisos de contenido');
    assert.ok(
      codigo.indexOf('if (isGoogleDocumentHost(documentHost)) {') < permisos,
      'el bypass de Google tiene que cortar antes'
    );
    assert.ok(
      codigo.indexOf('isAuthDomain(requestHost) || NavDomains.isAuthDomain(documentHost)) return null;') < permisos,
      'el bypass de auth tiene que cortar antes'
    );
  });

  // Y al reves: los bloqueos (capas 1-5) se resuelven ANTES que los bypass, para
  // que una regla de bloqueo del usuario gane siempre.
  test('los bloqueos se resuelven antes que los bypass', () => {
    const bypass = codigo.indexOf('if (isGoogleDocumentHost(documentHost)) {');
    assert.ok(codigo.indexOf('if (!siteOverridesBlock) {') < bypass);
    assert.ok(codigo.indexOf('CFG.resourceRules') < bypass);
  });

  test('httpsOnly va despues de las reglas de bloqueo, no antes', () => {
    assert.ok(
      codigo.indexOf('if (!siteOverridesBlock) {') < codigo.indexOf('CFG.httpsOnly && isMainFrame'),
      'una redireccion a https no puedeesser el atajo para saltarse un bloqueo'
    );
  });
});

describe('net/request-guard.js — los contratos', () => {
  // Corre dentro de un handler de red de Chromium: un throw deja la peticion
  // colgada. Por eso todo el cuerpo va en try y cae a null (dejar pasar).
  test('todo el cuerpo va en try y cae a null', () => {
    assert.match(codigo, /return \(details\) => \{\s*\n\s*try \{/);
    assert.match(codigo, /\} catch \{\}\s*\n\s*return null;\s*\n\s*\};/);
  });

  test('las cuatro decisiones posibles', () => {
    assert.match(codigo, /return \{ cancel: true \};/);
    assert.match(codigo, /return \{ allow: true \};/);
    assert.match(codigo, /return \{ redirectURL: parsed\.toString\(\) \};/);
    assert.match(codigo, /return null;/);
  });

  // httpsOnly no debe tocar localhost ni [::1]: developedor, no web.
  test('httpsOnly respeta los hosts locales', () => {
    assert.match(codigo, /parsed\.hostname === 'localhost' \|\| parsed\.hostname === '127\.0\.0\.1' \|\| parsed\.hostname === '\[::1\]'/);
  });

  // El puerto 80 explicito se limpia al pasar a https, si no queda :80 en la URL.
  test('httpsOnly limpia el puerto 80', () => {
    assert.match(codigo, /if \(!parsed\.port \|\| parsed\.port === '80'\) parsed\.port = '';/);
  });

  // Las reglas por recurso se comparan sin query, que es el bug que las hacia
//degenerar silenciosamente entre recargas.
  test('resourceRules se compara sin query string', () => {
    assert.match(codigo, /rule\.url === details\?\.url \|\| stripUrlQuery\(rule\.url\) === requestUrlNoQuery/);
  });

  test('los cuatro imports vienen de los modulos Dueños', () => {
    assert.match(MOD, /const \{ CFG \} = require\('\.\.\/config'\);/);
    assert.match(MOD, /require\('\.\.\/navigation\/domains'\)/);
    assert.match(MOD, /require\('\.\.\/permissions\/adapters'\)/);
    // Desde src/main/net/ la raiz son TRES niveles.
    assert.match(MOD, /require\('\.\.\/\.\.\/\.\.\/modules\/adblocker\/main'\)/);
    assert.doesNotMatch(MOD, /require\('\.\.\/\.\.\/modules\//);
  });
});