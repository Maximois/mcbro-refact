'use strict';
/**
 * MC Browser -- src/main/sessions/ipc.js
 *
 * Los canales IPC de las sesiones aisladas y de la limpieza de datos:
 * `sessions:*`, `clear-*` y la paleta de colores con la que el usuario
 * distingue una sesion de otra.
 *
 * -----------------------------------------------------------------------------
 * LO QUE NO ESTA AQUI, Y POR QUE
 * -----------------------------------------------------------------------------
 * `export-session` e `import-session` tambien son de sesion, pero se quedan en
 * `bootstrap.js`, no aqui: el paso 28 dejo el bloque `DATA_DIR`+`setPath`
 * dentro de `bootstrap.js`, asi que su modulo dueno es el arranque del proceso
 * y no hay que moverlos. Hacerlo obligaria a exportar ese dato, y la regla 2.5
 * no admite que la ruta de datos viva en dos sitios.
 *
 * Lo mismo con los canales de cookies por sitio (`add-cookie-rule`,
 * `get-site-cookies`, `set-site-cookie`...): son de `net/cookie-guard.js`, no de
 * las sesiones. Aqui solo se tocan cookies cuando se borran enteras.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- estos handlers son operacion GLOBAL, no de quien los pulso
 * -----------------------------------------------------------------------------
 * El boton "limpiar cookies" del panel WebChat tiene que borrar las cookies de
 * WebChat, no las de la pestana desde la que se pulso. Por eso ninguno usa
 * `event.sender.session`: cada uno va a la particion que le toca, escrita a mano.
 *
 *   clear-cookies / clear-cache / clear-data / clear-all  -> persist:mc
 *   sessions:delete / sessions:clear-data                 -> la de la sesion
 *   clear-webchat-data                                     -> Sessions.WEBCHAT_PARTITION
 *   Perchance                                              -> la suya
 *
 * Cambiar cualquiera a `event.sender.session` rompe el reparto en silencio: no
 * lanza, solo borra las cookies de otro sitio.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- `mainSession()` no es `session.defaultSession`
 * -----------------------------------------------------------------------------
 * El usuario abre varias sesiones aisladas que NUNCA comparten cookies. La
 * sesion principal es `persist:mc`, y `defaultSession` solo corresponde a las
 * ventanas sin `partition` propio: usarla vaciaria la principal Y dejaria
 * intactas las demas.
 *
 * El literal esta aqui y en `main.js` a proposito, igual que en
 * `sessions/partitions.js`. Unificarlo es el commit propio que lleva pendiente
 * desde el principio (ver el punto 5.15 del plan) y no se mezcla con este.
 */

const { ipcMain, session } = require('electron');
const CookieGuard = require('../net/cookie-guard');
const Sessions = require('./partitions');
const SessionsExtra = require('./extra');
const HistoryStore = require('../data/history');
const StatsTracker = require('../stats/tracker');
const { CFG, saveCfg } = require('../config');

const mainSession = () => session.fromPartition('persist:mc');

// Paleta fija de acento por sesion. Solo para distinguir a simple vista una
// sesion aislada de otra (y de los paneles de chat, que no usan esto). No es
// configurable: es una decision de diseño, no un ajuste.
const SESSION_COLOR_PALETTE = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#748ffc', '#da77f2', '#f783ac'];

function registerSessionsIpc() {
  ipcMain.handle('clear-cookies', async () => {
    try {
      const cookies = await mainSession().cookies.get({});
      for (const c of cookies) await mainSession().cookies.remove(CookieGuard.cookieRemovalUrl(c), c.name);
      return { ok: true };
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('clear-cache', async () => {
    try { await mainSession().clearCache(); return { ok: true }; } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('sessions:list', () => {
    const entries = CFG.extraSessions || [];
    const usedNames = new Set(entries.filter(s => s.name !== 'Nueva sesión').map(s => s.name));
    let suffix = 0;
    let changed = false;
    for (const entry of entries) {
      if (entry.name !== 'Nueva sesión') continue;
      let name = suffix === 0 ? 'MC' : `MC-${suffix}`;
      while (usedNames.has(name)) name = `MC-${++suffix}`;
      entry.name = name;
      usedNames.add(name);
      suffix++;
      changed = true;
    }
    if (changed) saveCfg();
    return entries;
  });
  ipcMain.handle('sessions:create', (e, { name, color } = {}) => {
    const id = 'sess_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const existingNames = new Set((CFG.extraSessions || []).map(s => s.name));
    let suffix = 0;
    let defaultName = 'MC';
    while (existingNames.has(defaultName)) defaultName = `MC-${++suffix}`;
    const usedColors = new Set((CFG.extraSessions || []).map(s => s.color));
    const autoColor = SESSION_COLOR_PALETTE.find(c => !usedColors.has(c)) || SESSION_COLOR_PALETTE[(CFG.extraSessions || []).length % SESSION_COLOR_PALETTE.length];
    const entry = {
      id,
      name: String(name || defaultName).trim().slice(0, 40) || defaultName,
      color: SESSION_COLOR_PALETTE.includes(color) ? color : autoColor,
      createdAt: Date.now()
    };
    CFG.extraSessions = [...(CFG.extraSessions || []), entry];
    saveCfg();
    try { SessionsExtra.setupExtraSession(session.fromPartition(Sessions.extraSessionPartition(id))); } catch (e2) { console.error('[sessions:create]', e2.message); }
    return entry;
  });
  ipcMain.handle('sessions:rename', (_e, { id, name }) => {
    const s = (CFG.extraSessions || []).find(s => s.id === id);
    if (!s) return { ok: false, error: 'no encontrada' };
    s.name = String(name || '').trim().slice(0, 40) || s.name;
    saveCfg();
    return { ok: true, name: s.name };
  });
  ipcMain.handle('sessions:set-color', (_e, { id, color }) => {
    const s = (CFG.extraSessions || []).find(s => s.id === id);
    if (!s) return { ok: false, error: 'no encontrada' };
    if (!SESSION_COLOR_PALETTE.includes(color)) return { ok: false, error: 'color inválido' };
    s.color = color;
    saveCfg();
    return { ok: true, color: s.color };
  });
  ipcMain.handle('sessions:delete', async (_e, { id }) => {
    CFG.extraSessions = (CFG.extraSessions || []).filter(s => s.id !== id);
    saveCfg();
    try { await session.fromPartition(Sessions.extraSessionPartition(id)).clearStorageData(); } catch {}
    return { ok: true };
  });
  ipcMain.handle('sessions:clear-data', async (_e, { id }) => {
    try {
      const sess2 = session.fromPartition(Sessions.extraSessionPartition(id));
      const cookies = await sess2.cookies.get({});
      for (const c of cookies) await sess2.cookies.remove(CookieGuard.cookieRemovalUrl(c), c.name).catch(() => {});
      await sess2.clearCache();
      await sess2.clearStorageData();
      return { ok: true };
    } catch (e2) { return { ok: false, error: e2.message }; }
  });
  ipcMain.handle('clear-webchat-data', async (_e, opts = {}) => {
    try {
      const wchSess = session.fromPartition(Sessions.WEBCHAT_PARTITION);
      const settings = { cookies: opts.cookies !== false, cache: opts.cache !== false, storage: opts.storage !== false };
      if (settings.cookies) {
        const cookies = await wchSess.cookies.get({});
        for (const c of cookies) await wchSess.cookies.remove(CookieGuard.cookieRemovalUrl(c), c.name).catch(() => {});
      }
      if (settings.cache) await wchSess.clearCache();
      if (settings.storage) await wchSess.clearStorageData();
      return { ok: true, settings };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
  ipcMain.handle('clear-data', async (_e, opts = {}) => {
    try {
      const settings = {
        history: Boolean(opts.history),
        cache: Boolean(opts.cache),
        cookies: Boolean(opts.cookies),
        keepSessions: Boolean(opts.keepSessions)
      };

      if (settings.cookies) {
        const cookies = await mainSession().cookies.get({});
        const filtered = settings.keepSessions ? cookies.filter(c => !c.session) : cookies;
        for (const c of filtered) await mainSession().cookies.remove(CookieGuard.cookieRemovalUrl(c), c.name);
      }

      if (settings.cache) await mainSession().clearCache();
      if (settings.history) {
        HistoryStore.store.items = [];
        HistoryStore.save();
      }

      return { ok: true, settings };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
  ipcMain.handle('clear-all', async () => {
    try {
      const cookies = await mainSession().cookies.get({});
      for (const c of cookies) await mainSession().cookies.remove(CookieGuard.cookieRemovalUrl(c), c.name);
      await mainSession().clearCache();
      await mainSession().clearStorageData();
      HistoryStore.store.items = [];
      HistoryStore.save();
      StatsTracker.zeroStats();
      return { ok: true };
    } catch (e) { return { error: e.message }; }
  });
}

module.exports = { registerSessionsIpc, SESSION_COLOR_PALETTE };