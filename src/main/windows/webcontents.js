'use strict';
/**
 * MC Browser -- src/main/windows/webcontents.js
 *
 * Los listeners de `web-contents-created`: guardia de navegacion/redirect y
 * update de cookie-guard cuando aparece un webContents de la sesión principal.
 * Los dos bloques se movieron desde main.js tal cual.
 *
 * TRAMPA: la cadena isPerchanceSession y los tipos de webContents (`getType()
 * === "webview"`) condicionan cuándo se exime de la guardia de redirect y cuándo
 * se actualiza el cookie-guard, y se documentan ahi por que son peligrosas de
 * perturbar experimentalmente. Este módulo llama a registerWebContentsListeners()
 * una sola vez al cargar; los closures dentro usan required paths identicos a
 * los de main.js.
 */

const { app, session } = require('electron');
const WindowsContextMenu = require('./context-menu');
const { getMainWin } = require('../runtime');
const Sessions = require('../sessions/partitions');
const CookieGuard = require('../net/cookie-guard');
const StatsTracker = require('../stats/tracker');
const PerchancePanel = require('../../../perchance/perchance-panel');
const NavDomains = require('../navigation/domains');
const NavExplicit = require('../navigation/explicit-nav');
const NavTransitions = require('../navigation/transitions');
const {
  isAggressiveAdNavigation, isExplicitlyBlocked, isTrustedResource, isVideoHost,
  isAdblockHostAllowed, isAdblockSiteAllowed, isGoogleDocumentHost, isGoogleAdHost
} = require('../../../modules/adblocker/main');

function registerWebContentsListeners(deps = {}) {
  const { saveBlobOrDataUrlToDownloads, resolveCtxCssPoint } = deps;
  app.on('web-contents-created', (event, wc) => {
    WindowsContextMenu.installContextMenu(wc, { saveBlobOrDataUrlToDownloads, resolveCtxCssPoint });
    wc.on('will-redirect', (navigationEvent, url, isInPlace, isMainFrame) => {
      if (Sessions.isWebchatSession(wc)) return;
      // ExcepciÃ³n: la particiÃ³n de Perchance (y cualquier salto *.perchance.org)
      // NO pasa por esta guardia. perchance.org redirige a ads.perchance.org /
      // partners con frecuencia; cortarlo degrada el motor aunque la allowlist
      // de red estÃ© bien.
      const isPerchanceSession = (() => {
        try { return wc.session === session.fromPartition(PerchancePanel.PERCHANCE_PARTITION); } catch { return false; }
      })();
      const sourceUrl = wc.getURL();
      let targetHostForAdCheck = '';
      try { targetHostForAdCheck = new URL(url).hostname.toLowerCase(); } catch {}

      // Reglas de prioridad: primero bloqueamos redes publicitarias o redirecciones
      // explÃ­citas a subdominios de anuncios del mismo dominio. Solo despuÃ©s se
      // permite el caso de navegaciÃ³n del mismo sitio y sin indicios publicitarios.
      if (!isPerchanceSession && !NavDomains.isPerchanceHost(targetHostForAdCheck) &&
          targetHostForAdCheck && (isAggressiveAdNavigation(url) || isExplicitlyBlocked(targetHostForAdCheck, sourceUrl))) {
        try { navigationEvent.preventDefault(); } catch {}
        try { getMainWin()?.webContents?.send('req-blocked', { type: 'navigation', url, msg: 'RedirecciÃ³n a dominio de anuncios bloqueada' }); } catch {}
        return;
      }
      const isSameSiteRedirect = !!sourceUrl && NavTransitions.isSameNavigationSite(sourceUrl, url);
      if (isSameSiteRedirect || (sourceUrl && NavTransitions.allowNavigationTransition(sourceUrl, url))) {
        NavExplicit.keepExplicitNavigationAlive(wc.id);
        return;
      }
      if (isPerchanceSession) {
        // Mini-navegador aislado: dejar pasar TODA la cadena de redirects.
        NavExplicit.keepExplicitNavigationAlive(wc.id);
        return;
      }
      // NavegaciÃ³n explÃ­cita iniciada por la interfaz del navegador: preservar
      // su cadena de redirecciones. Las navegaciones de la pÃ¡gina no reciben
      // esta excepciÃ³n automÃ¡ticamente.
      if (NavExplicit.hasExplicitNavigation(wc.id)) {
        NavExplicit.keepExplicitNavigationAlive(wc.id);
        return;
      }
      let targetHost = '';
      try {
        targetHost = new URL(url).hostname.toLowerCase();
      } catch {}
      const isAllowedRedirectHost = !!targetHost && (NavTransitions.isExplicitMediaRedirectHost(targetHost) || isVideoHost(targetHost));
      if (!isMainFrame && !isAllowedRedirectHost) return;
      try {
        const sourceHost = new URL(sourceUrl).hostname;
        if (NavDomains.isAuthRedirectFlow(targetHost, sourceHost)) return;
      } catch {}
      if (!NavTransitions.allowNavigationTransition(sourceUrl, url)) {
        try { navigationEvent.preventDefault(); } catch {}
        try { getMainWin()?.webContents?.send('req-blocked', { type: 'navigation', url, msg: 'RedirecciÃ³n externa bloqueada desde ' + sourceUrl }); } catch {}
      }
    });
    // Limpiar el marcador de navegaciÃ³n explÃ­cita cuando termina (Ã©xito o error).
    // `did-navigate` se emite cuando la navegaciÃ³n del frame principal se
    // confirma (tras la cadena de redirecciones), asÃ­ que limpiar ahÃ­ permite
    // la cadena inicial pero vuelve a bloquear auto-redirecciones posteriores
    // de la pÃ¡gina (anuncios) durante el resto de la carga.
    // did-navigate puede dispararse en un salto INTERMEDIO de la cadena de
    // redirecciones en algunas versiones de Chromium, no solo al final â€”
    // borrar la marca de navegaciÃ³n explÃ­cita ahÃ­ mismo corta la protecciÃ³n
    // a mitad de una cadena legÃ­tima (muy comÃºn en sitios con varios
    // subdominios: login.x.com -> api.x.com -> app.x.com), y el siguiente
    // salto de esa MISMA navegaciÃ³n queda bloqueado como si fuera ajeno.
    // keepExplicitNavigationAlive() renueva el margen de 2.5s en vez de
    // cortarlo en seco; did-fail-load sigue limpiando de inmediato porque
    // ahÃ­ no hay cadena que proteger.
    wc.on('did-navigate', () => NavExplicit.keepExplicitNavigationAlive(wc.id));
    wc.on('did-fail-load', () => NavExplicit.clearExplicitNavigation(wc.id));
    wc.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
      if (isMainFrame) StatsTracker.clearBlockedHosts(wc.id);
      if (isMainFrame && /^https?:\/\/(?:[^/]+\.)?whatsapp\.(?:com|net)(?:\/|$)/i.test(url)) {
        wc.setUserAgent(NavDomains.UA_WHATSAPP);
      }
    });
    // â”€â”€ Pantalla completa HTML5 (botÃ³n nativo de fullscreen/modo teatro del
    // propio sitio: YouTube, Facebook, Vimeo, etc.) â”€â”€
    // Sin este manejo, Electron solo expande el elemento dentro de los lÃ­mites
    // del propio <webview> (que ocupa una fracciÃ³n de la ventana, dejando la
    // barra de pestaÃ±as/sidebar visibles alrededor) y nunca lleva la ventana
    // del SO a fullscreen real â€” exactamente el sÃ­ntoma reportado.
    if (wc.getType() === 'webview') {
      wc.on('enter-html-full-screen', () => {
        const win = wc.getOwnerBrowserWindow();
        if (win && !win.isFullScreen()) win.setFullScreen(true);
        try { getMainWin()?.webContents?.send('webview-fullscreen', { wcId: wc.id, fullscreen: true }); } catch {}
        // Salvaguarda documentada por Electron: si la ventana sale de fullscreen
        // por una vÃ­a distinta al propio control del sitio (p.ej. el usuario usa
        // el atajo de maximizar/restaurar del SO), forzar que el documento salga
        // de fullscreen HTML tambiÃ©n â€” si no, el webview queda en un estado
        // "fullscreen" interno desincronizado y el siguiente intento de
        // fullscreen del sitio deja de disparar el evento por completo.
        win?.once('leave-html-full-screen', () => {
          try {
            if (!isWebContentsFrameAlive(wc)) return;
            wc.executeJavaScript('document.exitFullscreen()', true).catch(() => {});
          } catch {}
        });
      });
      wc.on('leave-html-full-screen', () => {
        const win = wc.getOwnerBrowserWindow();
        if (win && win.isFullScreen()) win.setFullScreen(false);
        try { getMainWin()?.webContents?.send('webview-fullscreen', { wcId: wc.id, fullscreen: false }); } catch {}
      });
    }
    // Captura la posiciÃ³n del clic derecho en pÃ­xeles CSS (exacta para elementFromPoint)
    wc.on('did-stop-loading', () => {
      try {
        if (wc.getType() !== 'webview' || Sessions.isWebchatSession(wc)) return;
        wc.executeJavaScript(`(() => {
          if (window.__mcCtxPosInstalled) return;
          window.__mcCtxPosInstalled = true;
          window.__mcCtxPos = null;
          document.addEventListener('contextmenu', (e) => {
            window.__mcCtxPos = { x: e.clientX, y: e.clientY, t: Date.now() };
          }, true);
        })()`).catch(() => {});
        try {
          const host = new URL(wc.getURL()).hostname.toLowerCase();
          if (host === 'monoschinos2.net' || host.endsWith('.monoschinos2.net')) {
            wc.executeJavaScript(`(() => {
              if (window.__mcMonoschinosWarningCleanup) return;
              window.__mcMonoschinosWarningCleanup = true;
              const isWarning = text =>
                /Warning\\s*:\\s*file_exists\\(\\)/i.test(text) &&
                /open_basedir restriction in effect/i.test(text) &&
                /bloques\\.php/i.test(text);
              const cleanEpisodeList = () => {
                const lists = Array.from(document.querySelectorAll('ul.eplist'));
                let waiting = lists.length === 0;
                for (const list of lists) {
                  const nodes = Array.from(list.childNodes);
                  const firstItem = nodes.findIndex(node =>
                    node.nodeType === Node.ELEMENT_NODE && node.matches('li'));
                  if (firstItem < 0) {
                    waiting = true;
                    continue;
                  }
                  const leadingNodes = nodes.slice(0, firstItem);
                  const text = leadingNodes.map(node => node.textContent || '').join('');
                  if (isWarning(text)) leadingNodes.forEach(node => node.remove());
                }
                return waiting;
              };
              if (!cleanEpisodeList()) return;
              const observer = new MutationObserver(() => {
                if (!cleanEpisodeList()) observer.disconnect();
              });
              observer.observe(document.documentElement, { childList: true, subtree: true });
              setTimeout(() => observer.disconnect(), 10000);
            })()`).catch(() => {});
          }
        } catch {}
      } catch {}
    });
    WindowsContextMenu.installContextMenu(wc, {
      saveBlobOrDataUrlToDownloads,
      resolveCtxCssPoint,
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (Sessions.isWebchatSession(wc)) return { action: 'allow' };
      const isPerchanceSession = (() => {
        try { return wc.session === session.fromPartition(PerchancePanel.PERCHANCE_PARTITION); } catch { return false; }
      })();
      // Perchance: about:blank/srcdoc = burbujas internas (permitir ventana guest).
      // Enlaces http(s) de botones = pestaÃ±a nueva del panel, nunca BrowserWindow.
      if (isPerchanceSession) {
        const raw = String(url || '');
        if (!/^https?:\/\//i.test(raw)) {
          if (process.env.MC_PCH_DIAG === '1') console.log('[PCH-WV] popup-allow-blank', raw.slice(0, 120));
          return { action: 'allow' };
        }
        try { getMainWin()?.webContents?.send('perchance-open-tab', raw); } catch {}
        if (process.env.MC_PCH_DIAG === '1') console.log('[PCH-WV] popup-to-tab', raw.slice(0, 160));
        return { action: 'deny' };
      }
      // Bloquear siempre popups claramente publicitarios/de seguimiento.
      if (isAggressiveAdNavigation(url)) {
        return { action: 'deny' };
      }
      // OAuth de Google/X debe abrirse normalmente dentro de la sesiÃ³n actual.
      // Forzar deny/redirect aquÃ­ rompe el flujo y evita que aparezca la pantalla
      // de login del segundo usuario.
      if (NavDomains.isAuthPopupUrl(url)) {
        return { action: 'allow' };
      }
      // Para TODO lo demÃ¡s, impedimos que Chromium abra una ventana nativa.
      // La conversiÃ³n a pestaÃ±a (una sola vez) queda exclusivamente a cargo
      // del evento 'new-window' del webview en renderer.html, que filtra por
      // mismo dominio. Evitamos aqui el segundo 'open-new-tab' que provocaba
      // la apariciÃ³n de varias pestaÃ±as duplicadas al pulsar Descargar.
      return { action: 'deny' };
    });
  });

  app.on('web-contents-created', (_event, contents) => {
    if (process.env.MC_PCH_DIAG === '1') {
      try {
        const isPch = contents.session === session.fromPartition(PerchancePanel.PERCHANCE_PARTITION);
        console.log('[PCH-WC] created', contents.getType(), isPch ? 'PCH-PART' : 'other', contents.getURL().slice(0, 90));
        if (isPch) {
          contents.on('did-finish-load', () => console.log('[PCH-WC] loaded', contents.getType(), contents.getURL().slice(0, 120)));
          contents.on('did-navigate', (_e, url) => console.log('[PCH-WC] nav', contents.getType(), url.slice(0, 120)));
          contents.on('render-process-gone', (_e, details) => {
            try {
              const mem = process.getProcessMemoryInfo ? process.getProcessMemoryInfo() : null;
              console.log('[PCH-WC] render-gone', JSON.stringify({ details, url: contents.getURL().slice(0, 160), type: contents.getType(), wcId: contents.id, mem: mem ? JSON.stringify(mem) : null }));
            } catch (err) { console.log('[PCH-WC] render-gone', JSON.stringify(details), '| mem-fail', err.message); }
          });
          contents.on('unresponsive', () => console.log('[PCH-WC] UNRESPONSIVE', contents.getURL().slice(0, 120)));
          contents.on('responsive', () => console.log('[PCH-WC] responsive-again'));
          contents.on('destroyed', () => console.log('[PCH-WC] DESTROYED', contents.getURL().slice(0, 120)));
        }
      } catch {}
    }
    if (contents.getType() === 'webview' && (Sessions.isMainBrowsingSession(contents) || Sessions.isExtraSessionWebContents(contents))) {
      CookieGuard.updateCookieGuard(contents).catch(e => console.error('[cookie-guard] setup fallido', e.message));
    }
  });
}

module.exports = { registerWebContentsListeners };
