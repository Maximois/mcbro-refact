'use strict';
/**
 * test/renderer-symbols.test.js
 *
 * Congela lo que existe hoy en src/renderer.html + src/renderer/ y falla en
 * cuanto algo de ese inventario desaparezca. Es el control de la regla de oro
 * de la Fase 2 (docs/RESTRUCTURACION.md §7.0): mover en crudo, no perder nada.
 *
 * La fixture se genera ANTES de tocar el archivo:
 *   node tools/renderer-symbols.js --write
 *
 * Ojo con lo que NO detecta y lo que si:
 *  - Un `node --check` limpio NO sirve: no valida referencias libres. Este test
 *    si, porque compara contra la base y no contra el estado actual.
 *  - Una funcion que siga existiendo pero con la logica cambiada no se ve aqui;
 *    para eso esta el `git diff` sin mezcla y el conteo de lineas (§7.5).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { collect, FIXTURE } = require('../tools/renderer-symbols.js');

const base = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const now = collect();

function perdidos(clave) {
  const actuales = new Set(now[clave]);
  return base[clave].filter(n => !actuales.has(n));
}

test('renderer: no se ha perdido ninguna funcion declarada en la base', () => {
  assert.deepStrictEqual(perdidos('functions'), []);
});

test('renderer: no se ha perdido ningun const/let de nivel superior', () => {
  assert.deepStrictEqual(perdidos('globals'), []);
});

test('renderer: no se ha perdido ningun window.* exportado', () => {
  assert.deepStrictEqual(perdidos('windowExports'), []);
});

// Globales que el navegador trae consigo y que por eso no aparecen declaradas
// en ninguna parte del repo. Solo `fetch` hace falta hoy; anadir a mano si un
// handler nuevo usa otra (que sera un cambio deliberado, no un movimiento).
const NATIVAS = new Set(['fetch']);

test('renderer: sigue existiendo la definicion de cada handler inline', () => {
  const definidos = new Set([...now.functions, ...now.globals, ...now.windowExports]);
  const sinDefinicion = base.handlers.filter(n => !definidos.has(n) && !NATIVAS.has(n));
  assert.deepStrictEqual(sinDefinicion, []);
});

test('renderer: no se ha perdido ningun handler inline (markup ni templates)', () => {
  assert.deepStrictEqual(perdidos('handlers'), []);
});

test('renderer: el inventario no ha crecido ni decrecido en silencio', () => {
  // Crecer esta bien (anadir codigo esta permitido fuera de los commits de
  // movimiento); decrecer no. Se comprueba funcion a funcion arriba; aqui solo
  // se deja constancia de las cifras de la base para que salten en el informe.
  assert.ok(base.functions.length >= 280, `base functions=${base.functions.length}`);
  assert.ok(base.windowExports.length >= 13, `base windowExports=${base.windowExports.length}`);
});
