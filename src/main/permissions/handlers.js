'use strict';
/**
 * MC Browser -- src/main/permissions/handlers.js
 *
 * Puente entre Electron y lib/permissions: decide, por sesion, si se concede o
 * denies cada permiso.
 *
 * QUE HACE
 *   - setupSessionPermissionHandlers(sess): instala setPermissionRequestHandler y
 *     setPermissionCheckHandler en una sesion. Se llama una vez por sesion
 *     (principal y aisladas), nunca una sola vez global.
 *   - Los handlers de IPC de permisos: add-, set-site-, remove-, get-.
 *
 * QUE NO DEBE HACER
 *   - No decide la politica. La decision vive en lib/permissions.js, evaluada
 *     contra CFG a traves de adapters.js. Aqui solo se traduce el evento de
 *     Electron a una llamada.
 *   - No toca la red. El bloqueo de recursos por permisos de contenido es de
 *     src/main/navigation/guard.js; aqui solo van los permisos del navegador
 *     (camara, microfono, notificaciones, fullscreen...).
 *
 * POR QUE SE INSTALA POR SESION Y NO GLOBAL
 *   WebChat y WhatsApp tienen sus propias sesiones con politicas distintas
 *   (ver src/main/sessions/setup.js). Un setPermissionRequestHandler global
 *   aplicaria la politica del navegador principal a sitios que estan
 *   deliberadamente exentos.
 */

const { ipcMain } = require('electron');
const { CFG } = require('../config');
const { setPermissionEntry, removePermissionEntry } = require('./entries');
const {
  normalizeSiteHost,
  resolveMediaPermissionDecision,
  resolvePermissionDecision,
} = require('./adapters');
const { requestNotificationsPermission } = require('./notifications');

function setupSessionPermissionHandlers(sess) {
  const decide = (host, permission, details) => {
    const key = String(permission || '').trim();
    if (key === 'media') return resolveMediaPermissionDecision(host, details?.mediaTypes);
    return resolvePermissionDecision(host, key);
  };
  sess.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details?.requestingUrl || webContents?.getURL?.() || '';
    const host = normalizeSiteHost(requestingUrl);
    // Notificaciones es el unico permiso que consulta al usuario: el resto se
    // resuelve contra la configuracion sin preguntar. Solo se pregunta cuando no
    // hay regla previa para ese dominio (ni allow ni deny).
    if (String(permission || '').trim() === 'notifications' && host
        && requestNotificationsPermission(requestingUrl, webContents, callback)) {
      return;
    }
    callback(decide(host, permission, details));
  });
  sess.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const host = normalizeSiteHost(requestingOrigin || webContents?.getURL?.() || '');
    return decide(host, permission, details);
  });
}

// === IPC DE PERMISOS ===
ipcMain.handle('add-permission', (e, { domain, permission, value = 'allow' }) =>
  setPermissionEntry(domain, permission, value));
ipcMain.handle('set-site-permission', (e, { domain, permission, value = 'allow', origin }) =>
  setPermissionEntry(domain, permission, value, origin));
ipcMain.handle('remove-permission', (e, { domain, permission }) => removePermissionEntry(domain, permission));
ipcMain.handle('remove-site-permission', (e, { domain, permission }) => removePermissionEntry(domain, permission));
ipcMain.handle('get-permissions', () => ({ ...CFG.permissions }));
ipcMain.handle('get-permission-origins', () => (Array.isArray(CFG.permissionOrigins) ? [...CFG.permissionOrigins] : []));

module.exports = {
  setupSessionPermissionHandlers,
};