'use strict';
/**
 * MC Browser -- src/main/downloads/extractors/mediafire.js
 *
 * Extractor del host MediaFire: sabe renovar el enlace directo (re-mint).
 * Los enlaces free de MediaFire expiran: el directo viejo devuelve 200/HTML.
 * Se vuelve a pedir la pagina, se saca el quickKey de /file/<key>/ y se extrae
 * un download<server>.mediafire.com fresco (regex directa o JSON de la pagina).
 *
 * Contrato de extractor: exporta { name, match(url), mint?(fileUrl) }.
 *   match(url)  -> true si el host le corresponde.
 *   mint(url)   -> promesa con el directo fresco o null si no se pudo renovar.
 *   Sin mint    -> el reanudador usa la URL original (generico).
 */

const { BROWSER_UA, fetchWithRedirects } = require('../net');

const MEDIAFIRE_HOST_RE = /(^|\.)mediafire\.com$/i;

function match(u) {
  try { return MEDIAFIRE_HOST_RE.test(new URL(u).hostname); } catch { return false; }
}

// Extrae un directo de download<server>.mediafire.com del HTML de la pagina.
// Si la pagina ya expuso el JSON (hash/server/filename), arma la URL directa.
function extractDirectUrl(html, quickKey) {
  const re = /https?:\/\/download[0-9]+(?:-[a-z0-9]+)?\.mediafire\.com\/[^\s"'<>\\]+/gi;
  const m = String(html).match(re);
  if (m && m.length) return m[0].replace(/&amp;/g, '&');
  if (quickKey) {
    const hash = String(html).match(/"hash"\s*:\s*"([^"]+)"/i) || String(html).match(/"hash":"([^"]+)"/i);
    const server = String(html).match(/"server"\s*:\s*["']?([0-9]+)/i) || String(html).match(/"server":([0-9]+)/i);
    const fname = String(html).match(/"filename"\s*:\s*"([^"]+)"/i) || String(html).match(/"filename":"([^"]+)"/i);
    if (hash && server) {
      const fn = fname ? encodeURIComponent(fname[1]) : quickKey;
      return `https://download${server[1]}.mediafire.com/${hash[1]}/${quickKey}/${fn}`;
    }
  }
  return null;
}

// fileUrl: la URL original (pagina /file/<key>/ o directa). Devuelve un
// directo fresco o null si no se pudo renovar.
function mint(fileUrl) {
  return new Promise((resolve) => {
    let quickKey = '';
    try {
      const seg = String(fileUrl).split('/');
      const idx = seg.findIndex((s) => s === 'file');
      if (idx > -1 && seg[idx + 1]) quickKey = seg[idx + 1];
    } catch {}
    fetchWithRedirects(fileUrl, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,application/json,*/*' }
    }).then(({ res, status }) => {
      if (status !== 200) { res.resume(); return resolve(null); }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; if (buf.length > 3e6) res.destroy(); });
      res.on('end', () => resolve(extractDirectUrl(buf, quickKey)));
      res.on('error', () => resolve(null));
    }).catch(() => resolve(null));
  });
}

module.exports = { name: 'mediafire', match, mint };