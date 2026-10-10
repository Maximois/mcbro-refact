'use strict';
/** Formato inline dentro de items de lista y celdas de tabla (overlays itemRuns / cellRuns). */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const D = '../modules/document-editor/core/';
const model = require(D + 'model');
const tables = require(D + 'tables');
const html = require(D + 'html');
const docxWrite = require(D + 'docx-write');
const docxRead = require(D + 'docx-read');
const zip = require(D + 'zip');

const plain = (x) => JSON.parse(JSON.stringify(x));
const mk = () => model.createDoc({ blocks: [
  { type: 'list', items: ['uno negrita', 'dos'], itemRuns: [[{ text: 'uno ', bold: true }, { text: 'negrita' }], null] },
  { type: 'table', rows: [['a b', 'c'], ['d', 'e']], cellRuns: { '0,0': [{ text: 'a ', italic: true }, { text: 'b' }], '1,1': [{ text: 'e', color: '#ff0000' }] } }
] });

describe('overlays', () => {
  test('se normalizan y se descartan si no coinciden con el texto', () => {
    const d = model.createDoc({ blocks: [{ type: 'table', rows: [['x']], cellRuns: { '0,0': [{ text: 'otro', bold: true }], '5,5': [{ text: 'x', bold: true }] } }] });
    assert.equal(d.blocks[0].cellRuns, undefined);
  });
  test('tablas: addRow/deleteRow/addCol/deleteCol desplazan cellRuns', () => {
    let t = plain(mk().blocks[1]);
    t = tables.addRow(t, 0, 'before');
    assert.ok(t.cellRuns['1,0'] && t.cellRuns['2,1']);
    t = tables.deleteRow(t, 0);
    assert.ok(t.cellRuns['0,0'] && !t.cellRuns['2,1']);
    t = tables.addCol(t, 0, 'before');
    assert.ok(t.cellRuns['0,1']);
    t = tables.deleteCol(t, 1);
    assert.equal(t.cellRuns && t.cellRuns['0,0'], undefined);
  });
  test('setCell elimina el overlay de esa celda', () => {
    const t = tables.setCell(plain(mk().blocks[1]), 0, 0, 'nuevo');
    assert.equal(t.cellRuns['0,0'], undefined);
    assert.ok(t.cellRuns['1,1']);
  });
  test('html pinta el formato', () => {
    const h = html.docToHtml ? html.docToHtml(mk()) : html.render(mk());
    assert.match(h, /<strong>uno <\/strong>|font-weight:\s*bold|<b>uno/);
    assert.match(h, /<em>a <\/em>|font-style:\s*italic|<i>a/);
  });
  test('DOCX: ida y vuelta conserva el formato', async () => {
    const { parts } = docxWrite.docToDocxParts(mk(), {});
    const { doc } = await docxRead.docxBytesToDoc(await zip.writeZip(parts), {});
    const list = doc.blocks.find(b => b.type === 'list');
    const table = doc.blocks.find(b => b.type === 'table');
    assert.equal(list.itemRuns[0][0].bold, true);
    assert.equal(list.itemRuns[1], null);
    assert.equal(table.cellRuns['0,0'][0].italic, true);
    assert.equal(table.cellRuns['1,1'][0].color.toLowerCase(), '#ff0000');
  });
});
