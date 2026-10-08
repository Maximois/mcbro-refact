'use strict';

/**
 * Renderer del editor de documentos, ejecutado de verdad en un DOM simulado.
 *
 * Carga modules/document-editor/renderer.js tal cual en jsdom, con un `mc`
 * falso que responde como el main (usa core/patch.js para aplicar los parches).
 * Cubre el camino completo: seleccion -> boton -> formato -> commit -> modelo
 * -> repintado, y las teclas Enter y Backspace con formato mixto.
 *
 * Limite honesto: jsdom no trae document.execCommand, asi que aca se simula
 * (negrita = envolver la seleccion en un span, como hace Chromium con
 * styleWithCSS). Lo que se prueba es NUESTRO codigo; que Chromium haga lo
 * mismo se comprueba a mano en la app (tools/doc-editor-tab-smoke.js).
 * Se omite si jsdom no esta instalado.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const model = require('../modules/document-editor/core/model');
const patch = require('../modules/document-editor/core/patch');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch { /* sin jsdom */ }
const withDom = JSDOM ? test : test.skip;

const CORE = path.join(__dirname, '..', 'modules', 'document-editor');
const read = (...p) => fs.readFileSync(path.join(CORE, ...p), 'utf8');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function boot(blocks) {
  const dom = new JSDOM(
    '<!doctype html><body><div id="topnav"></div><div id="panel-doc" class="active"><div id="doc-host"></div></div></body>',
    { runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const w = dom.window;

  // Estado del "main": un documento y el mismo aplicador de parches que usa el main real.
  const server = { doc: model.createDoc({ blocks }), edits: [] };
  const snapshot = () => ({
    open: true, doc: server.doc, sourcePath: '', sourceName: '', format: 'docx', dirty: true,
    pages: [], pageCount: 0, warnings: [], savedFormat: 'docx',
    history: { canUndo: false, canRedo: false },
    capabilities: { canSaveInPlace: false, isPdfSource: false, hasBytes: false }
  });
  w.mc = {
    on() {},
    docState: async () => snapshot(),
    docEdit: async (req) => {
      server.edits.push(req.ops);
      const res = patch.applyPatch(server.doc, { expectedHash: req.expectedHash, ops: req.ops });
      if (!res.ok) return { ok: false, error: (res.errors && res.errors[0] && res.errors[0].message) || 'patch' };
      server.doc = res.doc;
      return Object.assign({ ok: true }, snapshot());
    }
  };

  // execCommand simulado: negrita/color sobre la seleccion como span con estilo CSS.
  w.document.execCommand = (cmd, _ui, val) => {
    const sel = w.getSelection();
    if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    const styles = { bold: 'font-weight: bold', foreColor: `color: ${val}`, hiliteColor: `background-color: ${val}`, fontName: `font-family: ${val}` };
    if (!styles[cmd]) return cmd === 'styleWithCSS';
    if (range.collapsed) return true;
    const span = w.document.createElement('span');
    span.setAttribute('style', styles[cmd] + ';');
    span.appendChild(range.extractContents());
    range.insertNode(span);
    sel.removeAllRanges();
    const r = w.document.createRange();
    r.selectNodeContents(span);
    sel.addRange(r);
    return true;
  };
  w.document.queryCommandState = () => false;
  w.document.queryCommandValue = () => '';

  w.eval('var state = { tabs: [{ id: 1, url: "mc://doc", title: "Documento" }], activeTab: 1 };');
  for (const f of ['model.js', 'html.js', 'runs.js', 'dom-runs.js']) w.eval(read('core', f));
  w.eval(read('renderer.js'));
  await tick();
  await w.DocEditor.open();
  await tick();
  return { w, server };
}

const surfaces = (w) => Array.from(w.document.querySelectorAll('#doc-host .doc-b .doc-ce'));

function select(w, ce, from, to) {
  // Selecciona [from, to) en caracteres del texto de la superficie.
  const walker = w.document.createTreeWalker(ce, 4 /* NodeFilter.SHOW_TEXT */);
  let at = 0;
  let startNode; let startOff; let endNode; let endOff;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.nodeValue.length;
    if (startNode === undefined && from <= at + len) { startNode = n; startOff = from - at; }
    if (endNode === undefined && to <= at + len) { endNode = n; endOff = to - at; }
    at += len;
  }
  const r = w.document.createRange();
  r.setStart(startNode, startOff);
  r.setEnd(endNode, endOff);
  const sel = w.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  ce.focus();
  w.getSelection().removeAllRanges();
  w.getSelection().addRange(r);
}

const key = async (w, target, k) => {
  const ev = new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  await tick(60);
  return ev;
};

describe('renderer: formato en linea de punta a punta', () => {
  withDom('negrita sobre la seleccion: un parrafo normal se parte en tramos', async () => {
    const { w, server } = await boot([{ id: 'p1', type: 'paragraph', text: 'Hola mundo cruel' }]);
    select(w, surfaces(w)[0], 5, 10);
    w.document.querySelector('[data-block-toggle="bold"]').click();
    await tick(60);
    assert.deepEqual(server.doc.blocks[0].runs, [
      { text: 'Hola ' }, { text: 'mundo', bold: true }, { text: ' cruel' }
    ]);
    assert.equal(server.doc.blocks[0].text, undefined);
  });

  withDom('escribir en un parrafo con formato mixto YA NO borra el formato', async () => {
    const { w, server } = await boot([{ id: 'p1', type: 'paragraph', runs: [{ text: 'Hola ' }, { text: 'mundo', bold: true }, { text: ' cruel' }] }]);
    const ce = surfaces(w)[0];
    // El usuario escribe "!!" al final: cambia el largo del texto.
    ce.lastChild.nodeValue += '!!';
    ce.dispatchEvent(new w.Event('input', { bubbles: true }));
    ce.dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
    await tick(80);
    const runs = server.doc.blocks[0].runs;
    assert.ok(runs, 'el parrafo conserva sus tramos');
    assert.equal(runs.map((r) => r.text).join(''), 'Hola mundo cruel!!');
    assert.equal(runs.find((r) => r.text === 'mundo').bold, true);
  });

  withDom('color de texto desde la barra', async () => {
    const { w, server } = await boot([{ id: 'p1', type: 'paragraph', text: 'rojo azul' }]);
    select(w, surfaces(w)[0], 0, 4);
    const input = w.document.querySelector('#doc-color');
    input.disabled = false;
    input.value = '#ff0000';
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    await tick(60);
    assert.deepEqual(server.doc.blocks[0].runs, [{ text: 'rojo', color: '#ff0000' }, { text: ' azul' }]);
  });

  withDom('Enter parte el parrafo conservando el formato de cada mitad', async () => {
    const { w, server } = await boot([{ id: 'p1', type: 'paragraph', runs: [{ text: 'Hola ' }, { text: 'mundo', bold: true }, { text: ' cruel' }] }]);
    select(w, surfaces(w)[0], 7, 7);   // "Hola mu|ndo cruel"
    const ev = await key(w, surfaces(w)[0], 'Enter');
    assert.equal(ev.defaultPrevented, true);
    const [a, b] = server.doc.blocks;
    assert.deepEqual(a.runs, [{ text: 'Hola ' }, { text: 'mu', bold: true }]);
    assert.deepEqual(b.runs, [{ text: 'ndo', bold: true }, { text: ' cruel' }]);
  });

  withDom('Backspace al inicio une con el anterior sin perder formato', async () => {
    const { w, server } = await boot([
      { id: 'a', type: 'paragraph', runs: [{ text: 'Hola ' }, { text: 'mun', bold: true }] },
      { id: 'b', type: 'paragraph', runs: [{ text: 'do', bold: true }, { text: ' cruel' }] }
    ]);
    select(w, surfaces(w)[1], 0, 0);
    const ev = await key(w, surfaces(w)[1], 'Backspace');
    assert.equal(ev.defaultPrevented, true);
    assert.equal(server.doc.blocks.length, 1);
    assert.deepEqual(server.doc.blocks[0].runs, [
      { text: 'Hola ' }, { text: 'mundo', bold: true }, { text: ' cruel' }
    ]);
  });

  withDom('Backspace al inicio con el anterior vacio descarta el vacio y conserva el tipo', async () => {
    const { w, server } = await boot([
      { id: 'a', type: 'paragraph', text: '' },
      { id: 'b', type: 'heading', level: 1, text: 'Titulo' }
    ]);
    select(w, surfaces(w)[1], 0, 0);
    await key(w, surfaces(w)[1], 'Backspace');
    assert.equal(server.doc.blocks.length, 1);
    assert.equal(server.doc.blocks[0].type, 'heading');
  });
});
