'use strict';
/** Hito 3: pagina (papel, orientacion, margenes, encabezado/pie), interlineado y enlaces. */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const D = '../modules/document-editor/core/';
const model = require(D + 'model');
const patch = require(D + 'patch');
const pg = require(D + 'pagesetup');
const docxWrite = require(D + 'docx-write');
const docxRead = require(D + 'docx-read');
const zip = require(D + 'zip');
const xml = require(D + 'xml');
const html = require(D + 'html');

const A4 = { width: 595, height: 842, margin: 57 };

describe('core/pagesetup', () => {
  test('orientacion y papel', () => {
    const l = pg.setOrientation(A4, 'landscape');
    assert.deepEqual([l.width, l.height], [842, 595]);
    assert.equal(pg.orientationOf(l), 'landscape');
    assert.deepEqual([pg.setOrientation(l, 'portrait').width, pg.setOrientation(l, 'portrait').height], [595, 842]);
    assert.equal(pg.setOrientation(A4, 'diagonal'), null);
    const letter = pg.setPaper(l, 'letter');
    assert.deepEqual([letter.width, letter.height], [792, 612], 'conserva la orientacion');
    assert.equal(pg.paperOf(letter), 'LETTER');
    assert.equal(pg.setPaper(A4, 'A0'), null);
  });
  test('margenes: presets, por lado y limites', () => {
    assert.equal(pg.setMargins(A4, 'narrow').margin, 36);
    assert.equal(pg.setMargins(A4, 'secreto'), null);
    const m = pg.setMargins(A4, { top: 20, left: 100 });
    assert.equal(m.marginTop, 20); assert.equal(m.marginLeft, 100); assert.equal(m.margin, 57);
    assert.equal(pg.setMargins(A4, { all: 30 }).marginTop, undefined, 'all limpia los lados');
    assert.equal(pg.setMargins(A4, { all: 290 }), null, 'sin area util');
    assert.equal(pg.setMargins(A4, { top: 'x' }), null);
  });
  test('encabezado, pie y numeracion', () => {
    const p = pg.setHeaderFooter(A4, { header: 'H', footer: 'F', pageNumbers: 'center' });
    assert.deepEqual([p.header, p.footer, p.pageNumbers], ['H', 'F', 'center']);
    const q = pg.setHeaderFooter(p, { header: '', pageNumbers: 'none' });
    assert.equal(q.header, undefined); assert.equal(q.pageNumbers, undefined); assert.equal(q.footer, 'F');
    assert.equal(pg.setHeaderFooter(A4, { pageNumbers: 'arriba' }), null);
  });
});

describe('parche op page + estilo de bloque/enlace', () => {
  const doc = () => model.createDoc({ page: A4, blocks: [{ id: 'p1', type: 'paragraph', text: 'visita el sitio hoy' }] });
  const run = (d, ops) => patch.applyPatch(d, { expectedHash: d.hash, ops });

  test('page: horizontal + margen estrecho + pie con numeros', () => {
    const r = run(doc(), [{ op: 'page', orientation: 'landscape', margin: 'narrow', footer: 'MC', pageNumbers: 'right' }]);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual([r.doc.page.width, r.doc.page.height, r.doc.page.margin, r.doc.page.footer, r.doc.page.pageNumbers], [842, 595, 36, 'MC', 'right']);
  });
  test('page: quitar encabezado y numeros', () => {
    const d = run(doc(), [{ op: 'page', header: 'X', pageNumbers: 'left' }]).doc;
    const r = run(d, [{ op: 'page', header: '', pageNumbers: 'none' }]);
    assert.equal(r.doc.page.header, undefined); assert.equal(r.doc.page.pageNumbers, undefined);
  });
  test('page: errores', () => {
    assert.equal(run(doc(), [{ op: 'page' }]).ok, false);
    assert.equal(run(doc(), [{ op: 'page', margin: 9999 }]).ok, false);
    assert.equal(run(doc(), [{ op: 'page', paper: 'A0' }]).ok, false);
  });
  test('style: interlineado e indentado del bloque', () => {
    const r = run(doc(), [{ op: 'style', find: 'visita', lineHeight: 1.5, indent: 2 }]);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.doc.blocks[0].lineHeight, 1.5); assert.equal(r.doc.blocks[0].indent, 2);
  });
  test('style: enlace sobre un fragmento, y se puede quitar', () => {
    const r = run(doc(), [{ op: 'style', find: 'sitio', link: 'https://mc.example' }]);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.doc.blocks[0].runs.map(x => [x.text, x.link]), [['visita el ', undefined], ['sitio', 'https://mc.example'], [' hoy', undefined]]);
    const q = run(r.doc, [{ op: 'style', find: 'sitio', link: false }]);
    assert.equal(q.ok, true);
    assert.ok(!(q.doc.blocks[0].runs || []).some(x => x.link));
  });
  test('style: enlaces peligrosos se rechazan', () => {
    const r = run(doc(), [{ op: 'style', find: 'sitio', link: 'javascript:alert(1)' }]);
    assert.equal(r.ok, false);
  });
  test('SPEC documenta page', () => assert.match(patch.SPEC, /"op":"page"/));
});

describe('DOCX: ida y vuelta de pagina, interlineado y enlaces', () => {
  const sample = () => model.createDoc({
    page: { width: 842, height: 595, margin: 40, marginLeft: 90, header: 'Mi encabezado', footer: 'Pie de pagina', pageNumbers: 'right' },
    blocks: [
      { type: 'paragraph', lineHeight: 1.5, indent: 1, runs: [{ text: 'ver ' }, { text: 'sitio', link: 'https://mc.example/a?b=1&c=2' }, { text: ' fin' }] },
      { type: 'heading', level: 1, text: 'Titulo', lineHeight: 2 }
    ]
  });

  test('las partes XML son validas y estan las de encabezado/pie', () => {
    const { parts } = docxWrite.docToDocxParts(sample(), {});
    for (const p of parts) if (typeof p.data === 'string') xml.parse(p.data);
    const names = parts.map(p => p.name);
    assert.ok(names.includes('word/header1.xml') && names.includes('word/footer1.xml'));
    const docXml = parts.find(p => p.name === 'word/document.xml').data;
    assert.match(docXml, /w:orient="landscape"/);
    assert.match(docXml, /w:left="1800"/);
    assert.match(docXml, /<w:hyperlink r:id="rIdLink1"/);
    assert.match(docXml, /w:line="360" w:lineRule="auto"/);
    assert.match(parts.find(p => p.name === 'word/_rels/document.xml.rels').data, /TargetMode="External"/);
    assert.match(parts.find(p => p.name === 'word/footer1.xml').data, /PAGE/);
  });

  test('sin encabezado ni pie no se generan partes extra', () => {
    const { parts } = docxWrite.docToDocxParts(model.createDoc({ blocks: [{ type: 'paragraph', text: 'x' }] }), {});
    assert.ok(!parts.some(p => /header1|footer1/.test(p.name)));
  });

  test('se reabre igual', async () => {
    const { parts } = docxWrite.docToDocxParts(sample(), {});
    const { doc } = await docxRead.docxBytesToDoc(await zip.writeZip(parts), {});
    assert.deepEqual([doc.page.width, doc.page.height, doc.page.margin, doc.page.marginLeft], [842, 595, 40, 90]);
    assert.equal(doc.page.header, 'Mi encabezado');
    assert.equal(doc.page.footer, 'Pie de pagina');
    assert.equal(doc.page.pageNumbers, 'right');
    const [p, h] = doc.blocks;
    assert.equal(p.lineHeight, 1.5); assert.equal(p.indent, 1);
    const link = p.runs.find(r => r.link);
    assert.equal(link.text, 'sitio'); assert.equal(link.link, 'https://mc.example/a?b=1&c=2');
    assert.equal(link.color, undefined, 'el azul del enlace no se guarda como color');
    assert.equal(h.lineHeight, 2);
  });
});

describe('html/PDF: pagina', () => {
  test('@page usa tamano y margenes por lado', () => {
    const css = html.stylesheet(model.createDoc({ page: { width: 842, height: 595, margin: 40, marginLeft: 90 } }));
    assert.match(css, /size: 842pt 595pt/);
    assert.match(css, /margin: 40pt 40pt 40pt 90pt/);
  });
});

describe('html/PDF: encabezado y pie', () => {
  test('sin nada configurado no se piden', () => {
    assert.equal(html.pdfHeaderFooter(model.createDoc({ blocks: [{ type: 'paragraph', text: 'x' }] })).displayHeaderFooter, false);
  });
  test('texto escapado y numero de pagina', () => {
    const r = html.pdfHeaderFooter(model.createDoc({ page: { header: '<b>H</b>', footer: 'Pie', pageNumbers: 'center' }, blocks: [{ type: 'paragraph', text: 'x' }] }));
    assert.equal(r.displayHeaderFooter, true);
    assert.ok(!r.headerTemplate.includes('<b>'));
    assert.match(r.footerTemplate, /class="pageNumber"/);
    assert.match(r.footerTemplate, /Pie/);
    assert.match(r.footerTemplate, /text-align:center/);
  });
});

describe('dom-runs: enlaces', () => {
  test('un <a> seguro se lee como link y uno peligroso se ignora', () => {
    let JSDOM; try { ({ JSDOM } = require('jsdom')); } catch { return; }
    const domRuns = require(D + 'dom-runs');
    const root = new JSDOM('<p>ver <a href="https://x.io/a">aqui</a> y <a href="javascript:alert(1)">mal</a></p>').window.document.querySelector('p');
    const runs = domRuns.read(root);
    assert.equal(runs.find(r => r.text === 'aqui').link, 'https://x.io/a');
    assert.ok(!runs.some(r => /mal/.test(r.text) && r.link), 'el enlace peligroso no se conserva');
  });
});
