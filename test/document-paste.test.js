'use strict';
/** Pegar con formato: HTML del portapapeles (Word, web) -> bloques del modelo. */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const paste = require('../modules/document-editor/core/paste');
const model = require('../modules/document-editor/core/model');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch { /* sin jsdom */ }
const withDom = JSDOM ? test : test.skip;
const parse = (html) => paste.blocksFromHtml(new JSDOM(`<html><body>${html}</body></html>`).window.document.body);
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('core/paste', () => {
  withDom('titulos, parrafo con formato, alineacion y enlace', () => {
    const b = parse('<h1>Titulo</h1><p style="text-align:center">Hola <b>mundo</b> <a href="https://x.io">link</a></p>');
    assert.deepEqual(b[0], { type: 'heading', level: 1, text: 'Titulo' });
    assert.equal(b[1].align, 'center');
    assert.deepEqual(b[1].runs.map((r) => [r.text, r.bold, r.link]), [['Hola ', undefined, undefined], ['mundo', true, undefined], [' ', undefined, undefined], ['link', undefined, 'https://x.io']]);
  });
  withDom('h4-h6 bajan a titulo 3 y se descarta el marcado peligroso', () => {
    const b = parse('<h5>X</h5><script>alert(1)</script><style>p{}</style><iframe src="x"></iframe><p onclick="alert(1)">ok</p>');
    assert.deepEqual(b.map((x) => [x.type, x.level, x.text]), [['heading', 3, 'X'], ['paragraph', undefined, 'ok']]);
  });
  withDom('enlaces javascript: pierden el enlace', () => {
    const b = parse('<p><a href="javascript:alert(1)">mal</a> <b>bien</b></p>');
    assert.ok(!JSON.stringify(b).includes('javascript'));
  });
  withDom('ruido de Word: Calibri 11, negro y o:p no cuentan como formato', () => {
    const b = parse('<p class=MsoNormal><span style="font-size:11.0pt;font-family:Calibri;color:black">Texto <o:p></o:p></span></p>');
    assert.deepEqual(b, [{ type: 'paragraph', text: 'Texto' }]);
  });
  withDom('listas de Word (mso-list) y listas HTML, con anidadas', () => {
    const w = parse('<p style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">·</span>uno</p><p style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">·</span>dos</p><p>fin</p>');
    assert.deepEqual(w.map((x) => x.type), ['list', 'paragraph']);
    assert.deepEqual(w[0].items, ['uno', 'dos']);
    const n = parse('<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>');
    assert.deepEqual([n[0].items, n[0].ordered], [['a', 'b', 'c'], true]);
    const o = parse('<p style="mso-list:l1 level1 lfo2"><span style="mso-list:Ignore">1.</span>primero</p>');
    assert.equal(o[0].ordered, true);
  });
  withDom('tabla, cita, codigo, separador e imagen data:', () => {
    const b = parse(`<table><tr><th>H</th><th>I</th></tr><tr><td>1</td><td>2</td></tr></table><blockquote>cita</blockquote><pre>a\n  b</pre><hr><img src="${PNG}" alt="x"><img src="http://evil/x.png">`);
    assert.deepEqual(b.map((x) => x.type), ['table', 'quote', 'code', 'hr', 'image']);
    assert.deepEqual(b[0].rows, [['H', 'I'], ['1', '2']]);
    assert.equal(b[0].header, true);
    assert.equal(b[2].text, 'a\n  b');
  });
  withDom('texto suelto e inline sin parrafo forman un parrafo; contenedores se recorren', () => {
    const b = parse('hola <b>mundo</b><div><p>uno</p><p>dos</p></div>');
    assert.deepEqual(b.map((x) => x.text || x.runs.map((r) => r.text).join('')), ['hola mundo', 'uno', 'dos']);
  });
  withDom('todo lo que sale pasa por normalizeBlock', () => {
    const b = parse('<h1>A</h1><p>B <i>c</i></p><ul><li>x</li></ul><table><tr><td>1</td></tr></table>');
    assert.ok(b.every((x) => model.normalizeBlock(x)));
  });
  withDom('isRich: texto plano simple no cuenta como pegado con formato', () => {
    assert.equal(paste.isRich(parse('<p>solo texto</p>')), false);
    assert.equal(paste.isRich(parse('<p>con <b>negrita</b></p>')), true);
    assert.equal(paste.isRich(parse('<p>a</p><p>b</p>')), true);
    assert.equal(paste.isRich([]), false);
  });
  withDom('limite de bloques', () => {
    assert.equal(parse('<p>x</p>'.repeat(800)).length, 500);
  });
});
