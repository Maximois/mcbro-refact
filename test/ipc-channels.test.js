'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');

function jsDelProcesoPrincipal() {
  const out = [path.join(RAIZ, 'main.js')];
  const recorrer = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  recorrer(path.join(RAIZ, 'src', 'main'));
  return out;
}

// ipcMain.handle / on / once / removeHandler. Electron lanza al arrancar si dos
// llamadas registran el mismo canal, asi que un duplicado no es un aviso: es un
// fallo de arranque que solo aparece en la app real.
const RE = /ipcMain\s*\.\s*(handle|on|once|removeHandler)\s*\(\s*['"`]([^'"`]+)['"`]/g;

describe('canales IPC del proceso principal', () => {
  const registros = [];
  for (const abs of jsDelProcesoPrincipal()) {
    const rel = path.relative(RAIZ, abs);
    fs.readFileSync(abs, 'utf8').split(/\r?\n/).forEach((linea, i) => {
      RE.lastIndex = 0;
      let m;
      while ((m = RE.exec(linea))) registros.push({ metodo: m[1], canal: m[2], donde: `${rel}:${i + 1}` });
    });
  }

  test('se encuentra una base razonable que comparar', () => {
    assert.ok(registros.length > 80, `solo ${registros.length} registros IPC; el patron no esta leyendo bien`);
  });

  test('ningun canal se registra dos veces', () => {
    const porCanal = new Map();
    for (const r of registros) {
      // handle y removeHandler conviven bien; lo que no puede repetirse es la
      // misma llamada dos veces sobre el mismo canal.
      const clave = `${r.metodo}:${r.canal}`;
      if (!porCanal.has(clave)) porCanal.set(clave, []);
      porCanal.get(clave).push(r.donde);
    }
    const duplicados = [...porCanal].filter(([, donde]) => donde.length > 1);
    assert.deepEqual(
      duplicados.map(([clave, donde]) => `${clave} en ${donde.join(' y ')}`),
      [],
      'Electron lanza al arrancar si un canal se registra dos veces'
    );
  });

  test('los canales de stats viven en el modulo que es su dueno', () => {
    const de = canal => registros.filter(r => r.canal === canal).map(r => r.donde);
    assert.match(de('get-stats')[0], /^src[\\/]main[\\/]stats[\\/]tracker\.js:/);
    assert.match(de('reset-stats')[0], /^src[\\/]main[\\/]stats[\\/]tracker\.js:/);
    assert.match(de('get-media')[0], /^src[\\/]main[\\/]stats[\\/]tracker\.js:/);
assert.match(de('get-blocked-hosts')[0], /^src[\\/]main[\\/]stats[\\/]tracker\.js:/);
      assert.match(de('get-sysinfo')[0], /^src[\\/]main[\\/]stats[\\/]process-metrics\.js:/);
  });
});