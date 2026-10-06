'use strict';
/**
 * tools/renderer-globals-smoke.js
 *
 * Arranca la app real y comprueba DENTRO de la pagina que ciertos globales del
 * renderer existen y tienen el tipo esperado. Es la pieza que le falta a
 * boot-smoke.js para la Fase 2 de docs/RESTRUCTURACION.md: mover un bloque a
 * un <script src> nuevo puede dejar la pagina cargando perfectamente con un
 * fichero que no se descarga, y eso boot-smoke no lo ve (solo mira errores
 * fatales y el [DATA]). Aqui se evalua `typeof X` en el contexto de la pagina,
 * asi que un fichero que no se descarga o que no llega a ejecutarse sale aqui.
 *
 * Ojo: los `const` de nivel superior (state, Sessions, LAB_TEMPLATES...) son
 * globales lexicos: existen como `state` pero NO como `window.state`. Por eso
 * se evalua el identificador a pelo y no `globalThis[n]`.
 *
 * Ademas recoge excepciones no capturadas y errores de red de la pagina
 * (favicon, un script que falle, etc.) y falla si aparecen.
 *
 * Uso:
 *   node tools/renderer-globals-smoke.js [nombre1 nombre2 ...]
 *   node tools/renderer-globals-smoke.js --timeout 60000 state ENGINES
 *
 * Por defecto mira `state`. Salida 0 si todo existe, 1 si no.
 * Mismo aviso que boot-smoke: cierra la app antes de correrlo (single instance).
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = 9343 + (Number(process.env.MC_SMOKE_PORT_OFFSET) || 0);
const args = process.argv.slice(2);
const timeoutIdx = args.indexOf('--timeout');
const TIMEOUT_MS = timeoutIdx === -1 ? 45000 : Number(args[timeoutIdx + 1]);
const NAMES = (timeoutIdx === -1 ? args : args.filter((_, i) => i !== timeoutIdx && i !== timeoutIdx + 1));
if (!NAMES.length) NAMES.push('state');

const okName = /^[A-Za-z_$][\w$]*$/;
for (const n of NAMES) {
  if (!okName.test(n)) { console.error(`FALLO: '${n}' no es un identificador valido`); process.exit(1); }
}

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

function cdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = cdp._id = (cdp._id || 0) + 1;
    const onMsg = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id === id) {
        ws.removeEventListener('message', onMsg);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

(async () => {
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const child = spawn(String(electron), ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  });

  const logs = [];
  child.stdout.on('data', d => logs.push(String(d)));
  child.stderr.on('data', d => logs.push(String(d)));
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  const deadline = Date.now() + TIMEOUT_MS;
  let page = null;
  while (Date.now() < deadline && !page && !exited) {
    try {
      const targets = await fetchTargets();
      page = targets.find(t => t.type === 'page' && /renderer\.html/.test(t.url || '')) || null;
    } catch { /* aun no escucha */ }
    if (!page) await sleep(400);
  }

  const problemas = [];
  let tipos = null;

  if (page) {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const excepciones = [];
    ws.addEventListener('message', ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        excepciones.push(`${d.text}${d.exception ? ' ' + (d.exception.description || '').split('\n')[0] : ''}`);
      }
      if (msg.method === 'Log.entryAdded' && ['error', 'warning'].includes(msg.params.entry.level)) {
        const e = msg.params.entry;
        if (/Failed to load resource|ERR_FILE_NOT_FOUND|ERR_FAILED/.test(e.text)) {
          excepciones.push(`${e.text}${e.url ? ' ' + e.url : ''}`);
        }
      }
    });
    await cdp(ws, 'Runtime.enable');
    await cdp(ws, 'Log.enable');

    // El target aparece en /json/list al EMPEZAR la navegacion, con lo que una
    // evaluacion inmediata corre antes de que se ejecuten los <script>. Se
    // espera a readyState complete (y a que state, que es lo primero del
    // inline, exista) antes de mirar nada.
    // (Si un script no llegara a cargarse, readyState complete tambien llega:
    // por eso el estado de `state` no se mira aqui, se mira en la evaluacion
    // final y ahi si se reporta como fallo.)
    let listo = false;
    while (Date.now() < deadline && !listo) {
      try {
        const probe = await cdp(ws, 'Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        });
        listo = probe.result.value === 'complete';
      } catch { /* contexto cambiando */ }
      if (!listo) await sleep(300);
    }

    const expr = `JSON.stringify({${NAMES.map(n => `${n}: typeof ${n}`).join(',')}})`;
    try {
      const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true });
      tipos = JSON.parse(r.result.value);
    } catch (e) {
      problemas.push(`no se pudo evaluar en la pagina: ${e.message}`);
    }
    await sleep(1500);
    if (excepciones.length) problemas.push(...excepciones);
    try { ws.close(); } catch {}
  }

  try { child.kill(); } catch {}
  await sleep(600);
  try { child.kill('SIGKILL'); } catch {}

  if (exited && exited.code !== null && !page) {
    console.error(`FALLO: Electron salio antes de cargar (code=${exited.code})`);
  }

  if (tipos) {
    console.log('globales en la pagina:');
    for (const n of NAMES) console.log(`  typeof ${n} = ${tipos[n]}`);
    for (const n of NAMES) {
      if (tipos[n] === 'undefined') problemas.push(`'${n}' no existe en la pagina (script no cargado o no evaluado)`);
    }
  } else if (!problemas.length) {
    problemas.push('no se vio renderer.html en el puerto ' + PORT);
  }

  if (problemas.length) {
    console.error('FALLO:');
    for (const p of [...new Set(problemas)]) console.error('  ' + p);
    process.exit(1);
  }
  console.log('OK: globales presentes y sin errores de carga en la pagina');
  process.exit(0);
})();
