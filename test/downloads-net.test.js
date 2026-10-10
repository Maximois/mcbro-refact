'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const PATH_NET = require('node:path').join(__dirname, '..', 'src', 'main', 'downloads', 'net.js');
const PATH_MF = require('node:path').join(__dirname, '..', 'src', 'main', 'downloads', 'extractors', 'mediafire.js');
const PATH_G = require('node:path').join(__dirname, '..', 'src', 'main', 'downloads', 'extractors', 'generic.js');

// Servidor local con soporte de Range (206) y un redirect 302 que reenvía
// cabeceras (incluida Range). Servir desde la memoria: el cuerpo se reensambla
// de trozos para verificar el byte exacto.
const BODY = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(64));
let server;
let port;

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url.startsWith('/redir')) {
        res.writeHead(302, { Location: '/file.bin' });
        res.end();
        return;
      }
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : BODY.length - 1;
          if (start >= BODY.length) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + BODY.length });
            res.end();
            return;
          }
          const slice = BODY.subarray(start, end + 1);
          res.writeHead(206, {
            'Content-Type': 'application/octet-stream',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${start + slice.length - 1}/${BODY.length}`,
            'Content-Length': slice.length
          });
          res.end(slice);
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': BODY.length });
      res.end(BODY);
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
}

let net;
before(() => startServer().then(() => { net = require(PATH_NET); }));
after(() => new Promise((r) => server.close(r)));

function url(p) { return `http://127.0.0.1:${port}${p}`; }

describe('downloads/net.js + extractors - funcional (servidor local)', () => {
  test('fetchWithRedirects sigue el redirect y reenvía la cabecera Range', async () => {
    const { res, status, url: fin } = await net.fetchWithRedirects(url('/redir'), {
      headers: { Range: 'bytes=10-', 'User-Agent': net.BROWSER_UA }
    });
    assert.equal(fin, url('/file.bin'));
    assert.equal(status, 206);
    const cr = res.headers['content-range'];
    assert.match(cr, /^bytes 10-\d+\/\d+$/);
  });

  test('un 206 reensambla exactamente desde el byte pedido', async () => {
    const start = 10;
    const { res, status } = await net.fetchWithRedirects(url('/file.bin'), {
      headers: { Range: `bytes=${start}-`, 'User-Agent': net.BROWSER_UA }
    });
    assert.equal(status, 206);
    const chunks = [];
    for await (const c of res) chunks.push(c);
    const joined = Buffer.concat(chunks);
    assert.deepEqual(joined, BODY.subarray(start));
    assert.equal(joined.length, BODY.length - start);
  });

  test('un 200 (sin Range) entrega el cuerpo entero', async () => {
    const { res, status } = await net.fetchWithRedirects(url('/file.bin'), {
      headers: { 'User-Agent': net.BROWSER_UA }
    });
    assert.equal(status, 200);
    const chunks = [];
    for await (const c of res) chunks.push(c);
    assert.equal(Buffer.concat(chunks).length, BODY.length);
  });

  test('un 416 (byte mas alla del total) llega tal cual para el cierre como done', async () => {
    const { res, status } = await net.fetchWithRedirects(url('/file.bin'), {
      headers: { Range: 'bytes=' + BODY.length + '-', 'User-Agent': net.BROWSER_UA }
    });
    assert.equal(status, 416);
    res.resume();
  });

  test('mediafire/generic matchean sin red', () => {
    const mf = require(PATH_MF);
    const g = require(PATH_G);
    assert.equal(mf.name, 'mediafire');
    assert.equal(typeof mf.mint, 'function');
    assert.equal(mf.match('https://www.mediafire.com/file/x/y'), true);
    assert.equal(mf.match('https://download2390.mediafire.com/abcdef/x/y'), true);
    assert.equal(mf.match('https://pixeldrain.com/u/x'), false);
    assert.equal(g.name, 'generic');
    assert.equal(g.match('https://pixeldrain.com/api/file/x?download'), true);
    assert.equal(g.match('http://x.com/a.bin'), true);
    assert.equal(g.match('ftp://x.com/a.bin'), false);
  });
});