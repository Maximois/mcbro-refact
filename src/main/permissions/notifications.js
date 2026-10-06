'use strict';
/**
 * MC Browser -- src/main/permissions/notifications.js
 *
 * El UNICO permiso que abre un dialogo al usuario: notificaciones.
 *
 * QUE HACE
 *   - Genera un requestId, avisa al renderer por 'notification-permission-request'
 *     y espera su respuesta por el canal 'notification-permission-response'.
 *   - Guarda el callback de Electron en un mapa, con un temporizador de 45 s que
 *     resuelve con `false` si el usuario no contesta.
 *   - Falla de forma segura en cuatro puntos: sin ventana, ventana destruida,
 *     ventana que muere mientras espera, o renderer que no responde.
 *
 * QUE NO DEBE HACER
 *   - No concede permisos por su cuenta. El dialogo es una consulta; la
 *     respuesta se valida en el handler que la recibe.
 *   - No toca camara, microfono, geolocalizacion ni fullscreen. Esos pasan
 *     directo por resolvePermissionDecision.
 *   - No guarda la decision sin que el usuario la haya dado: `persistDecision`
 *     solo es true cuando el renderer mandó un booleano explicito.
 *
 * DEPENDENCIAS
 *   - entries.js, para persistir la decision cuando el usuario responde.
 *   - runtime.js, por getMainWin().
 */

const { ipcMain } = require('electron');
const crypto = require('crypto');
const { getMainWin } = require('../runtime');
const { setPermissionEntry } = require('./entries');
const { normalizeSiteHost, getPermissionRuleForHost } = require('./adapters');

const pendingNotificationPermissions = new Map();
const NOTIFICATION_PERMISSION_TIMEOUT_MS = 45000;

function finishNotificationPermissionRequest(requestId, allowed, persistDecision = false) {
  const pending = pendingNotificationPermissions.get(requestId);
  if (!pending) return false;
  pendingNotificationPermissions.delete(requestId);
  clearTimeout(pending.timer);
  if (persistDecision) {
    setPermissionEntry(pending.host, 'notifications', allowed ? 'allow' : 'deny');
  }
  try { pending.callback(allowed); } catch {}
  return true;
}

ipcMain.on('notification-permission-response', (event, response = {}) => {
  if (!getMainWin() || event.sender !== getMainWin().webContents) return;
  const requestId = String(response.requestId || '');
  const hasDecision = typeof response.allowed === 'boolean';
  finishNotificationPermissionRequest(requestId, response.allowed === true, hasDecision);
});

/**
 * Intenta mostrar el dialogo de notificaciones. Devuelve true si se encaro
 * (quedando pendiente de respuesta) y false si no habia que preguntar o no se
 * pudo preguntar, en cuyo caso el caller debe resolver con la regla automatica.
 *
 * @param {string} requestingUrl  URL que pide el permiso
 * @param {import('electron').WebContents} webContents  quien lo pide
 * @param {(allowed: boolean) => void} callback  callback de Electron
 */
function requestNotificationsPermission(requestingUrl, webContents, callback) {
  const host = normalizeSiteHost(requestingUrl);
  if (!host || getPermissionRuleForHost(host, 'notifications')) return false;

  const win = getMainWin();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    callback(false);
    return true;
  }

  const requestId = crypto.randomUUID();
  const timer = setTimeout(() => finishNotificationPermissionRequest(requestId, false), NOTIFICATION_PERMISSION_TIMEOUT_MS);
  pendingNotificationPermissions.set(requestId, { callback, host, timer });
  try {
    win.webContents.send('notification-permission-request', { requestId, domain: host });
  } catch {
    finishNotificationPermissionRequest(requestId, false);
    return true;
  }
  // Si la pestana que pidio el permiso se cierra antes de responder, se resuelve
  // en negativo: dejar el callback colgado retiene el webContents en memoria.
  try { webContents.once('destroyed', () => finishNotificationPermissionRequest(requestId, false)); } catch {}
  return true;
}

module.exports = {
  pendingNotificationPermissions,
  NOTIFICATION_PERMISSION_TIMEOUT_MS,
  finishNotificationPermissionRequest,
  requestNotificationsPermission,
};