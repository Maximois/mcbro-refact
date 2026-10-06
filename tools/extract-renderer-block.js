'use strict';
/**
 * tools/extract-renderer-block.js
 *
 * Corta un rango de lineas de src/renderer.html y lo deja tal cual en un
 * archivo JS nuevo, anadiendo el <script src> en el sitio exacto del corte.
 *
 * Existe para que la extraccion de la Fase 2 (docs/RESTRUCTURACION.md §7.0-§7.4)
 * no se haga nunca a mano: reescribir 6000 lineas de memoria es la forma mas
 * segura de que algo cambie sin que se note en la revision.
 *
 * Uso:
 *   node tools/extract-renderer-block.js --from 2350 --to 2399 \
 *        --out src/renderer/core/state.js --href ./renderer/core/state.js [--strict] [--append]
 *
 *   --from/--to  lineas 1-based e inclusivas de src/renderer.html (numeros de ANTES de cortar)
 *   --out        destino, relativo a la raiz del repo
 *   --href       valor del src= que se inserta en renderer.html (relativo a src/)
 *   --strict     anade 'use strict'; como primera linea del archivo nuevo
 *   --append     anade el rango a un archivo que ya existe; en ese caso no se
 *                vuelve a insertar la etiqueta <script src> si ya esta
 *
 * Garantias:
 *   - El cuerpo del archivo nuevo es exactamente el rango original: no se
 *     reordena, no se reindentan, no se corrigen espacios.
 *   - Se niega a cortar si el rango contiene una etiqueta <script>/</script>
 *     suelta (lo que estaria dentro de una plantilla con <\/script> escapado
 *     pasa, porque no es una etiqueta real).
 *   - Se niega si el archivo destino ya existe o si --from/--to esta fuera de
 *     rango.
 *
 * No ejecuta tests: despues corren `node --check`, `node --test` y el smoke.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'src', 'renderer.html');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

function fail(msg) {
  console.error(`FALLO: ${msg}`);
  process.exit(1);
}

const from = Number(arg('--from'));
const to = Number(arg('--to'));
const out = arg('--out');
const href = arg('--href');
const strict = process.argv.includes('--strict');
const append = process.argv.includes('--append');

if (!Number.isInteger(from) || !Number.isInteger(to)) fail('faltan --from y/o --to (enteros, 1-based)');
if (!out || !href) fail('faltan --out y/o --href');
if (from < 1 || to < from) fail(`rango invalido: --from ${from} --to ${to}`);

const text = fs.readFileSync(HTML, 'utf8');
if (Buffer.compare(Buffer.from(text, 'utf8'), fs.readFileSync(HTML)) !== 0) {
  fail('renderer.html no es UTF-8 valido; no se corta nada');
}

const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(eol);
if (to > lines.length) fail(`--to ${to} > lineas del archivo (${lines.length})`);

const block = lines.slice(from - 1, to);

// Etiquetas sueltas: solo cuentan las que estan solas en su linea; un
// '<script src=...>' dentro de un string o un '<\/script>' escapado no.
for (let i = 0; i < block.length; i++) {
  const t = block[i].trim();
  if (t === '<script>' || t === '</script>' || t === '<script' ) {
    fail(`el rango L${from}-L${to} contiene una etiqueta de script suelta (L${from + i}); rango mal calculado`);
  }
}

const outPath = path.join(ROOT, out);
if (fs.existsSync(outPath) && !append) fail(`el destino ya existe: ${out} (usa --append para anadir otro rango)`);

// El <script> que envuelve el bloque es la ultima apertura antes del corte.
let openIdx = -1;
for (let i = from - 2; i >= 0; i--) {
  if (lines[i].trim() === '<script>') { openIdx = i; break; }
}
if (openIdx === -1) fail('no se encontro la etiqueta <script> que envuelve el rango');

const yaExiste = fs.existsSync(outPath);
const existing = yaExiste ? fs.readFileSync(outPath, 'utf8') : '';
const body = (strict && !yaExiste ? `'use strict';${eol}` : '') + block.join(eol) + eol;
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, existing + body);

lines.splice(from - 1, to - from + 1);
const tag = `<script src="${href}"></script>`;
if (lines.some(l => l.trim() === tag)) {
  console.log(`    etiqueta ${tag} ya estaba insertada; no se duplica`);
} else {
  lines.splice(openIdx, 0, tag);
}
fs.writeFileSync(HTML, lines.join(eol));

const crypto = require('crypto');
const h = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);
const esperado = block.join(eol) + eol;
const escrito = fs.readFileSync(outPath, 'utf8');
const colado = escrito.endsWith(esperado);
console.log(`OK  rango L${from}-L${to} (${to - from + 1} lineas) -> ${out}${yaExiste ? ' (anadido)' : ''}`);
console.log(`    sha256 rango cortado ${h(esperado)} / cola del archivo escrito ${h(escrito.slice(-esperado.length))} ${colado ? '(iguales)' : '(DISTINTOS)'}`);
if (!colado) { console.error('FALLO: el rango no quedo tal cual al final del archivo'); process.exit(1); }
console.log(`    strict ${strict && !yaExiste ? 'anadido (la directiva se queda tambien en renderer.html)' : 'no tocado'}`);
console.log(`    renderer.html ${lines.length} lineas (antes ${text.split(eol).length})`);
