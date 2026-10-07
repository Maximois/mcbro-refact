'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const leer = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const MAIN = leer('src/main/bootstrap.js');
const PANEL = leer('src', 'main', 'perchance', 'panel.js');
const codigo = (s) => s.slice(s.indexOf('*/') + 2);

describe('perchance/panel.js -- la extraccion', () => {
  test('bootstrap.js ejecuta la setup desde el modulo nuevo', () => {
    assert.match(MAIN, /const PerchancePaneInit = require\('\.\/perchance\/panel'\);/);
    assert.match(MAIN, /PerchancePaneInit\.setupPerchancePanel\(\);/);
    assert.doesNotMatch(MAIN, /function setupPerchancePanel\(\)/);
    assert.doesNotMatch(MAIN, /const perchanceDiagInstalled = new WeakSet/);
    assert.match(PANEL, /const perchanceDiagInstalled = new WeakSet\(\);/);
  });

  test('el bloque salio entero: sesion, instaladores y diagnostico', () => {
    assert.match(codigo(PANEL), /function setupPerchancePanel\(\) \{/);
    assert.match(codigo(PANEL), /app\.configureHostResolver\(\{ enableBuiltInResolver: true, secureDnsMode: 'off' \}\);/);
    assert.match(codigo(PANEL), /PerchancePanel\.installPerchanceNetwork\(PerchancePanel\.PERCHANCE_PARTITION\);/);
    assert.match(codigo(PANEL), /PerchancePanel\.installPerchanceDownloads\(PerchancePanel\.PERCHANCE_PARTITION, \{/);
    assert.match(codigo(PANEL), /PerchancePanel\.installPerchanceAlertBubbles\(PerchancePanel\.PERCHANCE_PARTITION\);/);
    assert.match(codigo(PANEL), /process\.env\.MC_PCH_DIAG === '1'/);
    assert.match(codigo(PANEL), /app\.on\('web-contents-created', \(_e, wc\) => \{/);
    assert.match(codigo(PANEL), /wc\.mainFrame && wc\.mainFrame\.executeJavaScript/);
  });

  test('FIXADO: se fuerza el resolver nativo, y si falla solo avisa', () => {
    // Perchance suele meter Cloudflare con subdominios y no los resuelve; se
    // desactiva DoH aqui. Si algun build castiga, revisar primero el log antes
    // de quitar el try/catch.
    assert.match(codigo(PANEL), /try \{\s*app\.configureHostResolver\(\{ enableBuiltInResolver: true, secureDnsMode: 'off' \}\);/);
    assert.match(codigo(PANEL), /\} catch \(e\) \{\s*console\.warn\('\[perchance\] no pude forzar resolver nativo:/);
  });

  test('weakset de diagnostico registrado UNA VEZ por webContents', () => {
    assert.match(codigo(PANEL), /perchanceDiagInstalled\.has\(wc\)/);
    assert.match(codigo(PANEL), /perchanceDiagInstalled\.add\(wc\)/);
  });

  test('el panel de descargas se reenvia a la ventana principal', () => {
    assert.match(codigo(PANEL), /onEvent: \(ev\) => \{ try \{ getMainWin\(\)\?\.webContents\?\.send\('perchance:download', ev\); \} catch \{\} \}/);
  });
});