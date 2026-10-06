'use strict';
/**
 * MC Browser -- src/main/permissions/adapters.js
 *
 * Puentes entre lib/permissions (funciones puras, testeadas) y el resto de la
 * aplicacion, que necesita que esas reglas se apliquen contra el CFG vivo.
 *
 * POR QUE EXISTE ESTE CAPA INTERMEDIA
 *   lib/permissions.js esta escrito como funciones puras: reciben `cfg` como
 *   parametro. No puede hacerlo de otro modo, porque si leyera un modulo global
 *   (1) dejaria de ser testeable en Node sin Electron y (2) crearia un ciclo de
 *   require con src/main/config.
 *
 *   main.js, en cambio, tiene CFG a mano. Estos wrappers son los que hacen la
 *   atadura: `Permissions.resolvePermissionDecision(host, key, CFG)`. Todas las
 *   funciones de aqui son de una linea y no anaden logica. Su valor es otro:
 *   son el punto unico donde se ve que "esta regla de lib/permissions se aplica
 *   contra la configuracion actual", y donde se puede colgar una instrumentacion
 *   o una validacion adicional sin tocar 70 call sites.
 *
 * QUE NO DEBE HACER
 *   - No decide nada. Si necesitas una regla nueva, va en lib/permissions.js,
 *     que tiene sus tests. Este archivo no tiene tests propios porque no tiene
 *     logica propia.
 *   - No muta CFG.
 */

const Permissions = require('../../../lib/permissions');
const { CFG } = require('../config');

function normalizeSiteHost(url) {
  return Permissions.normalizeSiteHost(url);
}

// TRAMPA — CODIGO MUERTO: ni este wrapper ni su equivalente de main.js tienen
// callers (verificado por conteo de identificadores sobre el main.js original,
// 5162 lineas). El codigo que necesita la normalizacion llama directo a
// lib/permissions. Se conserva para que el commit de extraccion fuera puro;
// su borrado queda para despues.
function normalizeGlobalBlockPattern(value) {
  return Permissions.normalizeGlobalBlockPattern(value);
}

function parseGlobalBlockRule(value) {
  return Permissions.parseGlobalBlockRule(value);
}

function isGlobalBlockMatch(requestHost, documentHost, rule) {
  return Permissions.isGlobalBlockMatch(requestHost, documentHost, rule);
}

function getPermissionRuleForHost(host, permission) {
  return Permissions.getPermissionRuleForHost(host, permission, CFG);
}

function isSitePermissionAllowed(host) {
  return Permissions.isSitePermissionAllowed(host, CFG);
}

function resolvePermissionDecision(host, permissionKey) {
  return Permissions.resolvePermissionDecision(host, permissionKey, CFG);
}

// Electron entrega los pedidos de camara/microfono bajo un unico tipo
// 'media' (no 'camera' / 'microphone'); para distinguirlos hay que mirar
// details.mediaTypes ('video' | 'audio'). Ver lib/permissions.js.
function resolveMediaPermissionDecision(host, mediaTypes) {
  return Permissions.resolveMediaPermissionDecision(host, mediaTypes, CFG);
}

function getAllowlistPolicyForHost(host) {
  return Permissions.getAllowlistPolicyForHost(host, CFG);
}

module.exports = {
  normalizeSiteHost,
  normalizeGlobalBlockPattern,
  parseGlobalBlockRule,
  isGlobalBlockMatch,
  getPermissionRuleForHost,
  isSitePermissionAllowed,
  resolvePermissionDecision,
  resolveMediaPermissionDecision,
  getAllowlistPolicyForHost,
};