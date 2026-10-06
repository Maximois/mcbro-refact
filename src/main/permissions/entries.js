'use strict';
/**
 * MC Browser -- src/main/permissions/entries.js
 *
 * Escritura de las reglas de permisos por sitio en CFG.permissions y
 * CFG.permissionOrigins.
 *
 * QUE HACE
 *   - setPermissionEntry(domain, permission, value, origin)
 *   - removePermissionEntry(domain, permission)
 *   - Las normalizaciones de dominio y de mapa de permisos que usan.
 *
 * QUE NO DEBE HACER
 *   - No DECIDE permisos. Este modulo graba lo que el usuario (o una decision ya
 *     tomada) le pide; quien decide si algo se concede es
 *     lib/permissions.js a traves de adapters.js. Confundir las dos capas es el
 *     error grave: aqui se acepta cualquier `value` sin validar.
 *   - No registra IPC.
 *   - No guarda estado propio: escribe en CFG y llama a saveCfg().
 *
 * POR QUE ESTA SEPARADO DE notifications.js Y handlers.js
 *   Los tres se usan entre si: el dialogo de notificaciones necesita grabar la
 *   decision, y el handler de permisos de sesion necesita lanzar el dialogo.
 *   La dependencia va en una sola direccion — entries -> notifications ->
 *   handlers — para que no haya ciclo de require. Si alguna vez aparece uno,
 * es que falta un nivel por aqui.
 */

const Permissions = require('../../../lib/permissions');
const { CFG, saveCfg } = require('../config');

function normalizePermissionMap(value) {
  return Permissions.normalizePermissionMap(value);
}

function normalizePermissionOrigin(value) {
  return String(value || '').trim().replace(/^www\./i, '').replace(/^\.+/, '').toLowerCase();
}

function removePermissionEntry(domain, permission) {
  const host = String(domain || '').trim().replace(/^\.+/, '').toLowerCase();
  if (!host) return { ok: false, error: 'dominio obligatorio' };
  if (permission) {
    const entry = normalizePermissionMap(CFG.permissions[host]);
    delete entry[permission];
    if (Object.keys(entry).length) CFG.permissions[host] = entry;
    else delete CFG.permissions[host];
  } else {
    delete CFG.permissions[host];
  }
  if (Array.isArray(CFG.permissionOrigins)) {
    CFG.permissionOrigins = CFG.permissionOrigins.filter(item =>
      item && (item.domain !== host || (permission && item.permission !== permission))
    );
  }
  saveCfg();
  return { ok: true };
}

function setPermissionEntry(domain, permission, value = 'allow', origin) {
  const host = String(domain || '').trim().replace(/^\.+/, '').toLowerCase();
  const key = String(permission || '').trim();
  if (!host || !key) return { ok: false, error: 'faltan dominio o permiso' };
  CFG.permissions[host] = normalizePermissionMap(CFG.permissions[host]);
  CFG.permissions[host][key] = value;
  const source = normalizePermissionOrigin(origin);
  if (source) {
    if (!Array.isArray(CFG.permissionOrigins)) CFG.permissionOrigins = [];
    CFG.permissionOrigins = CFG.permissionOrigins.filter(item => !(item && item.domain === host && item.permission === key));
    CFG.permissionOrigins.push({ domain: host, permission: key, origin: source });
  }
  saveCfg();
  return { ok: true, permissions: CFG.permissions[host] };
}

module.exports = {
  normalizePermissionMap,
  normalizePermissionOrigin,
  removePermissionEntry,
  setPermissionEntry,
};