'use strict';
/**
 * tools/boot-smoke.js
 *
 * Arranca la aplicacion real (main.js y todo src/main/) dentro de Electron y
 * comprueba dos cosas: que la ventana anfitriona llega a cargar el renderer, y
 * que las rutas `[DATA]` apuntan al directorio del perfil de desarrollo y no al
 * de `npm start`. Lo segundo esta aqui porque el fallo que hubo fue justo ahi:
 * con el userData mal puesto, todo arrancaba bien y los datos iban a otra parte.
 *
 * No verifica comportamiento de la app: solo que el proceso principal arranca,
 * resuelve sus modulos, crea la ventana sin reventar, y deja los datos donde
 * deben.
 *
 * Por que el puerto de depuracion remoto: `did-finish-load` no se puede observar
 * desde fuera sin instrumentar main.js, y no queremos tocar main.js para una
 * prueba. El puerto expone la lista de targets de Chromium, que ya incluye la
 * ventana con su URL real.
 *
 * Uso:  node tools/boot-smoke.js [msDeEspera]      (por defecto 45000)
 * Salida: 0 si la ventana cargo y no hay errores fatales, 1 si no.
 *
 * QUE MIRA Y POR QUE
 * Que la ventana cargue NO basta. El proceso principal construye la ventana y
 * despues sigue registering sesiones e interceptores dentro de
 * app.whenReady(). Un ReferenceError en esa segunda mitad deja una ventana
 * perfectamente operativa sobre una app muerta: sin cookies, sin cabeceras,
 * sin proxy. Ese fallo salta como UnhandledPromiseRejectionWarning, que no
 * mata el proceso, asi que el smoke tendria que dar verde.
 *
 * Por eso ademas se busca en el log, y se falla si aparece:
 *   - ReferenceError / TypeError / SyntaxError
 *   - Cannot find module / MODULE_NOT_FOUND
 *   - UnhandledPromiseRejectionWarning
 * Un throw normal de una promesa ya manejada con catch no aparece aqui, asi que
 * los .catch(() => {}) legitimos del codigo no dan falso positivo.
 *
 * Ademas comprueba la CARPETA DE DATOS. main.js imprime una linea `[DATA]` con
 * userData y las tres rutas ya resueltas (cfg, history, bookmarks); si alguna no
 * cae dentro de la carpeta de la build, la app lee y escribe donde no debe. Ese
 * fallo no lanza nada: la app arranca, muestra la ventana y parece vacia.
 *
 * AVISO: usa la carpeta userData real de la build de desarrollo. No borra
 * datos ni sesiones. Cierra la instancia antes de correrlo: la app tiene
 * requestSingleInstanceLock(), y si otra ya esta corriendo esta segunda
 * instancia sale sola y el script da un falso negativo.
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = 9333 + (Number(process.env.MC_SMOKE_PORT_OFFSET) || 0);
const TIMEOUT_MS = Number(process.argv[2]) || 45000;

function fetchTargets() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 2000 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const child = spawn(String(electron), ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  });

  const logs = [];
  child.stdout.on('data', d => logs.push(String(d)));
  child.stderr.on('data', d => logs.push(String(d)));

  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  const deadline = Date.now() + TIMEOUT_MS;
  let ok = false;
  while (Date.now() < deadline) {
    if (exited) break;
    try {
      const targets = await fetchTargets();
      const page = targets.find(t => t.type === 'page' && /renderer\.html/.test(t.url || ''));
      if (page) { ok = true; break; }
    } catch { /* el puerto aun no escucha */ }
    await sleep(400);
  }

  try { child.kill(); } catch {}
  await sleep(600);
  try { child.kill('SIGKILL'); } catch {}

  const out = logs.join('');
  console.log('--- salida de Electron ---');
  console.log(out.trim() || '(vacia)');
  console.log('--- fin ---');

  // La ventana puede cargar y aun asi estar la app muerta a medias: lo que
  // falla despues de crearla sale como rechazo sin manejar, no como crash.
  const FATALES = [
    /UnhandledPromiseRejectionWarning/,
    /\bReferenceError\b/,
    /\bTypeError\b/,
    /\bSyntaxError\b/,
    /Cannot find (module|package)/,
    /MODULE_NOT_FOUND/,
  ];
  const errores = [];
  for (const linea of out.split(/\r?\n/)) {
    const t = linea.trim();
    if (!t) continue;
    if (FATALES.some(rx => rx.test(t))) errores.push(t);
  }

  // La carpeta de datos. main.js imprime una linea [DATA] con userData y las
  // tres rutas ya resueltas; si alguna no cae dentro de la carpeta esperada, la
  // app esta leyendo y escribiendo donde no debe. Es el fallo que mas dano hace
  // y el que menos se ve: la app arranca igual, solo que "olvido" los datos.
  const esperado = 'mc-browser-v2-dev';
  const lineaData = out.split(/\r?\n/).find(l => l.includes('[DATA]'));
  if (!lineaData) {
    errores.push('[DATA] main.js no imprimio la linea de rutas de datos');
  } else {
    const rutas = [...lineaData.matchAll(/(?:userData|cfg|history|bookmarks)=(\S+)/g)].map(m => m[1]);
    for (const r of rutas) {
      if (!r.includes(esperado)) errores.push(`[DATA] ruta fuera de ${esperado}: ${r}`);
    }
  }

  if (errores.length) {
    console.error(`FALLO: ${errores.length} error(es) fatal(es) durante el arranque:`);
    for (const e of [...new Set(errores)]) console.error(`  ${e}`);
    console.error('La ventana puede haber cargado, pero el proceso principal sigue roto.');
    process.exit(1);
  }

  if (ok) {
    console.log('OK: la ventana anfitriona cargo src/renderer.html');
    process.exit(0);
  }
  if (exited) {
    console.error(`FALLO: Electron salio antes de cargar (code=${exited.code} signal=${exited.signal})`);
  } else {
    console.error(`FALLO: no se vio renderer.html en el puerto ${PORT} tras ${TIMEOUT_MS} ms`);
  }
  console.error('Si ya hay otra instancia de MC Browser corriendo, cierrala: el bloqueo de');
  console.error('instancia unica hace que esta segunda salida salga de inmediato.');
  process.exit(1);
})();