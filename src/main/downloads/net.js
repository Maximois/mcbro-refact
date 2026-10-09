'use strict';
/**
 * MC Browser -- src/main/downloads/net.js
 *
 * Cliente HTTP minimo del motor de descargas: GET con seguimiento de
 * redirects reenviando las cabeceras (incluida Range) en cada salto.
 * Devuelve { res, url, status }; el cuerpo hay que drenarlo o consumirlo.
 *
 * Lo comparten el reanudador por Range (native.js) y los extractores que
 * necesitan volver a pedir una pagina para renovar un enlace (mediafire.js).
 */

const http = require('http');
const https = require('https');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 MCBrowser';

function fetchWithRedirects(url, { headers = {}, maxRedirects = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const run = (target, depth) => {
      let mod;
      try { mod = String(target).startsWith('https:') ? https : http; } catch { return reject(new Error('URL invalida')); }
      const req = mod.request(target, { method: 'GET', headers }, (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && depth < maxRedirects) {
          res.resume();
          const loc = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
          let next = '';
          try { next = new URL(loc, target).toString(); } catch { return reject(new Error('redirect invalido')); }
          return run(next, depth + 1);
        }
        resolve({ res, url: target, status });
      });
      req.setTimeout(30000, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    };
    run(url, 0);
  });
}

module.exports = { BROWSER_UA, fetchWithRedirects };