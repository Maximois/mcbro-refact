'use strict';
/** Hito 2: tablas e imagenes -- nucleo puro, parches de la IA y HTML. */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const model = require('../modules/document-editor/core/model');
const patch = require('../modules/document-editor/core/patch');
const tables = require('../modules/document-editor/core/tables');
const html = require('../modules/document-editor/core/html');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const T = () => ({ type: 'table', header: true, rows: [['a', 'b'], ['c', 'd']] });

describe('core/tables: tablas', () => {
  test('create respeta limites y encabezado', () => {
    const t = tables.create(3, 4);
    assert.equal(t.rows.length, 3);
    assert.ok(t.rows.every((r) => r.length === 4 && r.every((c) => c === '')));
    assert.equal(t.header, true);
    assert.equal(tables.create(999, 999).rows.length, tables.MAX_ROWS);
    assert.equal(tables.create(0, 0).rows[0].length, 1);
    assert.equal(tables.create(2, 2, false).header, false);
  });

  test('addRow antes/despues y no muta la entrada', () => {
    const t = T();
    const a = tables.addRow(t, 0, 'before');
    assert.deepEqual(a.rows, [['', ''], ['a', 'b'], ['c', 'd']]);
    assert.deepEqual(tables.addRow(t, 0, 'after').rows, [['a', 'b'], ['', ''], ['c', 'd']]);
    assert.equal(t.rows.length, 2);
  });

  test('deleteRow: nunca deja la tabla sin filas', () => {
    assert.deepEqual(tables.deleteRow(T(), 0).rows, [['c', 'd']]);
    assert.equal(tables.deleteRow({ type: 'table', rows: [['x']] }, 0), null);
    assert.equal(tables.deleteRow(T(), 'zz'), null);
  });

  test('addCol / deleteCol', () => {
    assert.deepEqual(tables.addCol(T(), 0, 'before').rows, [['', 'a', 'b'], ['', 'c', 'd']]);
    assert.deepEqual(tables.addCol(T(), 1, 'after').rows, [['a', 'b', ''], ['c', 'd', '']]);
    assert.deepEqual(tables.deleteCol(T(), 0).rows, [['b'], ['d']]);
    assert.equal(tables.deleteCol({ type: 'table', rows: [['x'], ['y']] }, 0), null);
  });

  test('filas desiguales se igualan al operar', () => {
    const t = { type: 'table', rows: [['a', 'b', 'c'], ['d']] };
    assert.deepEqual(tables.addRow(t, 1).rows[2], ['', '', '']);
    assert.deepEqual(tables.deleteCol(t, 2).rows, [['a', 'b'], ['d', '']]);
  });

  test('setHeader y setCell', () => {
    assert.equal(tables.setHeader(T(), false).header, false);
    assert.equal(tables.setHeader(T(), true).header, true);
    assert.equal(tables.setCell(T(), 1, 1, 'X').rows[1][1], 'X');
    assert.equal(tables.setCell(T(), 5, 0, 'X'), null);
  });

  test('limites de filas y columnas', () => {
    const big = tables.create(tables.MAX_ROWS, tables.MAX_COLS);
    assert.equal(tables.addRow(big, 0), null);
    assert.equal(tables.addCol(big, 0), null);
  });
});

describe('core/tables: imagenes', () => {
  const img = { type: 'image', src: PNG, width: 400, height: 200 };
  test('resize por ancho conserva la proporcion', () => {
    const r = tables.resizeImage(img, { width: 200 });
    assert.deepEqual([r.width, r.height], [200, 100]);
  });
  test('resize por alto conserva la proporcion', () => {
    const r = tables.resizeImage(img, { height: 50 });
    assert.deepEqual([r.width, r.height], [100, 50]);
  });
  test('limites minimo y maximo', () => {
    assert.equal(tables.resizeImage(img, { width: 1 }).width, tables.MIN_IMG);
    assert.equal(tables.resizeImage(img, { width: 99999 }).width, tables.MAX_IMG);
  });
  test('sin tamano o con NaN devuelve null', () => {
    assert.equal(tables.resizeImage(img, {}), null);
    assert.equal(tables.resizeImage(img, { width: 'x' }), null);
    assert.equal(tables.resizeImage({ type: 'paragraph' }, { width: 10 }), null);
  });
  test('fitWidth reduce lo grande y respeta lo chico', () => {
    assert.deepEqual(tables.fitWidth({ width: 2000, height: 1000 }, 500), { width: 500, height: 250 });
    assert.deepEqual(tables.fitWidth({ width: 100, height: 80 }, 500), { width: 100, height: 80 });
  });
  test('setAlt', () => {
    assert.equal(tables.setAlt(img, 'gato').alt, 'gato');
    assert.equal(tables.setAlt({ ...img, alt: 'x' }, '').alt, undefined);
  });
});

describe('parches de la IA: table e image', () => {
  const doc = () => model.createDoc({ blocks: [
    { id: 't1', type: 'table', header: true, rows: [['Nombre', 'Edad'], ['Ana', '30']] },
    { id: 'i1', type: 'image', src: PNG, alt: '', width: 400, height: 200 },
    { id: 'p1', type: 'paragraph', text: 'hola' }
  ] });
  const run = (d, ops) => patch.applyPatch(d, { expectedHash: d.hash, ops });

  test('addRow + setCell en un solo parche', () => {
    const d = doc();
    const r = run(d, [
      { op: 'table', id: 't1', action: 'addRow', index: 1 },
      { op: 'table', id: 't1', action: 'setCell', row: 2, col: 0, text: 'Luis' }
    ]);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.doc.blocks[0].rows, [['Nombre', 'Edad'], ['Ana', '30'], ['Luis', '']]);
  });
  test('addCol, deleteCol, deleteRow, setHeader', () => {
    const d = doc();
    const r = run(d, [
      { op: 'table', id: 't1', action: 'addCol', index: 1 },
      { op: 'table', id: 't1', action: 'deleteRow', index: 1 },
      { op: 'table', id: 't1', action: 'setHeader', value: false }
    ]);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.doc.blocks[0].rows, [['Nombre', 'Edad', '']]);
    assert.equal(r.doc.blocks[0].header, false);
  });
  test('errores claros: bloque que no es tabla, accion rara, fuera de rango', () => {
    const d = doc();
    assert.equal(run(d, [{ op: 'table', id: 'p1', action: 'addRow' }]).ok, false);
    assert.equal(run(d, [{ op: 'table', id: 't1', action: 'volar' }]).errors[0].code, 'INVALID');
    assert.equal(run(d, [{ op: 'table', id: 't1', action: 'setCell', row: 9, col: 0, text: 'x' }]).ok, false);
    assert.equal(run(d, [{ op: 'table', id: 'nope', action: 'addRow' }]).errors[0].code, 'NOT_FOUND');
  });
  test('un parche con un error se descarta entero', () => {
    const d = doc();
    const r = run(d, [{ op: 'table', id: 't1', action: 'addRow' }, { op: 'table', id: 't1', action: 'volar' }]);
    assert.equal(r.ok, false);
    assert.equal(d.blocks[0].rows.length, 2);
  });
  test('image: ancho proporcional y alt', () => {
    const r = run(doc(), [{ op: 'image', id: 'i1', width: 200, alt: 'logo' }]);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const b = r.doc.blocks[1];
    assert.deepEqual([b.width, b.height, b.alt], [200, 100, 'logo']);
  });
  test('image: errores', () => {
    const d = doc();
    assert.equal(run(d, [{ op: 'image', id: 'p1', width: 100 }]).ok, false);
    assert.equal(run(d, [{ op: 'image', id: 'i1' }]).ok, false);
  });
  test('la SPEC documenta las dos operaciones nuevas', () => {
    const spec = Array.isArray(patch.SPEC) ? patch.SPEC.join('\n') : String(patch.SPEC);
    assert.match(spec, /"op":"table"/);
    assert.match(spec, /"op":"image"/);
  });
});

describe('html: tamano de imagen (bug previo)', () => {
  test('el ancho y alto salen dentro de style=""', () => {
    const out = html.blockToHtml({ id: 'i', type: 'image', src: PNG, width: 120, height: 60 });
    assert.match(out, /style="width:120px;height:60px"/);
  });
});
