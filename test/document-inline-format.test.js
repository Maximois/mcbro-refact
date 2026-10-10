'use strict';

/**
 * Formato en linea del editor de documentos (hito 1).
 *
 * Cubre el nucleo puro: algebra de tramos (core/runs.js), normalizacion del
 * modelo, render HTML, ida y vuelta por DOCX, parches de la IA y el lector del
 * DOM (core/dom-runs.js). El lector necesita un DOM: se prueba con jsdom si
 * esta instalado y se omite si no (no es dependencia del proyecto).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const model = require('../modules/document-editor/core/model');
const runs = require('../modules/document-editor/core/runs');
const patch = require('../modules/document-editor/core/patch');
const html = require('../modules/document-editor/core/html');
const zip = require('../modules/document-editor/core/zip');
const docxWrite = require('../modules/document-editor/core/docx-write');
const docxRead = require('../modules/document-editor/core/docx-read');
const domRuns = require('../modules/document-editor/core/dom-runs');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch { /* sin jsdom: se omiten los tests del DOM */ }
const withDom = JSDOM ? test : test.skip;

const T = (list) => list.map((r) => r.text).join('');

describe('runs: algebra de tramos', () => {
  test('applyStyle parte, aplica y vuelve a fusionar', () => {
    const base = [{ text: 'Hola mundo cruel' }];
    const out = runs.applyStyle(base, 5, 10, { bold: true });
    assert.deepEqual(out.map((r) => r.text), ['Hola ', 'mundo', ' cruel']);
    assert.equal(out[1].bold, true);
    assert.equal(out[0].bold, undefined);
    // Aplicar lo mismo en la zona vecina fusiona los tramos.
    const merged = runs.applyStyle(out, 0, 5, { bold: true });
    assert.deepEqual(merged.map((r) => r.text), ['Hola mundo', ' cruel']);
  });

  test('applyStyle conserva el formato previo de lo que no toca', () => {
    const base = [{ text: 'uno ', italic: true }, { text: 'dos tres', color: '#ff0000' }];
    const out = runs.applyStyle(base, 2, 7, { bold: true });
    assert.equal(T(out), 'uno dos tres');
    assert.deepEqual(out[0], { text: 'un', italic: true });
    assert.deepEqual(out[1], { text: 'o ', italic: true, bold: true });
    assert.deepEqual(out[2], { text: 'dos', color: '#ff0000', bold: true });
    assert.deepEqual(out[3], { text: ' tres', color: '#ff0000' });
  });

  test('null quita la propiedad; fuera de rango no hace nada', () => {
    const base = [{ text: 'abc', color: '#112233', size: 14 }];
    const out = runs.applyStyle(base, 0, 3, { color: null });
    assert.deepEqual(out, [{ text: 'abc', size: 14 }]);
    assert.deepEqual(runs.applyStyle(base, 5, 9, { bold: true }), base);
  });

  test('toggle: si todo el rango la tiene se quita, si no se pone', () => {
    let r = [{ text: 'abcdef' }];
    r = runs.toggle(r, 0, 3, 'bold');
    assert.equal(runs.styleOf(r, 0, 3).bold, true);
    assert.equal(runs.styleOf(r, 0, 6).bold, 'mixed');
    r = runs.toggle(r, 0, 6, 'bold');            // mixto -> todo en negrita
    assert.equal(runs.styleOf(r, 0, 6).bold, true);
    r = runs.toggle(r, 0, 6, 'bold');            // todo -> ninguno (falso explicito)
    assert.equal(runs.styleOf(r, 0, 6).bold, false);
  });

  test('split y concat son inversos', () => {
    const r = [{ text: 'ab', bold: true }, { text: 'cd' }];
    const [left, right] = runs.split(r, 3);
    assert.deepEqual(left, [{ text: 'ab', bold: true }, { text: 'c' }]);
    assert.deepEqual(right, [{ text: 'd' }]);
    assert.deepEqual(runs.concat(left, right), r);
    assert.deepEqual(runs.split(r, 0)[0], []);
    assert.deepEqual(runs.split(r, 99)[1], []);
  });

  test('compact descarta los falsos que el bloque no necesita', () => {
    const r = [{ text: 'a', bold: false }, { text: 'b', italic: true }];
    assert.deepEqual(runs.compact(r, { bold: false }), [{ text: 'a' }, { text: 'b', italic: true }]);
    assert.deepEqual(runs.compact(r, { bold: true })[0], { text: 'a', bold: false });
  });

  test('hasFormatting y equal', () => {
    assert.equal(runs.hasFormatting([{ text: 'x' }]), false);
    assert.equal(runs.hasFormatting([{ text: 'x', size: 12 }]), true);
    assert.equal(runs.equal([{ text: 'a' }, { text: 'b' }], [{ text: 'ab' }]), true);
    assert.equal(runs.equal([{ text: 'a', bold: true }], [{ text: 'a' }]), false);
  });
});

describe('modelo: tramos con formato', () => {
  test('normalizeRun acepta las propiedades nuevas y rechaza lo peligroso', () => {
    const r = model.normalizeRun({ text: 'x', strike: true, highlight: '#ffff00', font: 'Times New Roman', size: 14, color: '#abc' });
    assert.deepEqual(r, { text: 'x', strike: true, color: '#abc', highlight: '#ffff00', font: 'Times New Roman', size: 14 });
    assert.equal(model.normalizeRun({ text: 'x', font: "a'; background:url(x)" }).font, undefined);
    assert.equal(model.normalizeRun({ text: 'x', highlight: 'red; x' }).highlight, undefined);
    assert.equal(model.normalizeRun({ text: 'x', bold: false }).bold, false);
  });

  test('en un parrafo normal el falso explicito sobra; en un titulo no', () => {
    const para = model.normalizeBlock({ type: 'paragraph', runs: [{ text: 'a', bold: false }, { text: 'b', bold: false }] });
    assert.deepEqual(para.runs, [{ text: 'ab' }]);
    const head = model.normalizeBlock({ type: 'heading', level: 1, runs: [{ text: 'a', bold: false }, { text: 'b' }] });
    assert.deepEqual(head.runs, [{ text: 'a', bold: false }, { text: 'b' }]);
    const boldBlock = model.normalizeBlock({ type: 'paragraph', bold: true, runs: [{ text: 'a', bold: false }, { text: 'b' }] });
    assert.equal(boldBlock.runs[0].bold, false);
  });
});

describe('html: render de tramos', () => {
  test('cada propiedad sale como marcado y estilo', () => {
    const out = html.runsToHtml({ type: 'paragraph', runs: [
      { text: 'a', bold: true, italic: true, underline: true, strike: true },
      { text: 'b', color: '#ff0000', highlight: '#ffff00', font: 'Arial', size: 14 }
    ] });
    assert.match(out, /<s><u><em><strong>a<\/strong><\/em><\/u><\/s>/);
    assert.match(out, /color:#ff0000/);
    assert.match(out, /background-color:#ffff00/);
    assert.match(out, /font-family:&#39;Arial&#39;/);
    assert.match(out, /font-size:14pt/);
  });

  test('un falso explicito quita lo heredado del bloque', () => {
    const out = html.runsToHtml({ type: 'heading', level: 1, runs: [{ text: 'a', bold: false }] });
    assert.match(out, /font-weight:400/);
  });
});

describe('DOCX: ida y vuelta del formato en linea', () => {
  test('tachado, resaltado, fuente, color, tamano y falsos sobreviven', async () => {
    const doc = model.createDoc({ blocks: [
      { type: 'paragraph', runs: [
        { text: 'normal ' },
        { text: 'tachado', strike: true },
        { text: ' ' },
        { text: 'resaltado', highlight: '#ffff00' },
        { text: ' ' },
        { text: 'fuente', font: 'Georgia', size: 16, color: '#336699' }
      ] },
      { type: 'heading', level: 1, runs: [{ text: 'Titulo ' }, { text: 'sin negrita', bold: false }] }
    ] });
    const { parts } = docxWrite.docToDocxParts(doc, { warnings: [] });
    const { doc: back } = await docxRead.docxBytesToDoc(await zip.writeZip(parts), {});
    const para = back.blocks.find((b) => b.type === 'paragraph');
    const find = (t) => para.runs.find((r) => r.text.includes(t));
    assert.equal(find('tachado').strike, true);
    assert.equal(find('resaltado').highlight.toLowerCase(), '#ffff00');
    const f = find('fuente');
    assert.equal(f.font, 'Georgia');
    assert.equal(f.size, 16);
    assert.equal(f.color.toLowerCase(), '#336699');
    assert.equal(find('normal').strike, undefined);
  });

  test('el XML sigue el orden del esquema (rFonts, b, i, strike, color, sz, u, shd)', () => {
    const { parts } = docxWrite.docToDocxParts(model.createDoc({ blocks: [
      { type: 'paragraph', runs: [{ text: 'x', font: 'Georgia', bold: true, italic: true, strike: true, color: '#112233', size: 12, underline: true, highlight: '#ffff00' }] }
    ] }), { warnings: [] });
    const entry = parts.find((p) => /word\/document\.xml$/.test(p.name || p.path || ''));
    const xml = Buffer.from(entry.data || entry.content).toString('utf8');
    const order = ['<w:rFonts', '<w:b/>', '<w:i/>', '<w:strike/>', '<w:color', '<w:sz ', '<w:u ', '<w:shd'];
    const at = order.map((tag) => xml.indexOf(tag));
    assert.ok(at.every((n) => n >= 0), 'faltan etiquetas: ' + JSON.stringify(at));
    assert.deepEqual(at.slice().sort((a, b) => a - b), at, 'orden del esquema');
  });
});

describe('parches de la IA: style sobre tramos', () => {
  const sample = () => model.createDoc({ blocks: [
    { id: 'p1', type: 'paragraph', runs: [{ text: 'Antes ' }, { text: 'IMPORTANTE', bold: true }, { text: ' despues del contrato' }] }
  ] });

  test('aplicar color no aplana la negrita que ya existia', () => {
    const res = patch.applyPatch(sample(), { ops: [{ op: 'style', find: 'contrato', color: '#ff0000' }] });
    const r = res.doc.blocks[0].runs;
    assert.equal(r.find((x) => x.text === 'IMPORTANTE').bold, true);
    assert.equal(r.find((x) => x.text === 'contrato').color, '#ff0000');
  });

  test('bold:false quita la negrita de una parte', () => {
    const res = patch.applyPatch(sample(), { ops: [{ op: 'style', find: 'PORTANTE', bold: false }] });
    const r = res.doc.blocks[0].runs;
    assert.equal(r.find((x) => x.text === 'IM').bold, true);
    assert.equal(r.find((x) => x.text.includes('PORTANTE')).bold, undefined);
  });

  test('tachado, resaltado y fuente', () => {
    const res = patch.applyPatch(sample(), { ops: [
      { op: 'style', find: 'Antes', strike: true },
      { op: 'style', find: 'despues', highlight: '#ffff00', font: 'Arial' }
    ] });
    const r = res.doc.blocks[0].runs;
    assert.equal(r.find((x) => x.text === 'Antes').strike, true);
    const d = r.find((x) => x.text === 'despues');
    assert.equal(d.highlight, '#ffff00');
    assert.equal(d.font, 'Arial');
  });
});

describe('dom-runs: lector del DOM', () => {
  const dom = (markup) => {
    const w = new JSDOM(`<div id="ce">${markup}</div>`).window;
    return { w, ce: w.document.getElementById('ce') };
  };

  withDom('ida y vuelta: runs -> html -> DOM -> runs', () => {
    const cases = [
      [{ text: 'plano' }],
      [{ text: 'a', bold: true }, { text: 'b' }, { text: 'c', italic: true, underline: true }],
      [{ text: 'x', strike: true }, { text: 'y', color: '#ff0000', size: 14 }],
      [{ text: 'z', highlight: '#ffff00', font: 'Times New Roman' }],
      [{ text: 'l1\nl2', bold: true }],
      [{ text: 'sin', bold: false }, { text: 'ital', italic: false }, { text: 'sub', underline: false }]
    ];
    for (const c of cases) {
      const { ce } = dom(html.runsToHtml({ type: 'paragraph', runs: c }));
      assert.deepEqual(domRuns.read(ce), runs.normalize(c), JSON.stringify(c));
    }
  });

  withDom('lee lo que genera execCommand (estilos CSS en linea, rgb, font)', () => {
    const { ce } = dom(
      'a<span style="font-weight: bold; color: rgb(255, 0, 0);">b</span>' +
      '<span style="background-color: rgb(255, 255, 0); font-family: &quot;Courier New&quot;;">c</span>' +
      '<span style="font-size: 18pt; text-decoration: line-through underline;">d</span>' +
      '<font color="#00ff00" face="Arial" size="5">e</font>'
    );
    assert.deepEqual(domRuns.read(ce), [
      { text: 'a' },
      { text: 'b', bold: true, color: '#ff0000' },
      { text: 'c', highlight: '#ffff00', font: 'Courier New' },
      { text: 'd', underline: true, strike: true, size: 18 },
      { text: 'e', color: '#00ff00', font: 'Arial', size: 18 }
    ]);
  });

  withDom('nbsp es espacio, br es salto y el fondo transparente se ignora', () => {
    const { ce } = dom('a&nbsp;b<br>c<span style="background-color: rgba(0, 0, 0, 0)">d</span>');
    assert.deepEqual(domRuns.read(ce), [{ text: 'a b\ncd' }]);
  });

  withDom('el formato anidado se acumula', () => {
    const { ce } = dom('<b>uno <i>dos</i></b> tres');
    assert.deepEqual(domRuns.read(ce), [
      { text: 'uno ', bold: true },
      { text: 'dos', bold: true, italic: true },
      { text: ' tres' }
    ]);
  });

  withDom('partir por el cursor conserva el formato de las dos mitades', () => {
    const { w, ce } = dom('<strong>Hola mundo</strong> y <em>fin</em>');
    const text = ce.querySelector('strong').firstChild;
    const left = w.document.createRange();
    left.setStart(ce, 0); left.setEnd(text, 5);
    const right = w.document.createRange();
    right.setStart(text, 5); right.setEnd(ce, ce.childNodes.length);
    assert.deepEqual(domRuns.read(left.cloneContents()), [{ text: 'Hola ', bold: true }]);
    assert.deepEqual(domRuns.read(right.cloneContents()), [
      { text: 'mundo', bold: true }, { text: ' y ' }, { text: 'fin', italic: true }
    ]);
  });

  withDom('un texto hostil no genera propiedades', () => {
    const { ce } = dom('<span style="color: url(javascript:x); font-size: 9999em">x</span><script>alert(1)</script>');
    assert.deepEqual(domRuns.read(ce), [{ text: 'x' }]);
  });
});
