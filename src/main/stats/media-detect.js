'use strict';
/**
 * MC Browser -- src/main/stats/media-detect.js
 *
 * El "stream hunter": detecta URLs de medios que carga una pagina y avisa al
 * renderer. Es lo que alimenta el Stream Hunter.
 *
 * QUE HACE
 *   checkMedia(url, pageUrl, resourceType) — el filtro y el aviso.
 *
 * QUE NO DEBE HACER
 *   - No decide si el medio se descarga. Eso es src/main/downloads/.
 *   - No guarda el catalogo. MEDIA_URLS y los contadores son de tracker.js; aqui
 *     se les pide que guarden (recordDetectedMedia) y consulten
 *     (alreadyDetectedMedia). Asi la dependencia va en una sola direccion y
 *     'reset-stats' puede vaciar el catalogo sin que este modulo sepa del IPC.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- nivel de modulo, no dentro de whenReady
 * -----------------------------------------------------------------------------
 * A proposito: asi tanto la sesion principal como cada sesion aislada
 * (setupExtraSession) pueden pasarla como mediaCallback y tener el Stream Hunter
 * funcionando igual en las dos. Mismo razonamiento que
 * registerNativeDownloadHandler.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- el filtro es una cascada de descartes, en este orden
 * -----------------------------------------------------------------------------
 * YouTube -> extensiones de pagina -> favicons -> segmentos HLS sueltos ->
 * rangos parciales -> "esto no parece media". El orden importa: los segmentos
 * .ts y los rangos por byte tienen que caer ANTES del test de token, o cada
 * segmento de un HLS contaria como un medio distinto.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 3 -- MEDIA_RE tambien se exporta
 * -----------------------------------------------------------------------------
 * Las tres regex vivian en main.js con un banner "Stream / Media detection".
 * Ahora viven aqui y se exportan, porque streams/capture.js y las descargas
 * necesitan el mismo criterio de "esto es media". Hay un solo patron.
 */

const { CFG } = require('../config');
const { ACTIONS } = require('../runtime');
const StatsTracker = require('./tracker');

const MEDIA_RE = /\.(m3u8|mp4|webm|mpd|ts|m4s|mkv|avi|mov)(\?|#|$)/i;
const HLS_RE   = /\.m3u8(\?|#|$)/i;
const SKIP_EXT_RE = /\.(html?|php|aspx?|jsp|json|xml|css|js|svg|woff2?|ttf|eot)(\?|#|$)/i;



// ── Media detection (stream hunter) ─────────────────
// Nivel de módulo (no dentro de app.whenReady) para que tanto la sesión
// principal como cada sesión aislada (setupExtraSession) puedan pasarla
// como mediaCallback y así tener el Stream Hunter funcionando igual en las dos.
function checkMedia(u, pageUrl, resourceType) {
  if (!CFG.mediaDetect) return;
  try {
    const pageHost = new URL(pageUrl).hostname.toLowerCase();
    if (pageHost === 'youtube.com' || pageHost.endsWith('.youtube.com')
      || pageHost === 'youtube-nocookie.com' || pageHost.endsWith('.youtube-nocookie.com')) return;
  } catch {}
  if (SKIP_EXT_RE.test(u) || /^(about|data|javascript):/i.test(u)) return;
  if (/\/(?:favicon|faviconv2|s2\/favicons)(?:[/?#]|$)/i.test(u) || /favicon/i.test(u)) return;
  // Omitir segmentos HLS sueltos — solo playlists y archivos directos
  if (/\.ts(\?|#|$)/i.test(u)) return;
  if (/\/seg(?:ment)?[\d._-]/i.test(u)) return;
  // Facebook/Instagram solicitan muchos rangos MP4 parciales para llenar
  // el reproductor; no son archivos descargables independientes.
  if (/[?&](?:bytestart|byteend|range|start|end)=/i.test(u)) return;
  const hasMediaToken = /[?&](token|exp|sign|auth|st|nonce|signature|hls|m3u8|mpd|playlist)=/i.test(u);
  // Las imágenes genéricas incluyen favicons, avatares y miniaturas. No son
  // evidencia de un stream; solo media/audio o una URL multimedia explícita.
  if (!MEDIA_RE.test(u) && !hasMediaToken && !(resourceType === 'media' || resourceType === 'audio')) return;
  if (StatsTracker.alreadyDetectedMedia(u)) return;
  const type = HLS_RE.test(u) ? 'HLS' : u.includes('.mpd') ? 'DASH' : resourceType === 'audio' ? 'AUDIO' : 'MP4';
  const entry = { url: u, pageUrl: pageUrl || '', type, ts: new Date().toISOString() };
  StatsTracker.recordDetectedMedia(entry);
  const count = StatsTracker.bumpDetectedMedia();
  ACTIONS.emit('media-detected', { ...entry, count });
  const stats = StatsTracker.getStats();
  ACTIONS.emit('stats-update', { ...stats, uptime: Date.now() - stats.uptimeStart });
}


module.exports = {
  checkMedia,
  MEDIA_RE,
  HLS_RE,
  SKIP_EXT_RE,
};
