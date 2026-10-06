'use strict';
/*
 * MC Browser -- tools/build-installer.js
 *
 * Genera el instalador de Windows con un nombre que diga de que build es.
 *
 *   npm run dist        -> wrapper: nombre con fecha y hora
 *   npm run dist:raw    -> electron-builder directo, nombre por defecto
 *
 * El nombre por defecto de package.json es "MC Browser Setup.exe". Eso solo no
 * alcanza: dos builds del mismo dia se confunden. Por eso este script mete un
 * sello de fecha y hora, y avisa si el arbol de git esta sucio, que es justo
 * cuando el nombre importa mas.
 *
 * NO se toca nada fuera de la carpeta del repo. No arranca la app.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));

function pad(n, largo) {
  return String(n).padStart(largo || 2, '0');
}

// Fecha + hora, sin segundos: "20261006-0107". Suficiente para distinguir
// dos builds del mismo dia sin alargar el nombre.
function sello(now) {
  const d = now || new Date();
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes())
  );
}

function estadoGit() {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: RAIZ, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return { sucio: null, commit: null, cortos: null };
  const rev = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: RAIZ, encoding: 'utf8' });
  return {
    sucio: r.stdout.trim().length > 0,
    commit: rev.status === 0 ? rev.stdout.trim() : null,
    cortos: r.stdout.trim().split(/\r?\n/).length
  };
}

function nombreArchivo(artifactName) {
  const nsis = path.join(RAIZ, 'dist', artifactName);
  const yml = path.join(RAIZ, 'dist', 'latest.yml');
  return [nsis, nsis + '.blockmap', yml].filter((p) => fs.existsSync(p));
}

const soloRaw = process.argv.includes('--raw');
const stamp = sello();
const git = estadoGit();

// Sin numero de version a proposito: en un instalador ya instalado la version
// no ayuda a distinguir builds, y el sello de fecha es lo unico que importa
// para saber cual se instalo.
const artifactName = 'MC Browser Setup-' + stamp + '.exe';

console.log('=== build de MC Browser ===');
console.log('  version (package.json) : ' + pkg.version);
console.log('  sello de build         : ' + stamp);
if (git.commit) console.log('  commit                 : ' + git.commit);
if (git.sucio === true) {
  console.log('  AVISO: git sucio (' + git.cortos + ' archivos con cambios)');
  console.log('         este instalador NO corresponde a ningun commit.');
} else if (git.sucio === false) {
  console.log('  git limpio');
}
console.log('  nombre                 : ' + artifactName);

if (soloRaw) {
  console.log('\n  (modo --raw: nombre por defecto de package.json)');
  process.exit(0);
}

const args = ['--win', '--config.artifactName=' + artifactName];
console.log('\n  ejecutando electron-builder');
console.log('  (puede tardar 1-3 minutos)\n');

// Se invoca con `node` y sin shell a proposito: el nombre tiene espacios y con
// shell:true en Windows cmd parte el argumento en varios y electron-builder
// responde "Unknown arguments: Browser, Setup-...exe".
const cli = require.resolve('electron-builder/out/cli/cli.js');
const r = spawnSync(process.execPath, [cli].concat(args), {
  cwd: RAIZ,
  stdio: 'inherit'
});

if (r.status !== 0) {
  console.error('\n  FALLO: electron-builder salio con codigo ' + r.status);
  process.exit(r.status || 1);
}

console.log('\n=== instalador generado ===');
const hechos = nombreArchivo(artifactName);
if (!hechos.length) {
  console.error('  no se encuentra el archivo en dist/. Revisa la salida de arriba.');
  process.exit(1);
}
hechos.forEach((p) => {
  const mb = (fs.statSync(p).size / 1048576).toFixed(2);
  console.log('  dist/' + path.basename(p) + '   ' + mb + ' MB');
});