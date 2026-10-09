'use strict';
/**
 * Dialogos propios del navegador. window.confirm/prompt/alert nativos dejan a
 * Electron/Windows sin foco de teclado al cerrarse (habia que reiniciar el
 * navegador tras "Borrar todos los datos") y prompt() no existe en Electron.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch { /* sin jsdom */ }
const withDom = JSDOM ? test : test.skip;
const SRC = path.join(__dirname, '..', 'src');
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function boot() {
  const dom = new JSDOM('<!doctype html><body><input id="x"></body>', { runScripts: 'outside-only' });
  dom.window.eval(fs.readFileSync(path.join(SRC, 'renderer', 'dialogs.js'), 'utf8'));
  return dom.window;
}

describe('src/renderer/dialogs.js', () => {
  withDom('confirm: Aceptar resuelve true y devuelve el foco', async () => {
    const w = boot();
    w.document.getElementById('x').focus();
    const p = w.mcDialog.confirm('¿Seguro?', { ok: 'Borrar', danger: true });
    assert.equal(w.document.querySelector('.mc-dialog-back').textContent.includes('¿Seguro?'), true);
    assert.equal(w.document.activeElement.textContent, 'Borrar');
    w.document.activeElement.click();
    assert.equal(await p, true);
    assert.equal(w.document.querySelector('.mc-dialog-back'), null);
    assert.equal(w.document.activeElement, w.document.getElementById('x'), 'el foco vuelve a donde estaba');
  });
  withDom('confirm: Escape y Cancelar resuelven false', async () => {
    const w = boot();
    const p = w.mcDialog.confirm('x');
    w.document.querySelector('.mc-dialog-back [role=dialog]').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(await p, false);
    const q = w.mcDialog.confirm('x');
    Array.from(w.document.querySelectorAll('.mc-dialog-back button')).find((b) => b.textContent === 'Cancelar').click();
    assert.equal(await q, false);
  });
  withDom('prompt: devuelve el texto con Enter, null si se cancela', async () => {
    const w = boot();
    const p = w.mcDialog.prompt('Nombre:', 'viejo');
    const input = w.document.querySelector('.mc-dialog-back input');
    assert.equal(input.value, 'viejo');
    assert.equal(w.document.activeElement, input);
    input.value = 'nuevo';
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(await p, 'nuevo');
    const q = w.mcDialog.prompt('Nombre:');
    w.document.querySelector('.mc-dialog-back input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(await q, null);
    await tick();
  });
  withDom('alert: un solo boton', async () => {
    const w = boot();
    const p = w.mcDialog.alert('Listo');
    assert.equal(w.document.querySelectorAll('.mc-dialog-back button').length, 1);
    w.document.querySelector('.mc-dialog-back button').click();
    await p;
  });
});

describe('el renderer no usa dialogos nativos', () => {
  test('ni confirm() ni prompt() ni alert() en src/renderer', () => {
    const dir = path.join(SRC, 'renderer');
    const offenders = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js') && n !== 'dialogs.js')) {
      fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/(^|[^.\w])(window\.)?(confirm|prompt|alert)\s*\(/.test(code)) offenders.push(`${f}:${i + 1}`);
      });
    }
    assert.deepEqual(offenders, []);
  });
});
