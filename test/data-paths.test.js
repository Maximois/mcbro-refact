'use strict';

/**
 * MC Browser -- test/data-paths.test.js
 *
 * La carpeta de datos se fija con `app.setPath('userData', ...)` y varios modulos
 * calculan su ruta AL CARGARSE, leyendo `app.getPath('userData')` en el require.
 * Si el setPathTodavia no ha corrido cuando se cargan, leen la carpeta por
 * defecto y la app deja de ver los datos del usuario.
 *
 * No se puede probar en ejecucion (los tres modulos hacen `require('electron')`),
 * asi que se comprueba el ORDEN del fuente. Es lo unico que decide.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const leer = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const MAIN = leer('src/main/bootstrap.js');

const codigo = (s) => s.slice(s.indexOf('*/') + 2);

// Modulos que leen `app.getPath('userData')` al cargarse, no despues.
const LEEN_AL_CARGAR = {
  'src/main/config/index.js': 'CFG_PATH',
  'src/main/data/bookmarks.js': 'BOOKMARKS_PATH',
  'src/main/data/history.js': 'HISTORY_PATH',
};

describe('la carpeta de datos se fija antes de que nadie la lea', () => {
  test('setPath va antes del primer require de proyecto', () => {
    const setPath = MAIN.indexOf("app.setPath('userData'");
    assert.ok(setPath > 0, 'bootstrap.js tiene que fijar userData');
    // El primer require de codigo propio: algo bajo ./ o una carpeta del repo.
    const primerRequire = MAIN.search(/require\('\.\//);
    assert.ok(primerRequire > 0, 'bootstrap.js tiene requires de proyecto');
    assert.ok(setPath < primerRequire,
      `setPath('userData') esta en la linea ${MAIN.slice(0, setPath).split('\n').length} `
      + `y el primer require de proyecto en la ${MAIN.slice(0, primerRequire).split('\n').length}`);
  });

  test('los tres modulos que persisten calculan la ruta al cargarse, no al usar', () => {
    // Esta es la premisa del test de arriba. Si alguno cambiara a calcularla
    // dentro de la funcion, dejaria de depender del orden... y este test
    // empezaria a pasar por el motivo equivocado. Se avisa para que se decida.
    for (const [rel, simbolo] of Object.entries(LEEN_AL_CARGAR)) {
      const fuente = leer(...rel.split('/'));
      const decl = new RegExp(`^const ${simbolo} = path\\.join\\(app\\.getPath\\('userData'\\)`, 'm');
      assert.match(codigo(fuente), decl, `${rel} deberia calcular ${simbolo} al cargarse`);
      assert.ok(fuente.includes(simbolo), `${rel} no menciona ${simbolo}`);
    }
  });

  test('cada modulo lee la carpeta con la que bootstrap.js escribio', () => {
    // Si uno de los tres se guiara por su cuenta (por ejemplo leyendo appData
    // en vez de userData), volveria el mismo bug por otra puerta.
    for (const rel of Object.keys(LEEN_AL_CARGAR)) {
      const fuente = leer(...rel.split('/'));
      const usa = [...fuente.matchAll(/app\.getPath\('(\w+)'\)/g)].map((m) => m[1]);
      for (const carpeta of usa) {
        assert.equal(carpeta, 'userData', `${rel} lee app.getPath('${carpeta}')`);
      }
    }
  });
});