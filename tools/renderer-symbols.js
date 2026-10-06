'use strict';
/**
 * tools/renderer-symbols.js
 *
 * Inventario de simbolos del renderer. Existe para poder mover el codigo de
 * src/renderer.html a archivos sueltos sin perder nada por el camino: el
 * inventario se toma UNA vez con el archivo intacto, se guarda como fixture, y
 * desde entonces cualquier simbolo que desaparezca hace fallar el test.
 *
 * Que cuenta (y por que exactamente eso):
 *   - functions:  declaraciones `function X` / `async function X` a nivel de
 *     columna 0. Es el estilo del archivo, asi que no exige interpretar nada.
 *   - globals:    `const`/`let`/`var` a nivel de columna 0. Re-declarar uno de
 *     estos en dos archivos clasicos es SyntaxError en tiempo de evaluacion.
 *   - windowExports: `window.X = ...` en cualquier posicion (no solo columna 0,
 *     porque envoltorios como hookPermissionsRefresh() reasignan dentro de una
 *     funcion): lo que el HTML y modules/* ven desde fuera del script.
 *   - handlers:   identificadores invocados desde atributos on*="..." tanto del
 *     markup como de los templates de JS, con la lista de keywords excluida.
 *     Despues de la extraccion esos templates viven en src/renderer/*.js, por
 *     eso se escanean TODAS las fuentes y no solo renderer.html.
 *
 * Uso:
 *   node tools/renderer-symbols.js            -> imprime el inventario (stdout)
 *   node tools/renderer-symbols.js --write    -> escribe test/fixtures/renderer-symbols.json
 *
 * Ojo: `node --check` no valida referencias libres, por eso existe este test.
 * Un archivo puede pasar `node --check` llamando a una funcion que ya no existe.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'renderer-symbols.json');

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof',
  'new', 'await', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'throw',
]);

function listJsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}

function namesOf(text, rx) {
  const out = new Set();
  for (const m of text.matchAll(rx)) out.add(m[1]);
  return out;
}

function collect() {
  const htmlPath = path.join(ROOT, 'src', 'renderer.html');
  const jsFiles = listJsFiles(path.join(ROOT, 'src', 'renderer'));
  const sources = [htmlPath, ...jsFiles];

  const functions = new Set();
  const globals = new Set();
  const windowExports = new Set();
  const handlers = new Set();
  const files = {};

  for (const p of sources) {
    const text = fs.readFileSync(p, 'utf8');
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');
    files[rel] = text.split(/\r?\n/).length;

    for (const n of namesOf(text, /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) functions.add(n);
    for (const n of namesOf(text, /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) globals.add(n);
    for (const n of namesOf(text, /window\.([A-Za-z_$][\w$]*)\s*=/g)) windowExports.add(n);

    for (const m of text.matchAll(/on(?:click|change|keydown|input)="((?:[^"\\]|\\.)*)"/g)) {
      for (const c of m[1].matchAll(/(?<![\w.$])([A-Za-z_]\w{2,})\s*\(/g)) {
        if (!KEYWORDS.has(c[1])) handlers.add(c[1]);
      }
    }
  }

  const sort = s => [...s].sort();
  return {
    generatedAt: new Date().toISOString(),
    files,
    functions: sort(functions),
    globals: sort(globals),
    windowExports: sort(windowExports),
    handlers: sort(handlers),
  };
}

if (require.main === module) {
  const inv = collect();
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify(inv, null, 2) + '\n');
    console.log(`fixture escrita: ${path.relative(ROOT, FIXTURE)}`);
  }
  console.log(JSON.stringify({
    files: inv.files,
    functions: inv.functions.length,
    globals: inv.globals.length,
    windowExports: inv.windowExports.length,
    handlers: inv.handlers.length,
  }, null, 2));
}

module.exports = { collect, FIXTURE };
