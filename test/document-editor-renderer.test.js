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

async function boot(blocks, page, styles) {
  const dom = new JSDOM(
    '<!doctype html><body><div id="topnav"></div><div id="panel-doc" class="active"><div id="doc-host"></div></div></body>',
    { runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const w = dom.window;

  // Estado del "main": un documento y el mismo aplicador de parches que usa el main real.
  // Igual que en main.js, las imagenes viajan livianas: `server.doc` conserva SIEMPRE
  // los bytes; el snapshot de las respuestas los omite cuando la imagen ya se envio
  // completa (lightSnapshot), salvo el hash y el doc completo que da docState.
  const server = { doc: model.createDoc({ blocks, page, styles }), edits: [], emit: (ch, p) => listeners[ch] && listeners[ch](p) };
  const listeners = {};
  const knownImgSrc = new Map();
  const light = (doc) => {
    if (!doc || !Array.isArray(doc.blocks)) return doc;
    const blocks = doc.blocks.map((b) => {
      if (b.type !== 'image' || typeof b.src !== 'string' || !b.src) return b;
      if (knownImgSrc.get(b.id) === b.src) {
        const copy = Object.assign({}, b);
        delete copy.src;
        return copy;
      }
      knownImgSrc.set(b.id, b.src);
      return b;
    });
    return blocks === doc.blocks ? doc : Object.assign({}, doc, { blocks });
  };
  const snapshot = () => ({
    open: true, doc: server.doc, sourcePath: '', sourceName: '', format: 'docx', dirty: true,
    pages: [], pageCount: 0, warnings: [], savedFormat: 'docx',
    history: { canUndo: false, canRedo: false },
    capabilities: { canSaveInPlace: false, isPdfSource: false, hasBytes: false }
  });
  const lightSnapshot = () => Object.assign({}, snapshot(), { doc: light(server.doc) });
  w.mc = {
    on(ch, fn) { listeners[ch] = fn; },
    docCtxOpen() { server.ctxOpened = (server.ctxOpened || 0) + 1; },
    docSpellAdd: async (word) => { server.added = word; return { ok: true }; },
    docState: async () => Object.assign({}, snapshot(), { doc: light(server.doc) }),
    docEdit: async (req) => {
      server.edits.push(req.ops);
      const res = patch.applyPatch(server.doc, { expectedHash: req.expectedHash, ops: req.ops });
if (!res.ok) return { ok: false, stale: !!res.stale, error: (res.errors && res.errors[0] && res.errors[0].message) || 'patch' };
      server.doc = res.doc;
      return Object.assign({ ok: true }, lightSnapshot());
    }
  };

  // execCommand simulado: negrita/color sobre la seleccion como span con estilo CSS.
  w.document.execCommand = (cmd, _ui, val) => {
    const sel = w.getSelection();
    if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (cmd === 'createLink' || cmd === 'unlink') {
      if (range.collapsed) return false;
      if (cmd === 'unlink') {
        const a = (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement).closest('a');
        if (a) a.replaceWith(...a.childNodes);
        return true;
      }
      const a = w.document.createElement('a');
      a.setAttribute('href', val);
      a.appendChild(range.extractContents());
      range.insertNode(a);
      sel.removeAllRanges();
      const r = w.document.createRange();
      r.selectNodeContents(a);
      sel.addRange(r);
      return true;
    }
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
  for (const f of ['model.js', 'html.js', 'runs.js', 'dom-runs.js', 'tables.js', 'pagesetup.js', 'paste.js']) w.eval(read('core', f));
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

const PNG_URI = 'data:image/png;base64,iVBORw0KGgo=';
const plain = (v) => JSON.parse(JSON.stringify(v));
const click = async (w, el) => { el.click(); await tick(60); };

describe('renderer: tablas e imagenes (hito 2)', () => {
  withDom('el selector de tamano inserta una tabla despues del bloque seleccionado', async () => {
    const { w, server } = await boot([{ id: 'p1', type: 'paragraph', text: 'uno' }, { id: 'p2', type: 'paragraph', text: 'dos' }]);
    surfaces(w)[0].focus();
    await tick();
    await click(w, w.document.querySelector('#doc-ins-table'));
    const picker = w.document.querySelector('#doc-table-picker');
    assert.ok(picker.classList.contains('on'));
    await click(w, picker.querySelector('i[data-r="3"][data-c="4"]'));
    const t = server.doc.blocks[1];
    assert.equal(t.type, 'table');
    assert.equal(t.rows.length, 3);
    assert.equal(t.rows[0].length, 4);
    assert.equal(server.doc.blocks[2].text, 'dos');
    assert.ok(!picker.classList.contains('on'), 'el selector se cierra');
  });

  withDom('sin documento seleccionado la tabla va al final', async () => {
    const { w, server } = await boot([{ id: 'p1', type: 'paragraph', text: 'uno' }]);
    await click(w, w.document.querySelector('#doc-ins-table'));
    await click(w, w.document.querySelector('#doc-table-picker i[data-r="2"][data-c="2"]'));
    assert.equal(server.doc.blocks[1].type, 'table');
  });

  withDom('barra de tabla: agregar fila debajo de la celda actual, columna y borrar', async () => {
    const { w, server } = await boot([{ id: 't', type: 'table', header: true, rows: [['a', 'b'], ['c', 'd']] }]);
    const cell = w.document.querySelector('[data-tr="0"][data-tc="1"]');
    cell.focus();
    await tick();
    const bar = w.document.querySelector('#doc-objbar');
    assert.ok(bar.classList.contains('on'));
    await click(w, bar.querySelector('[data-tbl="addRowAfter"]'));
    assert.deepEqual(plain(server.doc.blocks[0].rows), [['a', 'b'], ['', ''], ['c', 'd']]);
    w.document.querySelector('[data-tr="0"][data-tc="1"]').focus();
    await tick();
    await click(w, w.document.querySelector('#doc-objbar [data-tbl="addColBefore"]'));
    assert.deepEqual(plain(server.doc.blocks[0].rows[0]), ['a', '', 'b']);
    w.document.querySelector('[data-tr="2"][data-tc="0"]').focus();
    await tick();
    await click(w, w.document.querySelector('#doc-objbar [data-tbl="deleteRow"]'));
    assert.equal(server.doc.blocks[0].rows.length, 2);
  });

  withDom('un cambio de celda sin confirmar no se pierde al agregar una fila', async () => {
    const { w, server } = await boot([{ id: 't', type: 'table', rows: [['a', 'b'], ['c', 'd']] }]);
    const cell = w.document.querySelector('[data-tr="1"][data-tc="0"]');
    cell.focus();
    cell.textContent = 'NUEVO';
    cell.dispatchEvent(new w.Event('input', { bubbles: true }));
    await click(w, w.document.querySelector('#doc-objbar [data-tbl="addRowAfter"]'));
    assert.deepEqual(plain(server.doc.blocks[0].rows), [['a', 'b'], ['NUEVO', 'd'], ['', '']]);
  });

  withDom('el boton Encabezado alterna la primera fila', async () => {
    const { w, server } = await boot([{ id: 't', type: 'table', rows: [['a', 'b'], ['c', 'd']] }]);
    w.document.querySelector('[data-tr="0"][data-tc="0"]').focus();
    await tick();
    assert.equal(w.document.querySelectorAll('#doc-body th').length, 2);
    await click(w, w.document.querySelector('#doc-objbar [data-tbl="header"]'));
    assert.equal(server.doc.blocks[0].header, false);
    assert.equal(w.document.querySelectorAll('#doc-body th').length, 0);
  });

  withDom('insertar imagen desde archivo: queda como bloque con tamano ajustado', async () => {
    const { w, server } = await boot([{ id: 'p1', type: 'paragraph', text: 'uno' }]);
    // jsdom no decodifica imagenes: se simula un tamano natural de 3000x1500.
    w.Image = class { set src(v) { this.naturalWidth = 3000; this.naturalHeight = 1500; setTimeout(() => this.onload && this.onload(), 0); } };
    const file = new w.File([Uint8Array.from([137, 80, 78, 71])], 'a.png', { type: 'image/png' });
    const input = w.document.querySelector('#doc-image-file');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    await tick(200);
    const img = server.doc.blocks[1];
    assert.equal(img.type, 'image');
    assert.match(img.src, /^data:image\/png;base64,/);
    assert.ok(img.width <= 700 && img.width >= 600, 'cabe en la pagina: ' + img.width);
    assert.equal(img.height * 2, img.width + (img.height * 2 - img.width), 'proporcion 2:1');
    assert.ok(Math.abs(img.width / img.height - 2) < 0.02);
  });

  withDom('formatos no admitidos y archivos enormes se rechazan sin tocar el documento', async () => {
    const { w, server } = await boot([{ id: 'p1', type: 'paragraph', text: 'uno' }]);
    const input = w.document.querySelector('#doc-image-file');
    Object.defineProperty(input, 'files', { value: [new w.File(['x'], 'a.exe', { type: 'application/x-msdownload' })], configurable: true });
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    await tick(100);
    assert.equal(server.doc.blocks.length, 1);
  });

  withDom('barra de imagen: preset de ancho y texto alternativo', async () => {
    const { w, server } = await boot([{ id: 'i', type: 'image', src: PNG_URI, width: 400, height: 200 }]);
    w.document.querySelector('.doc-b[data-type="image"] img').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    await tick();
    const bar = w.document.querySelector('#doc-objbar');
    assert.ok(bar.classList.contains('on'));
    assert.equal(bar.querySelector('#doc-img-w').value, '400');
    await click(w, bar.querySelector('[data-img-pct="50"]'));
    const b = server.doc.blocks[0];
    assert.equal(b.width, Math.round(((595 - 2 * 57) * 96 / 72) / 2));
    assert.ok(Math.abs(b.width / b.height - 2) < 0.03);
    const alt = w.document.querySelector('#doc-img-alt');
    alt.value = 'logo';
    alt.dispatchEvent(new w.Event('change', { bubbles: true }));
    await tick(60);
    assert.equal(server.doc.blocks[0].alt, 'logo');
  });

  withDom('arrastrar la esquina redimensiona conservando proporcion', async () => {
    const { w, server } = await boot([{ id: 'i', type: 'image', src: PNG_URI, width: 400, height: 200 }]);
    const wrap = w.document.querySelector('.doc-img-wrap');
    wrap.getBoundingClientRect = () => ({ width: 400, height: 200, left: 0, top: 0, right: 400, bottom: 200 });
    const handle = w.document.querySelector('[data-img-handle]');
    handle.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 400 }));
    w.document.dispatchEvent(new w.MouseEvent('mousemove', { bubbles: true, clientX: 300 }));
    w.document.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true, clientX: 300 }));
    await tick(80);
    assert.equal(server.doc.blocks[0].width, 300);
    assert.equal(server.doc.blocks[0].height, 150);
  });

  withDom('pegar una imagen del portapapeles crea un bloque (no pega texto)', async () => {
    const { w, server } = await boot([{ id: 'p1', type: 'paragraph', text: 'uno' }]);
    w.Image = class { set src(v) { this.naturalWidth = 100; this.naturalHeight = 50; setTimeout(() => this.onload && this.onload(), 0); } };
    const ce = surfaces(w)[0];
    ce.focus();
    const ev = new w.Event('paste', { bubbles: true, cancelable: true });
    ev.clipboardData = { files: [new w.File(['x'], 'p.png', { type: 'image/png' })], getData: () => '' };
    ce.dispatchEvent(ev);
    await tick(200);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(server.doc.blocks[1].type, 'image');
    assert.equal(server.doc.blocks[1].width, 100);
    assert.equal(server.doc.blocks[1].height, 50);
  });
});

describe('renderer: imagenes que viajan sin bytes (lightDoc)', () => {
  withDom('un snapshot sin src conserva la imagen en el repintado', async () => {
    const { w, server } = await boot([
      { id: 'p1', type: 'paragraph', text: 'antes' },
      { id: 'img1', type: 'image', src: PNG_URI, width: 400, height: 200 },
      { id: 'p2', type: 'paragraph', text: 'despues' }
    ]);
    const antes = w.document.querySelector('.doc-b[data-id="img1"] img');
    assert.ok(antes.src.includes('iVBORw0KGgo='));

    const res = await w.mc.docEdit({ expectedHash: server.doc.hash, ops: [{ op: 'replaceBlock', id: 'p1', block: { type: 'paragraph', text: 'antes x' } }] });
    assert.equal(res.ok, true);
    assert.equal(res.doc.blocks.find((b) => b.id === 'img1').src, undefined, 'el snapshot viaja sin los bytes');
    w.DocEditor.applySnapshot(res);

    const despues = w.document.querySelector('.doc-b[data-id="img1"] img');
    assert.ok(despues.src.includes('iVBORw0KGgo='), 'el repintado recupera el src del cache');
    assert.equal(w.document.querySelectorAll('#doc-host .doc-b').length, 3);
  });

  withDom('redimensionar con src omitido no pierde la imagen', async () => {
    const { w, server } = await boot([
      { id: 'img1', type: 'image', src: PNG_URI, width: 400, height: 200 },
      { id: 'p1', type: 'paragraph', text: 'a' }
    ]);
    const res = await w.mc.docEdit({ expectedHash: server.doc.hash, ops: [{ op: 'replaceBlock', id: 'p1', block: { type: 'paragraph', text: 'ab' } }] });
    assert.equal(res.ok, true);
    w.DocEditor.applySnapshot(res);

    w.document.querySelector('.doc-b[data-type="image"] img').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    await tick();
    await click(w, w.document.querySelector('#doc-objbar [data-img-pct="50"]'));
    const b = server.doc.blocks[0];
    assert.equal(b.type, 'image');
    assert.ok(b.width !== 400, 'el ancho cambio');
    assert.ok(b.src, 'el src se conserva al reenviar el bloque');
    assert.match(b.src, /^data:image\/png;base64,/);
  });

  withDom('una imagen nueva con src llena el cache y se pinta', async () => {
    const { w, server } = await boot([{ id: 'p1', type: 'paragraph', text: 'uno' }]);
    const res = await w.mc.docEdit({
      expectedHash: server.doc.hash,
      ops: [{ op: 'insert', index: 1, block: { id: 'img9', type: 'image', src: PNG_URI, width: 300, height: 100 } }]
    });
    assert.equal(res.ok, true);
    assert.equal(res.doc.blocks.find((b) => b.id === 'img9').src, PNG_URI, 'una imagen nueva viaja completa');
    w.DocEditor.applySnapshot(res);
    await tick();
    assert.equal(w.document.querySelector('.doc-b[data-id="img9"] img').src.includes('iVBORw0KGgo='), true);
  });
});

describe('renderer: sin dialogos nativos (borrar bloque dejaba la pagina sin foco)', () => {
  const noNative = (w) => {
    for (const k of ['confirm', 'prompt', 'alert']) w[k] = () => { throw new Error('dialogo nativo: ' + k); };
  };

  withDom('borrar un bloque no usa confirm, selecciona el vecino y se puede seguir escribiendo', async () => {
    const { w, server } = await boot([
      { id: 'a', type: 'paragraph', text: 'uno' }, { id: 'b', type: 'paragraph', text: 'dos' }, { id: 'c', type: 'paragraph', text: 'tres' }
    ]);
    noNative(w);
    surfaces(w)[1].dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    await tick();
    await click(w, w.document.querySelector('[data-block-delete]'));
    await tick(80);
    assert.deepEqual(server.doc.blocks.map((b) => b.id), ['a', 'c']);
    assert.ok(w.document.querySelector('.doc-b.sel'), 'queda un bloque seleccionado');
    const ce = surfaces(w)[1];
    assert.equal(w.document.activeElement, ce, 'el foco pasa al bloque vecino');
    ce.lastChild.nodeValue += '!';
    ce.dispatchEvent(new w.Event('input', { bubbles: true }));
    ce.dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
    await tick(80);
    assert.equal(server.doc.blocks[1].text, 'tres!');
    assert.match(w.document.querySelector('#doc-toast').textContent, /eliminado/);
    assert.ok(w.document.querySelector('.doc-toast-action'), 'ofrece Deshacer');
  });

  withDom('Buscar y reemplazar usa el dialogo propio', async () => {
    const { w, server } = await boot([{ id: 'a', type: 'paragraph', text: 'hola mundo' }]);
    noNative(w);
    await click(w, w.document.querySelector('#doc-find'));
    const inputs = w.document.querySelectorAll('.doc-modal input');
    assert.equal(inputs.length, 2);
    assert.equal(w.document.activeElement, inputs[0]);
    inputs[0].value = 'mundo';
    inputs[1].value = 'cielo';
    w.document.querySelector('.doc-modal .doc-btn.primary').click();
    await tick(80);
    assert.equal(server.doc.blocks[0].text, 'hola cielo');
    assert.equal(w.document.querySelector('.doc-modal'), null);
  });

  withDom('Escape cancela el dialogo sin tocar el documento', async () => {
    const { w, server } = await boot([{ id: 'a', type: 'paragraph', text: 'hola' }]);
    noNative(w);
    await click(w, w.document.querySelector('#doc-find'));
    const input = w.document.querySelector('.doc-modal input');
    input.value = 'hola';
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(40);
    assert.equal(w.document.querySelector('.doc-modal'), null);
    assert.equal(server.doc.blocks[0].text, 'hola');
  });
});

describe('renderer: pagina, parrafo, enlaces y zoom (hito 3)', () => {
  const setField = (w, label, value) => {
    const lab = Array.from(w.document.querySelectorAll('.doc-modal label')).find((l) => l.textContent.startsWith(label));
    lab.querySelector('input,select').value = value;
  };

  withDom('el panel Pagina cambia orientacion, margenes, encabezado, pie y numeros', async () => {
    const { w, server } = await boot([{ id: 'a', type: 'paragraph', text: 'hola' }]);
    await click(w, w.document.querySelector('#doc-page-setup'));
    setField(w, 'Orientación', 'landscape');
    setField(w, 'Márgenes', 'narrow');
    setField(w, 'Encabezado', 'Informe MC');
    setField(w, 'Pie de página', 'Confidencial');
    setField(w, 'Número de página', 'right');
    w.document.querySelector('.doc-modal .doc-btn.primary').click();
    await tick(100);
    const p = server.doc.page;
    assert.ok(p.width > p.height, 'horizontal');
    assert.equal(p.margin, 36);
    assert.equal(p.header, 'Informe MC');
    assert.equal(p.footer, 'Confidencial');
    assert.equal(p.pageNumbers, 'right');
    const paper = w.document.querySelector('.doc-paper');
    assert.equal(paper.querySelector('.doc-paper-hf.head').textContent, 'Informe MC');
    assert.match(paper.querySelector('.doc-paper-hf.foot').textContent, /Confidencial\s+1/);
    assert.ok(Math.abs(parseFloat(paper.style.width) - p.width * 96 / 72) < 0.01, 'la hoja se dibuja horizontal');
  });

  withDom('la hoja respeta los margenes por lado', async () => {
    const { w } = await boot([{ id: 'a', type: 'paragraph', text: 'hola' }], { width: 595, height: 842, margin: 57, marginLeft: 100, marginTop: 20 });
    const pad = w.document.querySelector('.doc-paper').style.padding.split(/\s+/).map(parseFloat);
    const px = (pt) => Math.round(pt * 96 / 72 * 100) / 100;
    assert.deepEqual(pad.map((v) => Math.round(v * 100) / 100), [px(20), px(57), px(57), px(100)]);
  });

  withDom('sangria y interlineado del bloque', async () => {
    const { w, server } = await boot([{ id: 'a', type: 'paragraph', text: 'hola' }]);
    surfaces(w)[0].dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    await tick();
    await click(w, w.document.querySelector('[data-block-indent="1"]'));
    await click(w, w.document.querySelector('[data-block-indent="1"]'));
    assert.equal(server.doc.blocks[0].indent, 2);
    await click(w, w.document.querySelector('[data-block-indent="-1"]'));
    assert.equal(server.doc.blocks[0].indent, 1);
    const lh = w.document.querySelector('#doc-lh');
    lh.value = '1.5';
    lh.dispatchEvent(new w.Event('change', { bubbles: true }));
    await tick(80);
    assert.equal(server.doc.blocks[0].lineHeight, 1.5);
    assert.equal(w.document.querySelector('#doc-lh').value, '1.5');
    w.document.querySelector('#doc-lh').value = '';
    w.document.querySelector('#doc-lh').dispatchEvent(new w.Event('change', { bubbles: true }));
    await tick(80);
    assert.equal(server.doc.blocks[0].lineHeight, undefined);
  });

  withDom('enlace sobre la seleccion, y se quita dejandolo vacio', async () => {
    const { w, server } = await boot([{ id: 'a', type: 'paragraph', text: 'visita el sitio hoy' }]);
    w.alert = w.confirm = w.prompt = () => { throw new Error('nativo'); };
    select(w, surfaces(w)[0], 10, 15);
    await click(w, w.document.querySelector('[data-inline-only="link"]'));
    const input = w.document.querySelector('.doc-modal input');
    input.value = 'mc.example/pagina';
    w.document.querySelector('.doc-modal .doc-btn.primary').click();
    await tick(100);
    const runs = server.doc.blocks[0].runs;
    assert.equal(runs.find((r) => r.link).text, 'sitio');
    assert.equal(runs.find((r) => r.link).link, 'https://mc.example/pagina');
  });

  withDom('enlace peligroso se rechaza', async () => {
    const { w, server } = await boot([{ id: 'a', type: 'paragraph', text: 'visita el sitio hoy' }]);
    select(w, surfaces(w)[0], 10, 15);
    await click(w, w.document.querySelector('[data-inline-only="link"]'));
    w.document.querySelector('.doc-modal input').value = 'javascript:alert(1)';
    w.document.querySelector('.doc-modal .doc-btn.primary').click();
    await tick(100);
    assert.equal(server.doc.blocks[0].runs, undefined);
    assert.match(w.document.querySelector('#doc-toast').textContent, /http/);
  });

  withDom('zoom: escala las hojas y sobrevive al repintado', async () => {
    const { w, server } = await boot([{ id: 'a', type: 'paragraph', text: 'hola' }]);
    const z = w.document.querySelector('#doc-zoom');
    z.value = '150';
    z.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(w.document.querySelector('.doc-paper-stack').style.zoom, '1.5');
    surfaces(w)[0].dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    await click(w, w.document.querySelector('[data-block-indent="1"]'));
    assert.equal(server.doc.blocks[0].indent, 1);
    assert.equal(w.document.querySelector('.doc-paper-stack').style.zoom, '1.5');
  });
});

describe('renderer: estilos del documento (hito 4)', () => {
  withDom('Fijar estilo: el formato del titulo pasa a todos los titulos 1 y el bloque lo hereda', async () => {
    const { w, server } = await boot([
      { id: 'h1', type: 'heading', level: 1, text: 'Uno', size: 22, color: '#1a3c6e', align: 'center' },
      { id: 'h2', type: 'heading', level: 1, text: 'Dos' },
      { id: 'p', type: 'paragraph', text: 'cuerpo', size: 13 }
    ]);
    surfaces(w)[0].dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    await tick();
    await click(w, w.document.querySelector('[data-style-save]'));
    assert.deepEqual(plain(server.doc.styles), { heading1: { size: 22, color: '#1a3c6e', align: 'center' } });
    const [a, b, c] = server.doc.blocks;
    assert.equal(a.size, undefined); assert.equal(a.color, undefined); assert.equal(a.align, undefined);
    assert.equal(c.size, 13, 'otros tipos no se tocan');
    const css = w.document.getElementById('doc-doc-styles').textContent;
    assert.match(css, /\.doc-b h1\.doc-ce \{[^}]*font-size: 22pt/);
    assert.ok(b && a.text === 'Uno');
  });

  withDom('Fijar estilo sin formato propio avisa y no cambia nada', async () => {
    const { w, server } = await boot([{ id: 'p', type: 'paragraph', text: 'sin formato' }]);
    surfaces(w)[0].dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    await tick();
    await click(w, w.document.querySelector('[data-style-save]'));
    assert.equal(server.doc.styles, undefined);
    assert.match(w.document.querySelector('#doc-toast').textContent, /no tiene formato propio/);
  });

  withDom('Sin estilos los quita', async () => {
    const { w, server } = await boot([{ id: 'p', type: 'paragraph', text: 'x' }], undefined, { paragraph: { size: 12 } });
    assert.match(w.document.getElementById('doc-doc-styles').textContent, /font-size: 12pt/);
    await click(w, w.document.querySelector('[data-style-reset]'));
    assert.equal(server.doc.styles, undefined);
    assert.equal(w.document.getElementById('doc-doc-styles').textContent, '');
  });
});

describe('renderer: pegar con formato', () => {
  const fire = (w, target, html, text = '') => {
    const ev = new w.Event('paste', { bubbles: true, cancelable: true });
    ev.clipboardData = { files: [], getData: (t) => (t === 'text/html' ? html : text) };
    target.dispatchEvent(ev);
    return ev;
  };

  withDom('un parrafo con negrita se pega en el cursor conservando el formato', async () => {
    const { w, server } = await boot([{ id: 'a', type: 'paragraph', text: 'inicio fin' }]);
    select(w, surfaces(w)[0], 7, 7);
    const ev = fire(w, surfaces(w)[0], '<p>uno <b>dos</b></p>');
    await tick(100);
    assert.equal(ev.defaultPrevented, true);
    const runs = server.doc.blocks[0].runs;
    assert.equal(runs.map((r) => r.text).join(''), 'inicio uno dosfin');
    assert.equal(runs.find((r) => r.text === 'dos').bold, true);
  });

  withDom('varios bloques (titulo + lista + tabla) se insertan despues del actual', async () => {
    const { w, server } = await boot([{ id: 'a', type: 'paragraph', text: 'antes' }, { id: 'z', type: 'paragraph', text: 'despues' }]);
    select(w, surfaces(w)[0], 5, 5);
    fire(w, surfaces(w)[0], '<h2>Nuevo</h2><ul><li>x</li><li>y</li></ul><table><tr><td>1</td></tr></table>');
    await tick(150);
    assert.deepEqual(server.doc.blocks.map((b) => b.type), ['paragraph', 'heading', 'list', 'table', 'paragraph']);
    assert.equal(server.doc.blocks[0].text, 'antes');
    assert.equal(server.doc.blocks[4].text, 'despues');
  });

  withDom('sobre un parrafo vacio se pega en su lugar', async () => {
    const { w, server } = await boot([{ id: 'a', type: 'paragraph', text: '' }]);
    surfaces(w)[0].focus();
    fire(w, surfaces(w)[0], '<h1>Titulo</h1><p>cuerpo</p>');
    await tick(150);
    assert.deepEqual(server.doc.blocks.map((b) => b.type), ['heading', 'paragraph']);
  });

  withDom('html sin formato cae al pegado de texto plano de siempre', async () => {
    const { w, server } = await boot([{ id: 'a', type: 'paragraph', text: 'ab' }]);
    select(w, surfaces(w)[0], 1, 1);
    const ev = fire(w, surfaces(w)[0], '<p>solo</p>', 'solo');
    surfaces(w)[0].dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
    await tick(100);
    assert.equal(ev.defaultPrevented, true, 'lo maneja el pegado plano');
    assert.equal(server.doc.blocks[0].text, 'asolob');
  });
});

describe('renderer: formato en items y celdas', () => {
  withDom('negrita en una celda se guarda como cellRuns', async () => {
    const { w, server } = await boot([{ id: 't', type: 'table', rows: [['Hola mundo', 'x']] }]);
    const cell = w.document.querySelector('[data-tr="0"][data-tc="0"]');
    select(w, cell, 5, 10);
    w.document.querySelector('[data-block-toggle="bold"]').click();
    await tick(60);
    const b = server.doc.blocks[0];
    assert.deepEqual(plain(b.rows), [['Hola mundo', 'x']]);
    assert.deepEqual(plain(b.cellRuns['0,0']), [{ text: 'Hola ' }, { text: 'mundo', bold: true }]);
    assert.ok(w.document.querySelector('[data-tr="0"][data-tc="0"] strong, [data-tr="0"][data-tc="0"] b'));
  });

  withDom('negrita en un item de lista se guarda como itemRuns, sin tocar los demas', async () => {
    const { w, server } = await boot([{ id: 'l', type: 'list', items: ['uno', 'dos tres'] }]);
    const it = w.document.querySelector('[data-li="1"]');
    select(w, it, 4, 8);
    w.document.querySelector('[data-block-toggle="bold"]').click();
    await tick(60);
    const b = server.doc.blocks[0];
    assert.deepEqual(plain(b.items), ['uno', 'dos tres']);
    assert.equal(b.itemRuns[0], null);
    assert.deepEqual(plain(b.itemRuns[1]), [{ text: 'dos ' }, { text: 'tres', bold: true }]);
  });

  withDom('Enter en un item no parte el bloque', async () => {
    const { w, server } = await boot([{ id: 'l', type: 'list', items: ['uno'] }]);
    const it = w.document.querySelector('[data-li="0"]');
    select(w, it, 3, 3);
    await key(w, it, 'Enter');
    assert.equal(server.doc.blocks.length, 1);
  });
});

describe('renderer: documento cambiado por detras', () => {
  withDom('si el hash esta viejo la UI relee y reintenta en vez de quedar bloqueada', async () => {
    const { w, server } = await boot([{ id: 'p1', type: 'paragraph', text: 'Hola mundo' }]);
    // Alguien (la IA, un aviso perdido) cambia el documento sin que la UI lo sepa.
    server.doc = patch.applyPatch(server.doc, { expectedHash: server.doc.hash, ops: [{ op: 'setTitle', title: 'Otro' }] }).doc;
    select(w, surfaces(w)[0], 0, 4);
    w.document.querySelector('[data-block-toggle="bold"]').click();
    await tick(120);
    assert.equal(server.doc.blocks[0].runs[0].bold, true);
    assert.equal(server.doc.title, 'Otro');
  });
});

describe('renderer: vinetas y numeracion conservan el formato', () => {
  withDom('parrafo con formato -> lista -> parrafo no pierde tramos', async () => {
    const { w, server } = await boot([{ id: 'p1', type: 'paragraph', runs: [{ text: 'Hola ' }, { text: 'mundo', size: 18, font: 'Georgia', color: '#ff0000' }] }]);
    surfaces(w)[0].dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    w.document.querySelector('[data-block-list="ordered"]').click();
    await tick(80);
    let b = server.doc.blocks[0];
    assert.equal(b.type, 'list');
    assert.deepEqual(plain(b.itemRuns[0]), [{ text: 'Hola ' }, { text: 'mundo', size: 18, font: 'Georgia', color: '#ff0000' }]);
    w.document.querySelector('[data-block-list="ordered"]').click();
    await tick(80);
    b = server.doc.blocks[0];
    assert.equal(b.type, 'paragraph');
    assert.deepEqual(plain(b.runs), [{ text: 'Hola ' }, { text: 'mundo', size: 18, font: 'Georgia', color: '#ff0000' }]);
  });
});

describe('renderer: menu contextual propio', () => {
  withDom('clic derecho en una celda ofrece las operaciones de tabla y las aplica', async () => {
    const { w, server } = await boot([{ id: 't', type: 'table', rows: [['a', 'b'], ['c', 'd']] }]);
    const cell = w.document.querySelector('[data-tr="0"][data-tc="1"]');
    const ev = new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    cell.dispatchEvent(ev);
    // Sobre texto el evento sigue su camino (para el corrector): el main suprime el menu nativo.
    assert.equal(ev.defaultPrevented, false);
    const menu = w.document.querySelector('#doc-ctxmenu');
    assert.ok(menu);
    const item = Array.from(menu.querySelectorAll('.doc-ctx-item')).find((b) => /Insertar fila abajo/.test(b.textContent));
    assert.ok(item);
    item.click();
    await tick(80);
    assert.deepEqual(plain(server.doc.blocks[0].rows), [['a', 'b'], ['', ''], ['c', 'd']]);
    assert.equal(w.document.querySelector('#doc-ctxmenu'), null);
  });

  withDom('convertir desde el menu: parrafo -> titulo', async () => {
    const { w, server } = await boot([{ id: 'p', type: 'paragraph', text: 'Hola' }]);
    surfaces(w)[0].dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    Array.from(w.document.querySelectorAll('#doc-ctxmenu .doc-ctx-item')).find((b) => /Título 1/.test(b.textContent)).click();
    await tick(80);
    assert.equal(server.doc.blocks[0].type, 'heading');
  });

  withDom('Escape cierra el menu', async () => {
    const { w } = await boot([{ id: 'p', type: 'paragraph', text: 'Hola' }]);
    surfaces(w)[0].dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    assert.ok(w.document.querySelector('#doc-ctxmenu'));
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(w.document.querySelector('#doc-ctxmenu'), null);
  });
});


describe('renderer: corrector ortografico', () => {
  withDom('sobre texto no cancela el clic derecho, avisa al main y agrega sugerencias', async () => {
    const { w, server } = await boot([{ id: 'p', type: 'paragraph', text: 'Hola mundoo cruel' }]);
    const ce = surfaces(w)[0];
    assert.equal(ce.getAttribute('spellcheck'), 'true');
    const text = ce.firstChild;
    w.document.caretRangeFromPoint = () => { const r = w.document.createRange(); r.setStart(text, 8); r.setEnd(text, 8); return r; };
    const ev = new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    ce.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(server.ctxOpened, 1);
    server.emit('doc:spell', { word: 'mundoo', suggestions: ['mundo', 'mundos'] });
    const items = Array.from(w.document.querySelectorAll('#doc-ctxmenu .doc-ctx-item'));
    assert.match(items[0].textContent, /mundo/);
    items[0].click();
    await tick(80);
    assert.equal(server.doc.blocks[0].text, 'Hola mundo cruel');
  });

  withDom('agregar al diccionario y palabra que no coincide', async () => {
    const { w, server } = await boot([{ id: 'p', type: 'paragraph', text: 'Hola mundoo' }]);
    const ce = surfaces(w)[0];
    const text = ce.firstChild;
    w.document.caretRangeFromPoint = () => { const r = w.document.createRange(); r.setStart(text, 8); r.setEnd(text, 8); return r; };
    ce.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    server.emit('doc:spell', { word: 'otra', suggestions: ['x'] });
    assert.ok(!w.document.querySelector('#doc-ctxmenu .doc-ctx-item.spell'));
    server.emit('doc:spell', { word: 'mundoo', suggestions: [] });
    Array.from(w.document.querySelectorAll('#doc-ctxmenu .doc-ctx-item')).find((b) => /Agregar al diccionario/.test(b.textContent)).click();
    await tick(40);
    assert.equal(server.added, 'mundoo');
  });

  withDom('en un bloque de codigo no hay corrector', async () => {
    const { w } = await boot([{ id: 'c', type: 'code', text: 'let x' }]);
    assert.equal(surfaces(w)[0].getAttribute('spellcheck'), 'false');
  });
});
