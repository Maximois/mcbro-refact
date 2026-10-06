'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PART = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'sessions', 'partitions.js'),
  'utf8'
);
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const codigo = PART.slice(PART.indexOf('*/') + 2);

describe('sessions/partitions.js — los nombres de particion', () => {
  test('son los mismos de siempre', () => {
    assert.match(PART, /const WEBCHAT_PARTITION = 'persist:mc-webchat';/);
    assert.match(PART, /const WHATSAPP_PARTITION = 'persist:mc-whatsapp';/);
  });

  test('extraSessionPartition compone el id de la config', () => {
    assert.match(PART, /function extraSessionPartition\(id\) \{\s*\n\s*return 'persist:mc-session-' \+ id;/);
  });

  // 'persist:mc' sigue escrito a mano en varios sitios de main.js a proposito:
  // unificarlo es otro commit, con su propio test de paridad de strings.
  test('la particion principal NO se unifico todavia', () => {
    // Contra el codigo, no contra el archivo: el JSDoc nombra MAIN_PARTITION
    // precisamente para explicar que NO se unifico.
    assert.doesNotMatch(codigo, /MAIN_PARTITION/);
    assert.match(PART, /session\.fromPartition\('persist:mc'\)/);
    const enMain = (MAIN.match(/fromPartition\('persist:mc'\)/g) || []).length;
    assert.ok(enMain > 0, 'main.js sigue usando el literal, como antes');
  });
});

describe('sessions/partitions.js — los predicados no lanzan nunca', () => {
  // Cada uno corre dentro de handlers de permisos, webRequest y
  // web-contents-created. Un throw ahi se come el evento entero, y en el caso
  // de esWebviewProtegido ademas rompe la politica de cookies en silencio.
  const predicados = ['isMainBrowsingSession', 'isWebchatSession', 'isExtraSessionWebContents'];

  for (const nombre of predicados) {
    test(`${nombre} cae a false si fromPartition revienta`, () => {
      const cuerpo = PART.match(new RegExp(`function ${nombre}\\(wc\\) \\{[\\s\\S]*?\\n\\}`));
      assert.ok(cuerpo, `no encuentro ${nombre}`);
      assert.match(cuerpo[0], /try \{/, `${nombre} no va envuelto en try`);
      assert.match(cuerpo[0], /catch \{ return false; \}/, `${nombre} no cae a false`);
    });
  }

  test('esWebviewProtegido compone los otros dos', () => {
    assert.match(
      PART,
      /function esWebviewProtegido\(wc\) \{\s*\n\s*return isMainBrowsingSession\(wc\) \|\| isExtraSessionWebContents\(wc\);/
    );
  });
});

describe('sessions/partitions.js — main.js lo usa siempre cualificado', () => {
  // El fallo que esto evita: mover el bloque y dejar una llamada sin
  // Sessions., que node --check acepta y que solo se ve al arrancar.
  test('ninguna mencion sin Sessions.', () => {
    for (const x of ['WEBCHAT_PARTITION', 'WHATSAPP_PARTITION', 'extraSessionPartition',
                     'isWebchatSession', 'isMainBrowsingSession', 'isExtraSessionWebContents',
                     'esWebviewProtegido']) {
      const sueltas = [...MAIN.matchAll(new RegExp(`(?<![.\\w])${x}\\b`, 'g'))];
      assert.equal(sueltas.length, 0, `${x} aparece sin Sessions. ${sueltas.length} vez/veces`);
    }
  });

  test('las definiciones se fueron de main.js', () => {
    assert.doesNotMatch(MAIN, /const WEBCHAT_PARTITION\s*=/);
    assert.doesNotMatch(MAIN, /function isWebchatSession\(/);
    assert.doesNotMatch(MAIN, /function esWebviewProtegido\(/);
    assert.doesNotMatch(MAIN, /function extraSessionPartition\(/);
  });

  test('el require esta a nivel de modulo', () => {
    assert.match(MAIN, /const Sessions = require\('\.\/src\/main\/sessions\/partitions'\);/);
  });
});

describe('sessions/partitions.js — se acabaron las inyecciones temporales', () => {
  // Este modulo existia para esto. Las dos inyecciones que hubo que hacer en
  // los pasos 10 y 12 tenian fecha de caducidad.
  test('cookie-guard importa el filtro en vez de recibirlo', () => {
    const CG = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'net', 'cookie-guard.js'), 'utf8');
    assert.match(CG, /const Sessions = require\('\.\.\/sessions\/partitions'\);/);
    assert.match(CG, /function refreshCookieGuards\(\) \{/);
    assert.doesNotMatch(CG, /refreshCookieGuards\(esAplicable\)/);
  });

  test('proxy importa los nombres en vez de recibirlos', () => {
    const PX = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'net', 'proxy.js'), 'utf8');
    assert.match(PX, /const \{ WEBCHAT_PARTITION, WHATSAPP_PARTITION \} = require\('\.\.\/sessions\/partitions'\);/);
    assert.match(PX, /async function setProxy\(settings = \{\}\) \{/);
    assert.doesNotMatch(PX.slice(PX.indexOf('*/') + 2), /partitions\.webchat|partitions\.whatsapp/);
  });

  // El IPC tiene que seguir ahi. Se perdio una vez: el helper que quita un
  // bloque de main.js lo borraba entero en vez de sustituirlo, y el test de
  // proxy:set lo	echo notar antes de commitear.
  test('proxy:set sigue registrado', () => {
    assert.match(MAIN, /ipcMain\.handle\('proxy:set', \(_e, settings = \{\}\) => Proxy\.setProxy\(settings\)\);/);
  });
});

describe('sessions/partitions.js — el guard de proxy redundante', () => {
  // applyProxyFromCfg() ya sale solo si no hay proxy, asi que el if exterior
  // solo duplicaba la condicion. Cuatro copias de el, ademas.
  test('los 4 call sites ya no comprueban CFG.proxyEnabled', () => {
    const guards = MAIN.match(/if \(CFG\.proxyEnabled && CFG\.proxyHost\)/g) || [];
    assert.equal(guards.length, 0, `quedan ${guards.length} guards redundantes`);
    // Tres de los cuatro call sites se fueron a sus modulos de sesion en el
    // paso 13, pero el guard redundante no puede haberlastingido: se busca en
    // todos, que es donde un if colado seria invisible.
    const modulos = ['extra', 'webchat', 'whatsapp']
      .map((m) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'sessions', `${m}.js`), 'utf8'))
      .join('\n');
    assert.doesNotMatch(modulos, /if \(CFG\.proxyEnabled && CFG\.proxyHost\)/);
    const llamadas = `${MAIN}\n${modulos}`.match(/(?:\w+\.)?applyProxyFromCfg\(/g) || [];
    assert.equal(llamadas.length, 4);
  });
});