'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// net/doh.js hace require('electron'), asi que no se puede importar en un test
// de node plano. Estos tests leen el fuente y fijan invariantes que no se ven
// en un fallo de arranque: si alguien "ordena" los mapas, el test se entera
// aunque la app siga arrancando.
const FUENTE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'net', 'doh.js'),
  'utf8'
);

const cuerpo = (t) => FUENTE.slice(FUENTE.indexOf(t) + t.length, FUENTE.indexOf('};', FUENTE.indexOf(t)) + 2);

describe('net/doh.js — los dos mapas de servidores', () => {
  const wire = cuerpo('const DOH_SERVERS = ');
  const json = cuerpo('const servers = ');

  test('DOH_SERVERS (wire, para Chromium) cubre los 6 proveedores', () => {
    for (const p of ['cloudflare', 'google', 'quad9', 'nextdns', 'adguard', 'mullvad']) {
      assert.match(wire, new RegExp(`${p}:\\s*'https://`), `falta ${p} en DOH_SERVERS`);
    }
    assert.doesNotMatch(wire, /:\s*null/, 'DOH_SERVERS es el mapa de wire: no admite null');
  });

  test('el mapa JSON marca quad9 y mullvad como wire-only', () => {
    assert.match(json, /quad9:\s*null,/);
    assert.match(json, /mullvad:\s*null,/);
  });

  // Medido contra los proveedores: cloudflare-dns.com/resolve devuelve 404,
  // y /dns-query responde JSON cuando se pide con Accept: application/dns-json.
  // Por eso cloudflare NO esta en /resolve pese a que los demas si. Ponerlo
  // "para que cuadre" rompe el test del proveedor por defecto.
  test('cloudflare se queda en /dns-query, que es donde sí sirve JSON', () => {
    assert.match(json, /cloudflare:\s*'https:\/\/cloudflare-dns\.com\/dns-query'/);
    assert.doesNotMatch(json, /cloudflare[^,]*\/resolve/);
  });

  test('los proveedores con endpoint JSON propio usan /resolve', () => {
    for (const p of ['google', 'nextdns', 'adguard']) {
      assert.match(json, new RegExp(`${p}:\\s*'https://[^']+/resolve'`), `${p} deberia usar /resolve`);
    }
  });

  test('los dos mapas no se han unificado', () => {
    assert.notEqual(wire.trim(), json.trim());
    // Y el JSON no puede haber heredado las URLs de wire por accidente.
    assert.doesNotMatch(json, /dns\.quad9\.net/);
    assert.doesNotMatch(json, /dns\.mullvad\.net/);
  });
});

describe('net/doh.js — applyDoH', () => {
  test('se exporta y se llama desde los dos sitios de siempre', () => {
    assert.match(FUENTE, /module\.exports\s*=\s*\{[^}]*applyDoH[^}]*\}/s);

    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const loader = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'modules-loader.js'), 'utf8');
    const llamadas = [...(main + '\n' + loader).matchAll(/(?<![.\w])DoH\.applyDoH\(/g)];
    assert.equal(llamadas.length, 2, 'una al guardar cfg, otra al arrancar');
    // Y no debe quedar ninguna llamada sin calificar.
    assert.doesNotMatch(main, /(?<![.\w])applyDoH\(/);
  });

  test('configureHostResolver es global: los tres que lo llaman compiten', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const enMain = (main.match(/app\.configureHostResolver\s*\(\s*\{/g) || []).length;
    assert.ok(enMain >= 1, 'quedan llamadas en main.js (Perchance)');
    // Dos en applyDoH: la rama que configura el proveedor y la que lo apaga.
    // La cabecera tambien nombra la funcion, asi que se cuenta solo la llamada.
    assert.equal(
      (FUENTE.match(/app\.configureHostResolver\s*\(\s*\{/g) || []).length,
      2
    );
  });
});