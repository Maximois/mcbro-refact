'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const leer = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const MAIN = leer('src/main/bootstrap.js');
const WEB = leer('src', 'main', 'windows', 'webcontents.js');
const CTX = leer('src', 'main', 'windows', 'context-menu.js');
const codigo = (s) => s.slice(s.indexOf('*/') + 2);

describe('windows/context-menu.js -- la extraccion', () => {
  test('bootstrap.js no queda con el bloque wc.on context-menu', () => {
    assert.doesNotMatch(MAIN, /wc\.on\('context-menu'/);
    assert.match(WEB, /const WindowsContextMenu = require\('\.\/context-menu'\);/);
    assert.match(WEB, /WindowsContextMenu\.installContextMenu\(wc, \{ saveBlobOrDataUrlToDownloads, resolveCtxCssPoint \}\);/);
  });

  test('el bloque extraido esta entero, con todas sus hojas', () => {
    assert.match(CTX, /wc\.on\('context-menu', async \(_contextEvent, params\) => \{/);
    // Una muestra de cada rama dependiente del params posibles
    assert.match(CTX, /enabled: Boolean\(params\.selectionText\)/);
    assert.match(CTX, /if \(params\.isEditable\) \{/);
    assert.match(CTX, /if \(params\.linkURL\) \{/);
    assert.match(CTX, /if \(params\.selectionText\) \{/);
    assert.match(CTX, /if \(params\.mediaType === 'image' && params\.srcURL\) \{/);
    assert.match(CTX, /const contextMediaLabel = isContextHls \? 'Descargar playlist HLS'/);
    assert.match(CTX, /const isContextDash = \/\\\.mpd\(\?:\\\?|#|\$\)\/i\.test\(contextMediaUrl\);/);
    assert.match(CTX, /const isContextVideo = params\.mediaType === 'video' \|\|/);
    assert.match(CTX, /const safeTitle = String\(title \|\| 'pagina-web'\)/);
    assert.match(CTX, /Menu\.buildFromTemplate\(template\)\.popup\(/);
  });

  test('las dos funciones del externo se inyectan, y son las de bootstrap.js', () => {
    assert.match(codigo(CTX), /const \{ saveBlobOrDataUrlToDownloads, resolveCtxCssPoint \} = deps;/);
    assert.match(codigo(CTX), /saveBlobOrDataUrlToDownloads\(wc, linkUrl, params\.linkText/);
    assert.match(codigo(CTX), /saveBlobOrDataUrlToDownloads\(wc, params\.srcURL, 'imagen', params\.frame\)/);
    assert.match(codigo(CTX), /saveBlobOrDataUrlToDownloads\(wc, params\.srcURL, 'multimedia', params\.frame\)/);
    assert.match(codigo(CTX), /resolveCtxCssPoint\(wc, params\)/);
    assert.match(MAIN, /async function saveBlobOrDataUrlToDownloads\(wc/);
    assert.match(MAIN, /async function resolveCtxCssPoint\(wc/);
  });

  test('el anti-reentrancia atraves a Menu.buildFromTemplate', () => {
    // El patron es: si ya hay un popup abierto, no lanzar otro (Windows
    // congela el menu si se reentrada). La liberacion va en el CALLBACK de
    // popup, que electron invoca al cerrarlo, y en el catch por si retumbe.
    assert.match(codigo(CTX), /if \(_ctxMenuPopupCount > 0\) return;/);
    assert.match(codigo(CTX), /_ctxMenuPopupCount\+\+;/);
    assert.match(codigo(CTX), /callback: \(\) => \{ _ctxMenuPopupCount = 0; \}/);
    assert.match(codigo(CTX), /\} catch \{\s*_ctxMenuPopupCount = 0;\s*\}/);
  });

  test('el toggle de bloqueo cosmético filtra la lista de reglas', () => {
    assert.match(codigo(CTX), /CFG\.userCosmeticRules = \(CFG\.userCosmeticRules \|\| \[\]\)\.filter\(r => r !== blockedRule\);/);
    assert.match(codigo(CTX), /getMainWin\(\)\?\.webContents\?\.send\('cosmetic-unblock-result', \{ ok: true, rule: blockedRule \}\);/);
  });

  test('el item de bloqueo usa el selector construido desde elementFromPoint', () => {
    assert.match(codigo(CTX), /const all = document\.elementsFromPoint\(px, py\);/);
    assert.match(codigo(CTX), /part \+= '#' \+ CSS\.escape\(cur\.id\)\.slice\(0, 80\);/);
    assert.match(codigo(CTX), /part \+= '\.' \+ \[\.\.\.cur\.classList\]\.slice\(0, 3\)\.map\(c => CSS\.escape\(c\)\)\.join\('\.'\);/);
  });

  test('no aparecen los nombres de electron envueltos por bootstrap.js sino por este', () => {
    assert.match(CTX, /const fs = require\('fs'\);/);
    assert.match(CTX, /const path = require\('path'\);/);
    assert.match(CTX, /const \{ app, Menu, clipboard, dialog \} = require\('electron'\);/);
    assert.match(CTX, /const \{ ACTIONS, getMainWin \} = require\('\.\.\/runtime'\);/);
    assert.match(CTX, /const \{ CFG, saveCfg \} = require\('\.\.\/config'\);/);
    assert.match(CTX, /const Sessions = require\('\.\.\/sessions\/partitions'\);/);
    // Y bootstrap.js conserva las dos funciones que el modulo no se llevo.
    assert.match(WEB, /WindowsContextMenu\.installContextMenu\(wc, \{/);
    assert.match(MAIN, /saveBlobOrDataUrlToDownloads,\s*\n\s*resolveCtxCssPoint/);
  });
});

describe('windows/context-menu.js -- FIXADO: las dos referencias huerfanas', () => {
  test('FIXADO: withTimeout esta declarado y corta la promesa colgada', () => {
    // Antes no existia: se evaluaba como libre en strict, lanzaba
    // ReferenceError y el catch del bloque lo traga, dejando la deteccion de
    // "elemento bloqueado" siempre a null.
    assert.match(codigo(CTX), /function withTimeout\(promise, ms, fallback\) \{/);
    assert.match(codigo(CTX), /Promise\.race\(\[promise, timeout\]\)/);
    assert.match(codigo(CTX), /blockedRule = await withTimeout\(detect, 400, null\);/);
  });

  test('FIXADO: _ctxMenuPopupCount esta declarado y el menu llega a construirse', () => {
    // Antes el handler reventaba en la primera comparacion con un
    // ReferenceError, justo antes de Menu.buildFromTemplate: el menu de clic
    // derecho no aparecia nunca.
    assert.match(codigo(CTX), /let _ctxMenuPopupCount = 0;/);
    assert.match(codigo(CTX), /if \(_ctxMenuPopupCount > 0\) return;/);
    assert.match(codigo(CTX), /_ctxMenuPopupCount\+\+;/);
    assert.match(codigo(CTX), /callback: \(\) => \{ _ctxMenuPopupCount = 0; \}/);
  });

  test('FIXADO: saveCfg viene de config, no se llama a un global inexistente', () => {
    // Las tres ramas de desbloquear guardan la regla nueva; sin el import,
    // esos clicks lanzaban ReferenceError.
    assert.match(codigo(CTX), /const \{ CFG, saveCfg \} = require\('\.\.\/config'\);/);
    assert.equal((codigo(CTX).match(/saveCfg\(\);/g) || []).length, 3);
  });

  test('el handler llega al popup: cargar el modulo y dispararlo no lanza', () => {
    // Test funcional de verdad: se intercepta require('electron') con un Menu
    // falso que registra el popup. Un ReferenceError en el camino (el bug que
    // hacia que el menu no apareciera) deja popupCalls en 0.
    const Module = require('node:module');
    const path = require('node:path');
    const original = Module._load;
    const popupCalls = [];
    const fakeMenu = {
      buildFromTemplate(template) {
        return {
          popup(opts) {
            popupCalls.push({ labels: template.filter(i => i.label).map(i => i.label), opts });
          }
        };
      }
    };
    const fakeWin = { webContents: { send() {} } };
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') {
        return {
          app: { getPath: () => 'C:\\tmp' },
          Menu: fakeMenu,
          clipboard: { writeText() {} },
          dialog: { showSaveDialog() {} }
        };
      }
      return original.apply(this, arguments);
    };
    let mod;
    try {
      const modPath = path.join(__dirname, '..', 'src', 'main', 'windows', 'context-menu.js');
      delete require.cache[require.resolve(modPath)];
      mod = require(modPath);
    } finally {
      Module._load = original;
    }

    const handlers = {};
    const wc = {
      on(ev, fn) { handlers[ev] = fn; },
      getURL: () => 'https://example.com/',
      canGoBack: () => false,
      canGoForward: () => false,
      reload() {},
      isDestroyed: () => false,
      executeJavaScript: async () => null,
      insertCSS: async () => {}
    };
    mod.installContextMenu(wc, {
      saveBlobOrDataUrlToDownloads: async () => ({ ok: true }),
      resolveCtxCssPoint: async () => ({ x: 1, y: 1 })
    });

    const params = {
      selectionText: '', isEditable: false, linkURL: '', srcURL: '',
      mediaType: 'none', frame: '', x: 1, y: 1, pageURL: 'https://example.com/'
    };
    // El handler es async: se dispara y se espera a que termine.
    return handlers['context-menu'](null, params).then(() => {
      assert.equal(popupCalls.length, 1,
        'el menu debio construirse y llamar a popup() una vez');
      assert.ok(popupCalls[0].labels.includes('Bloquear este elemento'));
      assert.equal(typeof popupCalls[0].opts.callback, 'function');
    });
  });

  test('los tests de duplicados de canales IPC no cuentan estos nombres', () => {
    // Se fija para que nadie "limpie" la cabecera (que menciona literal
    // context-menu/handle en distintos puntos) y rompa accidentalmente la
    // prueba de canales duplicados.
    assert.match(CTX, /installContextMenu/);
  });
});