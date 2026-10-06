'use strict';
/**
 * MC Browser -- src/main/perchance/panel.js
 *
 * Panel aislado de Perchance: particion persist:perchance, allowlist de
 * redesalteo, alertas inyectadas y deep-debugging opcional. El bloque se
 * extrajo de main.js tal cual.
 *
 * Los helpers isPerchanceRuntimeHost y el torneo diag de este panel viven aqui.
 */

const { app, session } = require('electron');
const { getMainWin } = require('../runtime');
const PerchancePanel = require('../../../perchance/perchance-panel');

function isPerchanceRuntimeHost(host) {
  // El panel debe vivir en su propia partición y no recibir una allowlist ni
  // excepción especial de hosts a nivel global de la app. Si se filtra por
  // dominio aquí, Cloudflare/Turnstile vuelve a romperse.
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// Panel aislado de Perchance (webview en sidebar con partición persist:perchance)
// ═══════════════════════════════════════════════════════════════════════
// La partición se prepara aquí (allowlist, permisos, CSP/XFO y descargas
// blob/data). El panel DOM (mini-navegador con marcadores) vive en
// modules/perchance-panel/renderer.js y usa un <webview partition="persist:perchance">.
const perchanceDiagInstalled = new WeakSet();
function setupPerchancePanel() {
  try {
    // El panel de Perchance debe comportarse como una sesión normal de Electron:
    // sin secure DNS/DoH ni filtros a nivel de app. Si se conserva el resolver
    // seguro global, Cloudflare genera subdominios de challenge que fallan con
    // ERR_NAME_NOT_RESOLVED aunque el sitio principal seabien.
    try {
      app.configureHostResolver({ enableBuiltInResolver: true, secureDnsMode: 'off' });
    } catch (e) {
      console.warn('[perchance] no pude forzar resolver nativo:', e.message);
    }
    PerchancePanel.installPerchanceNetwork(PerchancePanel.PERCHANCE_PARTITION);
    PerchancePanel.installPerchanceDownloads(PerchancePanel.PERCHANCE_PARTITION, {
      onEvent: (ev) => { try { getMainWin()?.webContents?.send('perchance:download', ev); } catch {} }
    });
    PerchancePanel.installPerchanceAlertBubbles(PerchancePanel.PERCHANCE_PARTITION);
    if (process.env.MC_PCH_DIAG === '1') {
      const rtcProbe = (wc) => {
        try {
          wc.executeJavaScript(`(async () => {
            try {
              const pc = new RTCPeerConnection({ iceServers: [] });
              const cands = [];
              await new Promise((res) => {
                const t = setTimeout(() => { cleanup(); res(); }, 4000);
                const onC = (e) => { if (e.candidate) cands.push(e.candidate.candidate); else { cleanup(); res(); } };
                const cleanup = () => { pc.removeEventListener('icecandidate', onC); clearTimeout(t); };
                pc.addEventListener('icecandidate', onC);
                pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e) => { clearTimeout(t); res(); throw e; });
              });
              let summary = '';
              try {
                const sdp = pc.localDescription && pc.localDescription.sdp || '';
                summary = (sdp.match(/a=candidate:/g) || []).length + ' sdp-cands';
              } catch {}
              const types = cands.map(c => c.split(' ')[1]).join(',');
              pc.close();
              return 'PCH_RTC cands=' + cands.length + ' [' + types + '] sdp=' + summary;
            } catch (err) { return 'PCH_RTC error=' + String(err && err.message || err); }
          })()`).then((r) => console.log('[PCH-RTC]', wc.getURL().slice(0, 90), '=>', r)).catch((e) => console.log('[PCH-RTC] fail', wc.getURL().slice(0, 60), e.message));
        } catch (err) {}
      };
      app.on('web-contents-created', (_e, wc) => {
        if (perchanceDiagInstalled.has(wc)) return;
        perchanceDiagInstalled.add(wc);
        if (wc.session === session.fromPartition(PerchancePanel.PERCHANCE_PARTITION)) rtcProbe(wc);
        if (wc.session === session.fromPartition('persist:mc')) rtcProbe(wc);
        if (wc.session !== session.fromPartition(PerchancePanel.PERCHANCE_PARTITION)) return;
        wc.on('console-message', (ev, level, message, line, sourceId) => {
          const lvl = ev?.level ?? level;
          const msg = ev?.message ?? message;
          console.log('[PCH-WV]', lvl, typeof msg === 'string' ? msg.slice(0, 200) : msg, '|', (ev?.sourceId || sourceId || ''));
        });
        wc.on('dom-ready', () => console.log('[PCH-WV] dom-ready', wc.getURL().slice(0, 120)));
        wc.on('did-fail-load', (ev) => {
          console.log('[PCH-WV] fail-load', ev.errorCode, ev.errorDescription, ev.validatedURL);
        });
        wc.on('did-fail-provisional-load', (ev) => {
          console.log('[PCH-WV] fail-prov', ev.errorCode, ev.errorDescription, ev.validatedURL);
        });
        wc.on('will-frame-navigate', (ev, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) => {
          console.log('[PCH-WV] frame-nav', isMainFrame ? 'MAIN' : 'SUB', url.slice(0, 160));
        });
        const runIframeWatcher = () => {
          try {
            wc.mainFrame && wc.mainFrame.executeJavaScript(`(() => {
                try {
                  if (window.__mcIframeWatchInstalled) return 'iframe-watch-already';
                  window.__mcIframeWatchInstalled = true;
                  const snap = (f) => {
                    try {
                      return JSON.stringify({
                        src: (f.getAttribute && f.getAttribute('src')) || '',
                        srcdoc: (f.srcdoc || '').slice(0, 80),
                        sandbox: f.getAttribute && f.getAttribute('sandbox'),
                        cls: String(f.className||'').slice(0, 50),
                        style: (f.getAttribute && f.getAttribute('style')) || '',
                        w: f.offsetWidth, h: f.offsetHeight,
                        vis: !!(f.offsetWidth||f.offsetHeight),
                        parent: (f.parentElement ? (f.parentElement.tagName + '.' + String(f.parentElement.className||'').slice(0,40)) : 'root'),
                      });
                    } catch (e) { return 'snap-err'; }
                  };
                  const report = () => {
                    const ifs = [...document.querySelectorAll('iframe')].map(snap);
                    console.log('[PCH-IFR]', JSON.stringify(ifs).slice(0, 1400));
                  };
                  const reportNew = (mutations) => {
                    for (const m of mutations) {
                      for (const n of (m.addedNodes || [])) {
                        if (n.nodeType === 1) {
                          const found = n.tagName === 'IFRAME' ? [n] : [...(n.querySelectorAll ? n.querySelectorAll('iframe') : [])];
                          for (const f of found) {
                            console.log('[PCH-IFR-NEW]', snap(f));
                            setTimeout(report, 400);
                          }
                        }
                      }
                    }
                  };
                  const startWatch = () => {
                    report();
                    const mutObserver = new MutationObserver(reportNew);
                    mutObserver.observe(document.documentElement, { childList: true, subtree: true });
                    return 'iframe-watch-installed';
                  };
                  if (!document.documentElement) {
                    setTimeout(() => {
                      try { console.log('[PCH-IFR]', startWatch()); } catch (err) { console.log('[PCH-IFR]', 'retry-fail ' + String(err && err.message || err)); }
                    }, 1500);
                    return 'iframe-watch-wait';
                  }
                  return startWatch();
                } catch (err) { return 'iframe-watch-fail ' + String(err && err.message || err); }
              })()`).then((r) => console.log('[PCH-IFR]', r)).catch(() => {});
          } catch (e) { console.log('[PCH-IFR]', 'exc', e.message); }
        };
        wc.on('did-frame-navigate', (ev, url, httpCode, httpStatusText, isMainFrame) => {
          console.log('[PCH-WV] frame-done', isMainFrame ? 'MAIN' : 'SUB', httpCode, url.slice(0, 140));
          const installClickProbeIn = (frame) => {
            try {
              frame.executeJavaScript(`(() => {
                try {
                  if (window.__mcClickProbeInstalled) return 'click-probe-already';
                  window.__mcClickProbeInstalled = true;
                  window.__mcClickLog = [];
                  document.addEventListener('click', (e) => {
                    try {
                      const t = e.target;
                      const x = e.clientX, y = e.clientY;
                      const at = document.elementFromPoint(x, y);
                      const desc = (el) => {
                        if (!el) return 'null';
                        const r = el.getBoundingClientRect();
                        return JSON.stringify({
                          tag: el.tagName,
                          cls: String(el.className||'').slice(0,80),
                          id: el.id,
                          txt: (el.innerText||el.textContent||'').replace(/\\n+/g,' ').trim().slice(0,80),
                          pointer: getComputedStyle(el).pointerEvents,
                          z: getComputedStyle(el).zIndex,
                          vis: !!(el.offsetWidth||el.offsetHeight),
                          rect: [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],
                        });
                      };
                      const clickable = t.closest ? (t.closest('button,a,[role=button],label,[onclick],.clickable') || null) : null;
                      const txt = ((t.innerText||t.textContent||'') + ' ' + (clickable && (clickable.innerText||clickable.textContent)||'')).replace(/\\n+/g,' ').trim();
                      window.__mcClickLog.push({ at: Date.now(), target: desc(t), clickable: desc(clickable), elementFromPoint: desc(at), same: at === t, overlayAbove: (at && clickable && at !== clickable) ? desc(at) : null });
                      console.log('[PCH-CLK-INNER]', '[' + location.hostname.slice(0, 30) + ']', JSON.stringify(window.__mcClickLog[window.__mcClickLog.length-1]).slice(0, 700));
                      if (/gal|lery|show|descrip|ver/i.test(txt)) {
                        setTimeout(() => {
                          try {
                            const ifs = [...document.querySelectorAll('iframe')].map(f => JSON.stringify({ src: (f.src||'').slice(0,100), sandbox: f.getAttribute('sandbox'), srcdoc: (f.srcdoc||'').slice(0,60), cls: String(f.className||'').slice(0,40), w: f.offsetWidth, h: f.offsetHeight, vis: !!(f.offsetWidth||f.offsetHeight) }));
                            const ovs = [...document.querySelectorAll('body *')].filter(el => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return (el.offsetWidth > 300) && (el.offsetHeight > 100) && (s.position === 'fixed' || s.position === 'absolute' || /shadow|filter/.test((s.boxShadow||'') + ' ' + s.filter)) && r.top <= 0 && r.left <= 0; }).slice(0, 8).map(el => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return JSON.stringify({ tag: el.tagName, cls: String(el.className||'').slice(0,50), bg: s.backgroundColor, z: s.zIndex, filter: s.filter || '', pos: s.position, rect: [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)], overlay: s.backgroundImage !== 'none' }); });
                            const bfg = getComputedStyle(document.body).filter + ' ' + (getComputedStyle(document.body).backgroundColor || '');
                            console.log('[PCH-GAL]', '[' + location.hostname.slice(0,30) + ']', JSON.stringify({ iframes: ifs, overlays: ovs, bodyFilter: bfg, bodyScroll: document.body.scrollHeight + 'x' + (document.body.offsetHeight||0) }).slice(0, 1500));
                          } catch (err3) { console.log('[PCH-GAL]', 'err', String(err3 && err3.message || err3)); }
                        }, 900);
                      }
                    } catch (err2) {
                      console.log('[PCH-CLK-INNER]', 'err', String(err2 && err2.message || err2));
                    }
                  }, true);
                  return 'click-probe-installed';
                } catch (err) { return 'click-probe-fail ' + String(err && err.message || err); }
              })()`).then((r) => {
                console.log('[PCH-CLK] setup', (frame.url || '').slice(0, 60), r);
              }).catch(() => {});
            } catch {}
          };
          const installClickProbe = () => {
            installClickProbeIn(wc.mainFrame || null);
            const allFrames = wc.mainFrame ? [wc.mainFrame, ...(wc.mainFrame.framesInSubtree || [])] : [];
            for (const f of allFrames) {
              if (f && f !== wc.mainFrame) installClickProbeIn(f);
            }
          };
          installClickProbe();
          if (isMainFrame) {
            try {
              runIframeWatcher();
              const subFrames = wc.mainFrame ? (wc.mainFrame.framesInSubtree || []) : [];
              for (const f of subFrames) {
                try {
                  f.executeJavaScript(`(() => {
                    try {
                      const snap = (fr) => JSON.stringify({ src: (fr.src||'').slice(0,120), srcdoc: (fr.srcdoc||'').slice(0,60), sandbox: fr.getAttribute('sandbox'), cls: String(fr.className||'').slice(0,40), w: fr.offsetWidth, h: fr.offsetHeight, vis: !!(fr.offsetWidth||fr.offsetHeight), parent: (fr.parentElement ? (fr.parentElement.tagName + '.' + String(fr.parentElement.className||'').slice(0,30)) : 'root') });
                      const report = () => { console.log('[PCH-IFR-SUB]', document.documentElement ? JSON.stringify([...document.querySelectorAll('iframe')].map(snap)).slice(0, 1200) : 'nodoc'); };
                      const reportNew = (mutations) => {
                        for (const m of mutations) {
                          for (const n of (m.addedNodes || [])) {
                            if (!n || n.nodeType !== 1) continue;
                            const found = n.tagName === 'IFRAME' ? [n] : [...(n.querySelectorAll ? n.querySelectorAll('iframe') : [])];
                            for (const fr of found) console.log('[PCH-IFR-SUB-NEW]', snap(fr));
                          }
                        }
                      };
                      if (window.__mcSubIframeWatch) return 'sub-iframe-already';
                      window.__mcSubIframeWatch = true;
                      const start = () => { report(); new MutationObserver(reportNew).observe(document.documentElement, { childList: true, subtree: true }); return 'sub-iframe-installed'; };
                      if (!document.documentElement) { setTimeout(() => { try { console.log('[PCH-IFR-SUB]', start()); } catch (e) {} }, 1500); return 'sub-iframe-wait'; }
                      return start();
                    } catch (e) { return 'sub-iframe-fail ' + String(e && e.message || e); }
                  })()`).then((r) => console.log('[PCH-IFR-SUB] setup', (f.url || '').slice(0, 60), r)).catch(() => {});
                } catch {}
              }
              wc.executeJavaScript(`(() => {
                try {
                  const btns = [...document.querySelectorAll('button, a, [class*=btn], [role=button], .clickable, [onclick]')].filter(el => (el.offsetWidth||el.offsetHeight) > 0);
                  const desc = btns.filter(b => /descrip|prompt|ver |m\xE1s|show|info|expand|\u2139|\\uD83D\\uDCC4|the prompt|image prompt|details/i.test(((b.innerText||b.textContent||'') + ' ' + (b.title||'') + ' ' + (b.className||'') + ' ' + (b.getAttribute && b.getAttribute('aria-label')||'')).slice(0,120))).slice(0, 10)
                    .map(b => ({ tag: b.tagName, txt: (b.innerText||b.textContent||'').replace(/\\n+/g,' ').trim().slice(0,50), cls: String(b.className||'').slice(0,40), title: b.title||'', onclick: b.getAttribute && b.getAttribute('onclick') ? String(b.getAttribute('onclick')).slice(0,70) : null }));
                  return JSON.stringify({ url: location.hostname, total: btns.length, desc: desc });
                } catch (err) { return JSON.stringify({ err: String(err && err.message || err) }); }
              })()`).then((r) => console.log('[PCH-DOM]', r.slice(0, 1200))).catch((e) => console.log('[PCH-DOM] fail', e.message));
            } catch {}
          }
          if (!isMainFrame && /image-generation\.perchance\.org\/gallery/i.test(url)) {
            try {
              wc.executeJavaScript(`(() => {
                try {
                  const cards = [...document.querySelectorAll('.imageCtn, [class*=image-card], [class*=gallery-image], .card, [class*=grid-item]')].slice(0, 5);
                  const cardInfo = cards.map(c => ({ cls: String(c.className||'').slice(0,60), btns: [...c.querySelectorAll('button,a,[onclick],[role=button],.clickable')].slice(0,8).map(b => ({
                    tag: b.tagName, txt: (b.innerText||b.textContent||'').replace(/\\n+/g,' ').trim().slice(0,50), cls: String(b.className||'').slice(0,40), onclick: b.getAttribute && b.getAttribute('onclick'), title: b.getAttribute && b.getAttribute('title'), aria: b.getAttribute && b.getAttribute('aria-label') })) }));
                  const all = [...document.querySelectorAll('[onclick]')].slice(0, 12).map(b => ({ cls: String(b.className||'').slice(0,50), onclick: (b.getAttribute('onclick')||'').slice(0,90) }));
                  return JSON.stringify({ cards: cardInfo, allOnclicks: all, hash: location.hash.slice(0, 120) });
                } catch (err) { return JSON.stringify({ err: String(err && err.message || err) }); }
              })()`).then((r) => console.log('[PCH-DOM]', r.slice(0, 1500))).catch((e) => console.log('[PCH-DOM] fail', e.message));
            } catch {}
            const probeGalleryFrame = (label) => {
              try {
                const frames = wc.mainFrame ? [wc.mainFrame, ...(wc.mainFrame.framesInSubtree || [])] : [];
                const gal = frames.find((fr) => fr && /image-generation\.perchance\.org\/gallery/i.test(fr.url || ''));
                if (!gal) return console.log('[PCH-LS]', label, 'no-frame');
                gal.executeJavaScript(`(() => {
                    try {
                      return JSON.stringify({
                        href: location.href.slice(0, 120),
                        none: localStorage.getItem('galleryUserChoseNoneFilter'),
                        probe: localStorage.getItem('probe'),
                        keys: Object.keys(localStorage).slice(0, 18),
                        canEval: (() => { try { new Function('1'); return true; } catch(e){ return false; } })(),
                      });
                    } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
                  })()`).then((r) => console.log('[PCH-LS]', label, r)).catch((e) => console.log('[PCH-LS]', label, 'fail', e.message));
              } catch (e) { console.log('[PCH-LS]', label, 'exc', e.message); }
            };
setTimeout(() => probeGalleryFrame('before'), 2500);
          }
        });
        const pchStartNav = (_ev, url, isInPlace, isMainFrame) => {
          if (!isMainFrame) console.log('[PCH-WV] subframe-nav-start', url.slice(0, 140));
        };
        wc.on('did-start-navigation', pchStartNav);
        const pchStop = () => console.log('[PCH-WV] stop-load', wc.getURL().slice(0, 120));
        wc.on('did-stop-loading', pchStop);
        wc.once('will-destroy', () => {
          try { wc.removeListener('did-start-navigation', pchStartNav); } catch {}
          try { wc.removeListener('did-stop-loading', pchStop); } catch {}
        });
        wc.once('did-finish-load', () => {
          setTimeout(() => {
            try {
              wc.executeJavaScript(`(() => {
                const q = s => !!document.querySelector(s);
                const count = s => document.querySelectorAll(s).length;
                return {
                  href: location.href,
                  title: (document.title || '').slice(0,60),
                  canEval: (() => { try { new Function('1'); return true; } catch(e){ return false; } })(),
                  webdriver: !!navigator.webdriver,
                  inputs: count('.ui-library-input, input[type=text], textarea, select'),
                  buttons: count('button'),
                  textarea: count('textarea'),
                  iframes: [...document.querySelectorAll('iframe')].map(f => (f.src || '').slice(0,90)),
                  bodySnippet: (document.body.innerText || '').slice(0,200).replace(/\\n/g,' '),
                };
              })()`)
                .then(r => console.log('[PCH-WV] state', JSON.stringify(r)))
                .catch(err => console.log('[PCH-WV] eval-fail', err.message));
            } catch (err) { console.log('[PCH-WV] eval-exc', err.message); }
          }, 8000);
        });
        wc.once('did-finish-load', () => {
          setTimeout(() => {
            const mf = wc.mainFrame;
            if (!mf) return console.log('[PCH-WV] no-mainframe');
            const frames = [mf, ...(mf.framesInSubtree || [])];
            const insp = (fr) => fr.executeJavaScript(`(() => {
              try {
                const isGallery = location.hostname === 'image-generation.perchance.org';
                const txt = (document.body && document.body.innerText || '').slice(0, isGallery ? 1500 : 120).replace(/\\n/g,' | ');
                const imgs = [...document.querySelectorAll('img')];
                const raw = imgs.slice(0, isGallery ? 20 : 6).map(i => {
                  const r = (i.currentSrc || i.src || '');
                  return { s: r.slice(-60), ok: i.complete && i.naturalWidth > 0, nw: i.naturalWidth };
                });
                const canEval = (() => { try { new Function('1'); return true; } catch(e){ return false; } })();
                const galleryIframes = !isGallery ? [...document.querySelectorAll('iframe')]
                  .filter(f => /image-generation\\.perchance\\.org\\/gallery/i.test(f.getAttribute('src') || ''))
                  .map(f => ({ src: (f.getAttribute('src')||'').slice(0,120), sandbox: f.getAttribute('sandbox') || '', allow: f.getAttribute('allow') || '' })) : [];
                const ls = (() => {
                  try {
                    return {
                      works: true,
                      none: localStorage.getItem('galleryUserChoseNoneFilter') ?? localStorage.galleryUserChoseNoneFilter ?? null,
                      publicUserId: localStorage.getItem('publicUserId') ? 'set' : null,
                      keys: Object.keys(localStorage).slice(0, 12),
                    };
                  } catch(e) { return { works: false, err: String(e && e.message || e) }; }
                })();
                const overlayEls = [...document.querySelectorAll('body > *')]
                  .filter(el => {
                    const r = el.getBoundingClientRect();
                    return r.width >= window.innerWidth - 5 && r.height >= window.innerHeight - 5 &&
                      el !== document.body && el !== document.documentElement && getComputedStyle(el).position === 'fixed';
                  })
                  .map(el => ({ t: el.tagName, z: getComputedStyle(el).zIndex, pe: getComputedStyle(el).pointerEvents, bg: getComputedStyle(el).backgroundColor, txt: (el.innerText||'').slice(0,60).replace(/\\n/g,' ') }));
                const gates = [...document.querySelectorAll('button, a, [role=button], label, input[type=checkbox], input[type=radio], .clickable, [onclick]')]
                  .filter(el => /mostr|ver im|mostrar|acept|reveal|show|view|over 18|18 \\+|nsfw|content/i.test(((el.innerText || el.textContent || el.value || '') + ' ' + (el.className || '') + ' ' + (el.id || '')).slice(0,120)))
                  .slice(0, isGallery ? 15 : 8)
                  .map(el => ({ t: el.tagName, rgx: (el.tagName === 'INPUT') ? (el.type + ':' + el.checked) : '', txt: (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\\n/g,' ').slice(0,80), vis: !!(el.offsetWidth||el.offsetHeight) }));
                return {
                  href: (location.href||'').slice(0,130),
                  txt,
                  canEval,
                  galleryIframes,
                  ls,
                  overlays: overlayEls,
                  imgTotal: imgs.length,
                  imgBroken: imgs.filter(i => i.complete && i.naturalWidth === 0).length,
                  imgOk: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
                  imgPending: imgs.filter(i => !i.complete).length,
                  imgSample: raw,
                  gates,
                };
              } catch(e) { return { err: String(e && e.message || e) }; }
            })()`).then(r => console.log('[PCH-FRAME]', JSON.stringify(r))).catch(err => console.log('[PCH-FRAME] fail', err.message));
            Promise.allSettled([...frames].filter(fr => fr && typeof fr.executeJavaScript === 'function').map(insp));
          }, 10000);
        });
        try {
          const ses = wc.session;
          console.log('[PCH-WV] persistent?', ses && ses.isPersistent === true ? 'YES' : 'NO (' + String(ses && ses.isPersistent) + ')');
        } catch (err) { console.log('[PCH-WV] persistent-check-fail', err.message); }
        try {
          wc.debugger.attach('1.3');
          wc.debugger.sendCommand('Runtime.enable').catch(() => {});
          wc.debugger.sendCommand('Log.enable').catch(() => {});
          wc.debugger.sendCommand('Debugger.enable').catch(() => {});
          wc.debugger.on('message', (_e, method, params) => {
            if (method === 'Runtime.exceptionThrown') {
              try {
                const d = params && params.exceptionDetails;
                const txt = (d && d.exception && d.exception.description) || (d && d.text) || '?';
                const url = d && d.url || '';
                console.log('[PCH-JS][exc]', txt.replace(/\n/g, ' ').slice(0, 300), '|', url.slice(0, 100));
              } catch {}
            } else if (method === 'Runtime.consoleAPICalled') {
              try {
                const type = params && params.type;
                if (type !== 'error' && type !== 'warning') return;
                const args = (params && params.args || []).map(a => a.value ?? a.description ?? a.type ?? '').join(' ');
                const stack = (params && params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames.length ? ' @' + params.stackTrace.callFrames[0].url.split('/').slice(-2).join('/') + ':' + params.stackTrace.callFrames[0].lineNumber : '');
                console.log('[PCH-JS][' + type + ']', args.replace(/\n/g, ' ').slice(0, 250) + stack);
              } catch {}
            } else if (method === 'Log.entryAdded') {
              try {
                const e = params && params.entry;
                if (!e || e.level === 'verbose') return;
                let src = e.source === 'other' ? '' : '[' + e.source + '] ';
                console.log('[PCH-LOG]', src + e.level + ': ' + String(e.text || '').slice(0, 250) + (e.url ? ' @' + e.url.slice(0, 100) : ''));
              } catch {}
            }
          });
          wc.once('destroyed', () => { try { wc.debugger.detach(); } catch {} });
          const sesProbe = wc.session;
          try {
            console.log('[PCH-WV] session check', JSON.stringify({
              isPersistent: typeof sesProbe.isPersistent === 'function' ? sesProbe.isPersistent() : sesProbe.isPersistent,
              isMainSession: sesProbe === session.defaultSession,
              equalsPersistPart: sesProbe === session.fromPartition(PerchancePanel.PERCHANCE_PARTITION),
              storagePath: sesProbe.getStoragePath ? sesProbe.getStoragePath() : null,
            }));
          } catch (err) { console.log('[PCH-WV] session-check-fail', err.message); }
          console.log('[PCH-WV] cdp attached');
          wc.executeJavaScript(`(async () => {
            try {
              const pc = new RTCPeerConnection({ iceServers: [] });
              const cands = [];
              await new Promise((res) => {
                const t = setTimeout(() => { cleanup(); res(); }, 4000);
                const onC = (e) => { if (e.candidate) cands.push(e.candidate.candidate); else { cleanup(); res(); } };
                const cleanup = () => { pc.removeEventListener('icecandidate', onC); clearTimeout(t); };
                pc.addEventListener('icecandidate', onC);
                pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e) => { clearTimeout(t); res(); throw e; });
              });
              let summary = '';
              try {
                const sdp = pc.localDescription && pc.localDescription.sdp || '';
                summary = (sdp.match(/a=candidate:/g) || []).length + ' sdp-cands';
              } catch {}
              const types = cands.map(c => c.split(' ')[1]).join(',');
              pc.close();
              return 'PCH_RTC cands=' + cands.length + ' [' + types + '] sdp=' + summary;
            } catch (err) { return 'PCH_RTC error=' + String(err && err.message || err); }
          })()`).then((r) => console.log('[PCH-WV]', r)).catch((e) => console.log('[PCH-WV] rtc-fail', e.message));
        } catch (err) { console.log('[PCH-WV] cdp-attach-fail', err.message); }
      });
    }
  } catch (e) { console.error('[PERCHANCE][init]', e.message); }
}

module.exports = { setupPerchancePanel };
