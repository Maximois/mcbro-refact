'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

function handleHistoryMouseEvent(event) {
  if (!event.isTrusted || (event.button !== 3 && event.button !== 4)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.type === 'mousedown') {
    ipcRenderer.sendToHost('mc-history-nav', event.button === 3 ? 'back' : 'forward');
  }
}

for (const eventType of ['mousedown', 'mouseup', 'auxclick', 'click']) {
  window.addEventListener(eventType, handleHistoryMouseEvent, true);
}

contextBridge.exposeInMainWorld('__mcSelectionBridge', {
  send: (text) => {
    const value = String(text || '').trim();
    if (value.length >= 5 && value.length <= 500) {
      ipcRenderer.sendToHost('mc-selection', value);
    }
  },
  setHlsReferer: (token, referer) => ipcRenderer.invoke('streams:hls-player-referer', { token, referer }),
  setHlsEntryReferer: (token, referer) => ipcRenderer.invoke('streams:entry-referer', { token, referer })
});

// ── Anuncios de video de YouTube ────────────────────────────────────────────
// El anuncio de video viaja DENTRO del JSON del player de Innertube
// (adPlacements / playerAds / adSlots / adBreakParams) y su stream sale del
// mismo googlevideo.com que el video, asi que ninguna regla de red puede
// distinguirlo: bloquear dobleclick/pagead solo mata los display.
//
// Esta tecnica — la misma de json-prune en uBO/AdGuard — borra esos campos
// ANTES de que el player los lea, asi que el anuncio nunca se pide y no hay
// nada que saltar. Cubre los tres caminos por donde llega ese JSON:
//   1. el inline `var ytInitialPlayerResponse` de la carga fria (setter trap),
//   2. las respuestas de fetch a /youtubei/v1/player|get_watch|playlist,
//   3. lo mismo via XHR.
// Ademas agrega isInlinePlaybackNoAd al body de la petición /player y deja un
// ultimo recurso: si aun asi se monta un overlay, click en Saltar.
//
// webFrame.executeJavaScript corre en el MUNDO PRINCIPAL y salta el CSP de
// YouTube (nonce + strict-dynamic + require-trusted-types-for 'script'), que
// bloquearia la inyeccion via <script> del DOM.
const YT_AD_SCRIPT = `(() => {
  const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakParams', 'adBreakHeartbeatParams'];
  const PLAYER_PATHS = ['/youtubei/v1/player', '/youtubei/v1/get_watch', '/youtubei/v1/playlist'];

  function isPlayerUrl(url) {
    const s = String(url || '');
    for (let i = 0; i < PLAYER_PATHS.length; i++) {
      if (s.indexOf(PLAYER_PATHS[i]) !== -1) return true;
    }
    return false;
  }

  function trapKey(obj, key) {
    try {
      Object.defineProperty(obj, key, {
        configurable: true,
        get: function () { return undefined; },
        set: function () {}
      });
    } catch (e) {}
  }

  function harden(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    for (let i = 0; i < AD_KEYS.length; i++) trapKey(obj, AD_KEYS[i]);
    return obj;
  }

  // Rastro de diagnostico: si YouTube cambia el formato de /player (p. ej. a
  // application/x-protobuf) la poda deja de correr y el unico aviso que queda
  // es este. Ver window.__mcYtAdsLog en la consola del guest.
  function recordar(entry) {
    try {
      if (!window.__mcYtAdsLog) window.__mcYtAdsLog = [];
      window.__mcYtAdsLog.push(Object.assign({ t: Date.now() }, entry));
      if (window.__mcYtAdsLog.length > 50) window.__mcYtAdsLog.shift();
    } catch (e) {}
  }

  function prune(value) {
    // Devuelve true si borro algun campo de anuncio: el que llama puede
    // evitar el re-serializado (JSON.stringify + new Response) cuando no
    // habia nada que podar, que es el caso de casi todas las navegaciones.
    let cambiado = false;
    if (!value || typeof value !== 'object') return cambiado;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) { if (prune(value[i])) cambiado = true; }
      return cambiado;
    }
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (AD_KEYS.indexOf(key) !== -1) {
        try { delete value[key]; } catch (e) {}
        trapKey(value, key);
        cambiado = true;
      } else { if (prune(value[key])) cambiado = true; }
    }
    return cambiado;
  }

  function patchBody(body) {
    try {
      if (typeof body !== 'string' || body.charAt(0) !== '{') return body;
      const data = JSON.parse(body);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return body;
      data.isInlinePlaybackNoAd = true;
      return JSON.stringify(data);
    } catch (e) { return body; }
  }

  if (window.__mcYtAds) return;
  window.__mcYtAds = true;

  function refresh() {
    try {
      const current = window.ytInitialPlayerResponse;
      prune(current);
      harden(current);
    } catch (e) {}
  }

  try {
    const initial = window.ytInitialPlayerResponse;
    prune(initial);
    harden(initial);
    let holder = window.ytInitialPlayerResponse;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: function () { return holder; },
      set: function (next) { holder = next; prune(next); harden(next); }
    });
  } catch (e) {
    // La trampa no se pudo instalar (propiedad no configurable): YouTube puede
    // reescribir la respuesta entera despues, asi que hay que volver a podar en
    // cada punto de navegacion.
    window.addEventListener('load', refresh, { once: true });
    window.addEventListener('yt-navigate-finish', refresh);
  }

  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function () {
        const args = Array.prototype.slice.call(arguments);
        let url = '';
        try {
          const input = args[0];
          url = typeof input === 'string' ? input : (input && input.url) || '';
        } catch (e) {}
        if (isPlayerUrl(url) && args[1] && typeof args[1] === 'object' && typeof args[1].body === 'string') {
          try { args[1] = Object.assign({}, args[1], { body: patchBody(args[1].body) }); } catch (e) {}
        }
        return origFetch.apply(window, args).then(function (res) {
          try {
            const finalUrl = url || (res && res.url) || '';
            if (!isPlayerUrl(finalUrl)) return res;
            const type = res && res.headers ? (res.headers.get('content-type') || '') : '';
            if (!res || !res.ok) {
              recordar({ url: finalUrl, contentType: type || '(sin header)', json: false, status: res && res.status });
              return res;
            }
            if (type.indexOf('json') === -1) {
              recordar({ url: finalUrl, contentType: type || '(sin header)', json: false, status: res.status });
              console.warn('[MC-YT-ADS] ' + finalUrl + ' respondio "' + type + '" y no JSON: la poda no llego a correr. Ver window.__mcYtAdsLog');
              return res;
            }
            return res.clone().json().then(function (data) {
              const cambiado = prune(data);
              recordar({ url: finalUrl, contentType: type, json: true, pruned: cambiado });
              if (!cambiado) return res;
              return new Response(JSON.stringify(data), {
                status: res.status, statusText: res.statusText, headers: res.headers
              });
            }).catch(function (err) {
              recordar({ url: finalUrl, contentType: type, json: false, error: String(err) });
              console.warn('[MC-YT-ADS] fallo el parseo JSON de ' + finalUrl + ': ' + err);
              return res;
            });
          } catch (e) {}
          return res;
        });
      };
    }
  } catch (e) {}

  try {
    const proto = XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
    proto.open = function (method, url) {
      try { this.__mcYtUrl = String(url || ''); } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    proto.send = function () {
      try {
        if (isPlayerUrl(this.__mcYtUrl) && typeof arguments[0] === 'string') {
          arguments[0] = patchBody(arguments[0]);
        }
      } catch (e) {}
      if (isPlayerUrl(this.__mcYtUrl)) {
        this.addEventListener('load', function () {
          try {
            const dest = this.__mcYtUrl;
            let contentType = '';
            try { contentType = (this.getResponseHeader && this.getResponseHeader('content-type')) || ''; } catch (e) {}
            const type = this.responseType;
            if (type === 'json') {
              const cambiadoJson = prune(this.response);
              recordar({ url: dest, contentType: contentType || 'json', json: true, pruned: cambiadoJson });
              return;
            }
            if (type) {
              recordar({ url: dest, contentType: contentType || type, json: false });
              return;
            }
            const raw = this.responseText;
            if (!raw || raw.charAt(0) !== '{') {
              recordar({ url: dest, contentType: contentType || '(sin header)', json: false });
              return;
            }
            let data;
            try { data = JSON.parse(raw); } catch (err) {
              recordar({ url: dest, contentType: contentType || 'text', json: false, error: String(err) });
              return;
            }
            const cambiado = prune(data);
            if (cambiado) {
              const hacked = JSON.stringify(data);
              Object.defineProperty(this, 'responseText', { configurable: true, get: function () { return hacked; } });
              Object.defineProperty(this, 'response', { configurable: true, get: function () { return hacked; } });
            }
            recordar({ url: dest, contentType: contentType || 'text', json: true, pruned: cambiado });
          } catch (e) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  } catch (e) {}

  try {
    const SKIP = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .video-ads .ytp-ad-skip-button';
    const AD_UI = '#movie_player.ad-showing, .ytp-ad-player-overlay-layout, .ytp-ad-overlay-ad-container';
    // Anuncios del feed / busqueda / sidebar: llegan como contenido normal en
    // /browse, no via el player, asi que la poda de /player no los toca.
    const FEED_ADS = 'ytd-in-feed-ad-layout-renderer, ytd-ad-slot-renderer, ytd-ad-slot-header-renderer, ytd-promoted-video-renderer, ytd-display-ad-renderer, ytd-companion-slot-renderer, ytd-search-pyv-renderer';
    const AD_ITEM = 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer, ytd-in-feed-ad-layout-renderer, ytd-ad-slot-renderer';

    // El anuncio puede venir anidado (slot dentro de rich-item): hay que ocultar
    // el contenedor mas externo, no el renderer interno, para no dejar la celda
    // del grid vacia y fantasma.
    function envolventeAd(nodo) {
      try {
        if (!nodo || !nodo.closest) return null;
        let mejor = nodo.closest(AD_ITEM);
        if (!mejor) return null;
        while (mejor.parentElement && mejor.parentElement.closest) {
          const arriba = mejor.parentElement.closest(AD_ITEM);
          if (!arriba || arriba === mejor) break;
          mejor = arriba;
        }
        return mejor;
      } catch (e) { return null; }
    }

    function ocultarAd(nodo) {
      try {
        if (!nodo) return;
        if (nodo.style) nodo.style.setProperty('display', 'none', 'important');
        // si el anuncio del feed trae video, ocultar no corta el audio
        const media = (nodo.querySelectorAll && nodo.querySelectorAll('video,audio')) || [];
        for (let m = 0; m < media.length; m++) { if (media[m].pause) media[m].pause(); }
      } catch (e) {}
    }

    function limpiar() {
      try {
        const feed = document.querySelectorAll(FEED_ADS);
        for (let i = 0; i < feed.length; i++) ocultarAd(envolventeAd(feed[i]) || feed[i]);
        const badges = document.querySelectorAll('.ytBadgeShapeAd');
        for (let i = 0; i < badges.length; i++) ocultarAd(envolventeAd(badges[i]));
        if (!document.querySelector(AD_UI)) return;
        const btn = document.querySelector(SKIP);
        if (btn && btn.click) btn.click();
        const banner = document.querySelector('.ytp-ad-overlay-ad-container');
        if (banner) banner.style.display = 'none';
      } catch (e) {}
    }

    setInterval(limpiar, 150);
    window.addEventListener('yt-navigate-finish', limpiar);
  } catch (e) {}
})();`;

try {
  const host = String((typeof location !== 'undefined' && location.hostname) || '').toLowerCase();
  const isYouTube = host === 'youtube.com' || host.endsWith('.youtube.com')
    || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com');
  if (isYouTube) webFrame.executeJavaScript(YT_AD_SCRIPT, false).catch(() => {});
} catch {}
