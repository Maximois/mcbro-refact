'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// net/cookie-guard.js hace require('electron'), asi que no se puede importar en
// un test de node plano. Estos tests leen el fuente y fijan invariantes que
// sobreviven a un "ordenar el codigo" mal hecho.
const MOD = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'net', 'cookie-guard.js'),
  'utf8'
);
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src/main/bootstrap.js'), 'utf8');
const PART = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'sessions', 'partitions.js'),
  'utf8'
);
// headers.js importa cookieRemovalUrl de este modulo: uno de los 8 usos vive
// alli desde el paso 11, no en bootstrap.js.
const HEADERS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'net', 'headers.js'),
  'utf8'
);
// Y cinco de los ocho pasaron a sessions/ipc.js en el paso 14: son los que
// borran cookies enteras de una particion.
const SESSIONS_IPC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'sessions', 'ipc.js'),
  'utf8'
);

describe('net/cookie-guard.js — el estado es débil a propósito', () => {
  // Un Map/Set retendria los webContents destruidos para siempre.
  test('los 4 registros son WeakMap/WeakSet, no Map/Set', () => {
    assert.match(MOD, /const cookieGuardIds = new WeakMap\(\)/);
    assert.match(MOD, /const cookieGuardOwned = new WeakSet\(\)/);
    assert.match(MOD, /const cookieGuardLifecycleInstalled = new WeakSet\(\)/);
    assert.match(MOD, /const cookieGuardTasks = new WeakMap\(\)/);
  });

  // El bug mas caro de esta zona: si nos desconectamos el debugger de otro se
  // le rompe el panel de Perchance, que tambien usa CDP sobre las suyas.
  test('nunca se hace detach() de un debugger que no es nuestro', () => {
    assert.match(
      MOD,
      /if \(owned && wc\.debugger\.isAttached\(\)\) \{\s*\n\s*try \{ wc\.debugger\.detach\(\); \} catch \{\}/,
      'detachCookieGuard debe gatear el detach con cookieGuardOwned'
    );
    // Y attach solo marca como propio cuando el attach lo hizo este modulo.
    assert.match(MOD, /wc\.debugger\.attach\('1\.3'\);\s*\n\s*cookieGuardOwned\.add\(wc\);/);
  });
});

describe('net/cookie-guard.js — el lifecycle se instala una sola vez', () => {
  test('installCookieGuardLifecycle se autodocena antes de poner listeners', () => {
    assert.match(
      MOD,
      /if \(cookieGuardLifecycleInstalled\.has\(wc\)\) return;\s*\n\s*cookieGuardLifecycleInstalled\.add\(wc\);/
    );
  });

  // updateCookieGuard se llama por cada webview nuevo y en cada refresh de
  // config: sin este flag se acumularían listeners de 'detach'/'destroyed'.
  test('attachCookieGuard es idempotente respecto al attach del debugger', () => {
    assert.match(MOD, /if \(!wc\.debugger\.isAttached\(\)\) \{/);
  });

  // Los updates se serializan por wc: dos refresh seguidos no deben pelearse por
  // el mismo identifier de script CDP.
  test('los updates en vuelo se encadenan en vez de solaparse', () => {
    assert.match(MOD, /const previous = cookieGuardTasks\.get\(wc\);/);
    assert.match(MOD, /previous \? previous\.catch\(\(\) => \{\}\)\.then\(run\) : run\(\)/);
  });
});

describe('net/cookie-guard.js - el filtro de sesiones', () => {
  // El filtro (main + aisladas) es Sessions.esWebviewProtegido, de
  // sessions/partitions.js. Antes lo recibia por parametro porque ese modulo no
  // existia; desde el paso 13 se importa y la llamada se simplifica.
  test('el filtro se importa, ya no es un parametro', () => {
    assert.match(MOD, /const Sessions = require\('\.\.\/sessions\/partitions'\);/);
    assert.match(MOD, /function refreshCookieGuards\(\) \{/);
    assert.match(MOD, /wc\.getType\(\) === 'webview' && Sessions\.esWebviewProtegido\(wc\)/);
  });

  // WebChat y Perchance quedan fuera a proposito. Solo el codigo: la cabecera
  // los nombra a proposito para explicar de donde viene el filtro.
  test('no reimplementa el predicado, lo usa', () => {
    const codigo = MOD.slice(MOD.indexOf('*/') + 2);
    assert.doesNotMatch(
      codigo,
      /function esWebviewProtegido|function isMainBrowsingSession|function isExtraSessionWebContents/
    );
  });

  // Desde src/main/net/ la raiz del repo son TRES niveles arriba. Con dos, el
  // require apunta a src/lib/permissions y revienta al arrancar.
  test('los requires que cruzan fuera de src/main llevan tres niveles', () => {
    assert.match(MOD, /require\('\.\.\/\.\.\/\.\.\/lib\/permissions'\)/);
    assert.doesNotMatch(MOD, /require\('\.\.\/\.\.\/lib\//);
  });

  // Si alguien reintrodujera el parametro, uno de los cuatro call sites se
  // quedaria sin filtro y el script se inyectaria donde antes no estaba.
  test('los 4 call sites de bootstrap.js ya no pasan predicado', () => {
    const llamadas = MAIN.match(/CookieGuard\.refreshCookieGuards\(\)/g) || [];
    assert.equal(llamadas.length, 4, 'update-cfg, add-cookie-rule, remove-cookie-rule, arranque');
    assert.doesNotMatch(MAIN, /refreshCookieGuards\(esWebviewProtegido\)/);
    assert.doesNotMatch(MAIN, /function esWebviewProtegido/);
  });

  // El predicado ahora vive en partitions.js. Este test es el que impide que
  // las dos copias se desincronicen si alguien vuelve a tocarlo.
  test('el predicado sigue cubriendo las mismas dos sesiones', () => {
    assert.match(
      PART,
      /function esWebviewProtegido\(wc\) \{\s*\n\s*return isMainBrowsingSession\(wc\) \|\| isExtraSessionWebContents\(wc\);/
    );
  });
});

describe('net/cookie-guard.js — el script inyectado', () => {
  test('re-registra el script CDP en vez de acumularlos', () => {
    assert.match(
      MOD,
      /Page\.removeScriptToEvaluateOnNewDocument[\s\S]*?Page\.addScriptToEvaluateOnNewDocument/
    );
  });

  // El snapshot de CFG es lo que permite que el closure sobreviva al reload de
  // config: si el script leyera CFG en vivo, quedaría desactualizado.
  test('congela la política en un snapshot serializado', () => {
    assert.match(
      MOD,
      /const policySnapshot = \{ cookiePolicy: CFG\.cookiePolicy, allowlist: CFG\.allowlist \|\| \{\} \}/
    );
    assert.match(MOD, /const POLICY = \$\{JSON\.stringify\(policySnapshot\)\}/);
  });

  test("el override de document.cookie es fail-open", () => {
    assert.match(MOD, /catch \(e\) \{ \/\* fail-open: nunca romper la página por esto \*\/ \}/);
  });
});

describe('net/cookie-guard.js — API exportada', () => {
  test('exporta lo que bootstrap.js consume', () => {
    assert.match(MOD, /module\.exports\s*=\s*\{[\s\S]*?cookieRemovalUrl,[\s\S]*?updateCookieGuard,[\s\S]*?refreshCookieGuards,[\s\S]*?applyCookiePolicy,[\s\S]*?\};/);
  });

  test('cookieRemovalUrl se usa desde 8 sitios, 5 en sessions/ipc.js y 3 fuera', () => {
    const enIpc = SESSIONS_IPC.match(/CookieGuard\.cookieRemovalUrl\(/g) || [];
    const enMain = MAIN.match(/CookieGuard\.cookieRemovalUrl\(/g) || [];
    const enHeaders = HEADERS.match(/(?<![.\w])cookieRemovalUrl\(/g) || [];
    assert.equal(enIpc.length + enMain.length + enHeaders.length, 8, 'el total no debe cambiar al mover codigo');
    assert.equal(enIpc.length, 5, 'los de limpieza de sesion pasaron al paso 14');
    assert.equal(enMain.length, 2, 'en bootstrap.js quedan los de cookies por sitio');
    // Y ningun llamada sin calificar, en ninguno de los tres ficheros.
    assert.doesNotMatch(SESSIONS_IPC, /(?<![.\w])cookieRemovalUrl\(/);
    assert.doesNotMatch(MAIN, /(?<![.\w])cookieRemovalUrl\(/);
    assert.doesNotMatch(HEADERS, /CookieGuard\.cookieRemovalUrl\(/);
  });

  test('applyCookiePolicy y updateCookieGuard quedan calificados', () => {
    assert.doesNotMatch(MAIN, /(?<![.\w])applyCookiePolicy\(/);
    assert.doesNotMatch(MAIN, /(?<![.\w])updateCookieGuard\(/);
    assert.equal((MAIN.match(/CookieGuard\.applyCookiePolicy\(/g) || []).length, 1);
    // Si ya no está aqui, es que lo movió el paso 24
    assert.equal((MAIN.match(/CookieGuard\.updateCookieGuard\(/g) || []).length, 0,
      'updateCookieGuard se movió a windows/webcontents.js');
    const WEB = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'main', 'windows', 'webcontents.js'), 'utf8');
    assert.equal((WEB.match(/CookieGuard\.updateCookieGuard\(/g) || []).length, 1);
    assert.ok(WEB.includes('CookieGuard.updateCookieGuard('));
  });
});