'use strict';
/**
 * MC Browser -- src/main/net/doh.js
 *
 * DNS sobre HTTPS. Dos cosas distintas que viven aqui por ser el mismo tema:
 *
 *   applyDoH()    configura el resolver de Chromium con el proveedor elegido.
 *   resolve-doh   el IPC que el boton "probar" del panel usa para consultar una
 *                 IP de ejemplo y decir si el proveedor responde.
 *
* -----------------------------------------------------------------------------
 * TRAMPA 1 -- HAY DOS MAPAS DE SERVIDORES Y NO SE UNIFICAN
 * -----------------------------------------------------------------------------
 * \`DOH_SERVERS\` usa el endpoint \`/dns-query\` (formato wire RFC 8484). Es lo que
 * entiende \`app.configureHostResolver\`.
 *
 * El mapa \`servers\` de dentro de resolve-doh es para consultar por \`fetch\` y
 * parsear la respuesta, asi que usa el endpoint JSON de cada proveedor. Y aqui
 * estan medidos, no supuestos:
 *
 *   cloudflare /dns-query   HTTP 200, JSON ok      <- el unico que sirve JSON
 *   cloudflare /resolve     HTTP 404               en /dns-query
 *   google    /resolve      HTTP 200, JSON ok
 *   adguard   /resolve      HTTP 200, JSON ok
 *   nextdns   /resolve      HTTP 200, JSON ok
 *
 * Cloudflare no tiene /resolve: content-negocian en /dns-query y devuelven JSON
 * cuando la cabecera dice \`Accept: application/dns-json\`, que es justo lo que
 * manda resolve-doh. Por eso ese mapa pone cloudflare en /dns-query y no en
 * /resolve: ponerlo "para que cuadre con los demas" devuelve un 404.
 *
 * quad9 y mullvad estan en \`null\` en ese mapa porque no sirven DNS-over-HTTPS en
 * JSON, solo en wire. El test lo dice con \`{ code: 'wire-only' }\` en vez de
 * fingir que funcionan. La app si los usa para resolver de verdad, por eso estan
 * completos en \`DOH_SERVERS\`.
 *
 * No unificar los dos mapas: un endpoint equivocado rompe una de las dos mitades.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- configureHostResolver es GLOBAL, no por sesion
 * -----------------------------------------------------------------------------
 * Tres sitios de la app lo llaman y todos compiten por el MISMO ajuste:
 *   1. setupPerchancePanel()   -> secureDnsMode: 'off'
 *   2. el bloque de Perchance en whenReady -> secureDnsMode: 'off'
 *   3. applyDoH()              -> 'secure' / 'automatic', o 'off' si esta apagado
 *
 * applyDoH() se ejecuta AL FINAL de whenReady, asi que GANA. Con DoH activado,
 * el resolver seguro global que el comentario de Perchance dice querer evitar le
 * vuelve a ser aplicado encima. Preexistente, no se corrige aqui: solo se anota.
 *
 * -----------------------------------------------------------------------------
* TRAMPA 3 -- cleanbrowsing no existe en ninguno de los dos mapas
 * -----------------------------------------------------------------------------
 * \`CFG_DOH_SERVERS\` (validacion, en config/index.js) acepta 'cleanbrowsing', pero
 * el <select> del renderer no lo ofrece y este archivo no tiene su URL. Si
 * llegara a colarse en cfg.json, \`DOH_SERVERS[CFG.dohServer]\` seria undefined y
 * \`applyDoH\` caeria en Cloudflare sin avisar. El mismo \`|| servers.cloudflare\`
 * en resolve-doh haria lo propio. El <select> del renderer es la lista real de
 * proveedores; \`CFG_DOH_SERVERS\` esta mas Generoso que la realidad.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 4 -- el reintento de resolve-doh comparte el mismo AbortController
 * -----------------------------------------------------------------------------
 * Son 2 intentos, pero solo uno de 8 s en total: el setTimeout se crea una vez,
 * antes del bucle, y el clearTimeout esta en el finally de los DOS. El segundo
 * intento no tiene presupuesto propio.
 *
 * Solo reintenta ante 408 / 429 / >=500, y el `attempt === 1` del break impide
 * que el bucle siga. Un 404 sale sin reintentar, que es lo correcto.
 */

const { app, ipcMain } = require('electron');
const { CFG } = require('../config');



// === DoH server URL map ===
const DOH_SERVERS = {
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/dns-query',
  quad9: 'https://dns.quad9.net/dns-query',
  nextdns: 'https://dns.nextdns.io/dns-query',
  adguard: 'https://dns.adguard.com/dns-query',
  mullvad: 'https://dns.mullvad.net/dns-query',
};

function applyDoH() {
  try {
    if (CFG.dohEnabled) {
      const url = DOH_SERVERS[CFG.dohServer] || DOH_SERVERS.cloudflare;
      app.configureHostResolver({
        enableBuiltInResolver: true,
        secureDnsMode: CFG.dohStrict !== false ? 'secure' : 'automatic',
        secureDnsServers: [url]
      });
      return;
    }
    app.configureHostResolver({ secureDnsMode: 'off' });
  } catch (e) { console.error('[DoH]', e.message); }
}

// DoH
ipcMain.handle('resolve-doh', async (e, host) => {
  const normalizedHost = String(host || '').trim().replace(/\.$/, '').toLowerCase();
  if (!normalizedHost || normalizedHost.length > 253 || !/^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalizedHost)) {
    return { ok: false, error: 'dominio inválido', code: 'invalid-host' };
  }
  try {
    const servers = {
      cloudflare: 'https://cloudflare-dns.com/dns-query',
      google: 'https://dns.google/resolve',
      quad9: null,
      nextdns: 'https://dns.nextdns.io/resolve',
      adguard: 'https://dns.adguard.com/resolve',
      mullvad: null,
    };
    const provider = CFG.dohServer || 'cloudflare';
    if (servers[provider] === null) {
      return { ok: false, error: `${provider === 'quad9' ? 'Quad9' : 'Mullvad'} requiere DoH wire format por HTTP/2`, code: 'wire-only' };
    }
    const url = servers[provider] || servers.cloudflare;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        res = await fetch(`${url}?name=${encodeURIComponent(normalizedHost)}&type=A`, {
          method: 'GET', headers: { 'Accept': 'application/dns-json' }, signal: controller.signal
        });
        if (!(res.status === 408 || res.status === 429 || res.status >= 500) || attempt === 1) break;
      }
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const error = res.status === 505
        ? 'requiere HTTP/2 y formato wire RFC 8484'
        : `HTTP ${res.status}`;
      return { ok: false, error, code: res.status === 505 ? 'http2-required' : 'http-error' };
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch { return { ok: false, error: 'el servidor no soporta el test JSON', code: 'invalid-json' }; }
    const a = (data.Answer || []).find(x => x.type === 1);
    if (!a || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(a.data || ''))) return { ok: false, error: 'sin respuesta A', code: 'no-answer' };
    return { ok: true, ip: a.data };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'tiempo de espera agotado (8 s)' : 'no se pudo conectar con el proveedor', code: e.name === 'AbortError' ? 'timeout' : 'network-error' };
  }
});


module.exports = {
  DOH_SERVERS,
  applyDoH,
};
