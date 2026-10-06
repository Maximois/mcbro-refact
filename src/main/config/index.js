'use strict';
/**
 * MC Browser -- src/main/config/index.js
 *
 * Propietario de la configuracion persistida de la aplicacion (cfg.json).
 *
 * QUE HACE
 *   - Define el objeto CFG con sus valores por defecto.
 *   - Lo carga de disco y lo guarda.
 *   - Aplica las migraciones/defaults que el usuario no configuro.
 *   - Valida los parches de configuracion que llegan del renderer
 *     (sanitizeCfgPatch + CFG_WRITABLE) y produce el snapshot que ve la UI.
 *
 * QUE NO DEBE HACER
 *   - Tocar sesiones, User-Agent, red o permisos. Este modulo solo persiste
 *     y valida datos. Los efectos los aplican los modulos duenos, leyendo CFG.
 *   - Registrar handlers de IPC que dependan de estar dentro de app.whenReady().
 *     Los handlers de configuracion se registran a nivel de modulo (ver
 *     src/main/ipc/), para que existan siempre.
 *
 * INVARIANTE CRITICO — CFG se reasigna, pero solo una vez
 *   loadCfg() hace `CFG = { ...CFG, ...saved }`, es decir crea un objeto NUEVO.
 *   Es la unica reasignacion de CFG en toda la aplicacion, y ocurre aqui mismo
 *   al final de este archivo. Por eso:
 *     - Cualquier modulo puede hacer `const { CFG } = require('./config')` una
 *       sola vez al cargarse y guardar esa referencia: ya es la definitiva.
 *     - NO se puede pasar CFG a un modulo que se cargue ANTES de este archivo,
 *       ni guardarlo en un sitio que se evalue antes.
 *   Ver docs/RESTRUCTURACION.md seccion 2.1.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { sanitizeAiConfigForPublic } = require('../../../lib/permissions');

// Resultado de readGpuAccelerationPref(), inyectado por main.js ANTES de
// app.ready (la decision de desactivar la aceleracion por hardware tiene que
// tomar antes de que Electron arranque el proceso GPU). Lo lee cfgSnapshot()
// para poder avisarle a la UI que el cambio de gpuAcceleration exige reiniciar.
let gpuRuntimeActive = false;
function setGpuRuntimeActive(value) {
  gpuRuntimeActive = value === true;
}

// === CFG PERSISTENCE (no toca UA ni sesión) ===
const CFG_PATH = path.join(app.getPath('userData'), 'cfg.json');
let CFG = {
  blockAds: true, blockTrackers: false, blockThirdParty: false,
  strictDomainIsolation: true,
  strictDomainIsolationVersion: 2,
  dohStrict: true,
  spoofUA: false, blockFingerprint: false,
  gpuAcceleration: false,
  cookiePolicy: 'allow-all', dohEnabled: false, dohServer: 'cloudflare',
  proxyEnabled: false, proxyType: 'socks5', proxyHost: '', proxyPort: 1080,
  mediaDetect: false, httpsOnly: true,
  ntSearchSize: 'x1', ntIconSize: 'x1', ntLogoSize: 'x1', ntStatsSize: 'x1',
  uiTextSize: 'x1',
  currentUA: 'win-chrome', rotateUA: false,
  language: '', refererPolicy: '',
  downloadDir: '', allowlist: {}, adblockAllowlist: [], adblockAllowedSites: [], customRules: [], permissions: {}, permissionOrigins: [], resourceRules: [], userCosmeticRules: [],
  extraSessions: [],
  aiConfig: {
    provider: 'ollama', ollamaUrl: 'http://localhost:11434', ollamaModel: 'qwen2.5:1.5b',
    openaiKey: '', openaiModel: 'gpt-4o',
    geminiKey: '', geminiModel: 'gemini-2.0-flash',
    groqKey: '', groqModel: 'mixtral-8x7b-32768',
    opencodeKey: '', opencodeModel: 'opencode-zen-1'
  }
};
function loadCfg() {
  try {
    if (fs.existsSync(CFG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
      CFG = { ...CFG, ...saved };
      if (saved.aiConfig) CFG.aiConfig = { ...CFG.aiConfig, ...saved.aiConfig };
      if (saved.strictDomainIsolationVersion === undefined || saved.strictDomainIsolationVersion < 2) {
        CFG.strictDomainIsolation = true;
        CFG.strictDomainIsolationVersion = 2;
        saveCfg();
      }
      if (CFG.gpuAcceleration !== true) CFG.gpuAcceleration = false;
    }
  } catch {}
}
function saveCfg() {
  try {
    const dir = path.dirname(CFG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CFG_PATH, JSON.stringify(CFG, null, 2), 'utf8');
  } catch (e) {
    console.error('[CFG] Error saving:', e.message);
  }
}
loadCfg();

// === DOMINIOS CON SESIÓN PERSISTENTE POR DEFECTO ===
// Cuando cookiePolicy es 'session', todas las cookies se degradan a sesión
// (no persisten entre reinicios). Estos dominios necesitan cookies
// persistentes para que el login funcione correctamente. Esta lista solo
// controla cookies y no sustituye la política del adblocker. Solo se añaden
// si el usuario no ha configurado ya una regla para ellos.
const DEFAULT_SESSION_DOMAINS = [
  'gemini.google.com', 'accounts.google.com',
  'facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com',
  'instagram.com', 'www.instagram.com', 'i.instagram.com', 'm.instagram.com'
];
function ensureDefaultSessionDomains() {
  try {
    if (!CFG.allowlist || typeof CFG.allowlist !== 'object') CFG.allowlist = {};
    let changed = false;
    for (const domain of DEFAULT_SESSION_DOMAINS) {
      if (CFG.allowlist[domain] === undefined) {
        CFG.allowlist[domain] = 'allow';
        changed = true;
      }
    }
    if (changed) saveCfg();
  } catch (e) { console.error('[CFG] Error applying default session domains:', e.message); }
}

// === REGLAS NATIVAS SITE-SCOPED (publicidad en YouTube) ===
// Se aplican solo dentro de youtube.com para no interferir en otros sitios.
const DEFAULT_SITE_RULES = [
  { pattern: '*.doubleclick.net', action: 'block', site: 'youtube.com' },
  { pattern: '*.googlesyndication.com', action: 'block', site: 'youtube.com' },
  { pattern: 'googleadservices.com', action: 'block', site: 'youtube.com' },
  { pattern: 'static.googleadservices.com', action: 'block', site: 'youtube.com' },
  { pattern: 'adservice.google.com', action: 'block', site: 'youtube.com' },
  { pattern: 'googletagmanager.com', action: 'block', site: 'youtube.com' }
];
function ensureDefaultSiteRules() {
  try {
    if (!Array.isArray(CFG.customRules)) CFG.customRules = [];
    let changed = false;
    for (const rule of DEFAULT_SITE_RULES) {
      // 1. Asegurar la regla site-scoped
      const exists = CFG.customRules.some(r => r && r.pattern === rule.pattern && r.site === rule.site);
      if (!exists) {
        CFG.customRules.push(rule);
        changed = true;
      }
      // 2. Convertir reglas globales del mismo patrón a site-scoped (no interferir en otros sitios)
      const globalRules = CFG.customRules.filter(r => r && r.pattern === rule.pattern && !r.site);
      for (const gr of globalRules) {
        CFG.customRules = CFG.customRules.filter(r => r !== gr);
        changed = true;
      }
    }
    // 3. Eliminar reglas globales cubiertas por wildcards site-scoped (ej. static.doubleclick.net cubierto por *.doubleclick.net)
    const siteWildcards = CFG.customRules.filter(r => r && r.site && String(r.pattern).startsWith('*.'));
    const globalRules2 = CFG.customRules.filter(r => r && !r.site);
    for (const gr of globalRules2) {
      const covered = siteWildcards.some(w => {
        const base = String(w.pattern).slice(2).toLowerCase();
        const p = String(gr.pattern).toLowerCase().replace(/^https?:\/\//i, '').split('/')[0];
        return p === base || p.endsWith('.' + base);
      });
      if (covered) {
        CFG.customRules = CFG.customRules.filter(r => r !== gr);
        changed = true;
      }
    }
    // 4. Eliminar del allowlist GLOBAL los dominios de publicidad de YouTube,
    //    para que solo apliquen como reglas site-scoped (no mezclar con globales)
    if (CFG.allowlist && typeof CFG.allowlist === 'object') {
      for (const key of Object.keys(CFG.allowlist)) {
        const k = String(key).replace(/^https?:\/\//i, '').split('/')[0].replace(/^\.+/, '').toLowerCase();
        if (!k) continue;
        const covered = DEFAULT_SITE_RULES.some(r => {
          const base = String(r.pattern).replace(/^\*\./, '').toLowerCase();
          return k === base || k.endsWith('.' + base);
        });
        if (covered) {
          delete CFG.allowlist[key];
          changed = true;
        }
      }
    }
    if (changed) saveCfg();
  } catch (e) {
    console.error('[CFG] Error applying default site rules:', e.message);
  }
}
ensureDefaultSiteRules();
ensureDefaultSessionDomains();

function cfgSnapshot() {
  return {
    ...CFG,
    aiConfig: sanitizeAiConfigForPublic(CFG.aiConfig),
    gpuAccelerationActive: gpuRuntimeActive,
    gpuAccelerationPendingRestart: CFG.gpuAcceleration === true !== gpuRuntimeActive
  };
}

// ── Validación de update-cfg ──────────────────────
// El renderer solo debe poder escribir estos campos. Todo lo demás en CFG
// (allowlist, customRules, permissions, extraSessions, aiConfig, proxy...)
// se modifica por handlers dedicados, que son los que validan su entrada.
//
// 'rotateUA' NO está a propósito (updateUA() en src/renderer.html lo manda en
// su patch y hoy se descarta en silencio). La rotación de UA está desactivada
// porque Google OAuth solo funciona con el UA nativo de Electron. Cuando se
// implemente: agregarlo aquí como 'bool' Y hacer que el UA se aplique de verdad
// — rotateIdentity() sigue siendo un stub y currentUA solo se guarda/displaya.
// Ojo: applyFP() corre en el mundo aislado del preload y no alcanza la página.
const CFG_WRITABLE = {
  // booleanos
  blockAds: 'bool', blockTrackers: 'bool', blockThirdParty: 'bool',
  strictDomainIsolation: 'bool', spoofUA: 'bool', blockFingerprint: 'bool',
  gpuAcceleration: 'bool', dohEnabled: 'bool', mediaDetect: 'bool', httpsOnly: 'bool',
  // enumeraciones
  dohServer: 'dohServer', cookiePolicy: 'cookiePolicy', refererPolicy: 'refererPolicy',
  language: 'lang', currentUA: 'ua', uiTextSize: 'scale',
  // escalas de la página de inicio
  ntSearchSize: 'scale', ntIconSize: 'scale', ntLogoSize: 'scale', ntStatsSize: 'scale',
};

const CFG_DOH_SERVERS = ['cloudflare', 'google', 'quad9', 'nextdns', 'adguard', 'mullvad', 'cleanbrowsing'];
const CFG_COOKIE_POLICIES = ['allow-all', 'session'];
const CFG_REFERRER_POLICIES = ['no-referrer', 'origin', 'strict-origin', 'same-origin', 'origin-when-cross-origin', 'strict-origin-when-cross-origin', 'unsafe-url', ''];
const CFG_LANGS = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'ja-JP', 'es-419', 'es-AR', 'pt-BR', 'it-IT', 'ru-RU', 'zh-CN', 'ko-KR', 'ar-SA', 'hi-IN', 'nl-NL', 'pl-PL', 'tr-TR'];
const CFG_SCALES = ['x1', 'x2', 'x4', 'x8'];

function readUaLabels() {
  try {
    // El archivo se leia desde la raiz del proyecto cuando esto vivia en main.js.
    // Este modulo vive un nivel mas abajo, asi que sube tres directorios.
    const html = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'renderer.html'), 'utf8');
    const m = /const UA_LABELS\s*=\s*\{([\s\S]*?)\}/.exec(html);
    const keys = [];
    if (m) for (const line of m[1].split('\n')) {
      const km = /^\s*'([^']+)'\s*:/.exec(line);
      if (km) keys.push(km[1]);
    }
    return keys;
  } catch { return []; }
}
const CFG_UA_KEYS = readUaLabels();
// Perfiles reales del <select id="ua-select"> (pueden diferir de UA_LABELS).
const CFG_UA_OPTIONS = ['win-chrome', 'win-edge', 'mac-safari', 'linux-ff', 'android', 'iphone'];

// Devuelve solo los campos permitidos y ya validados. Descarta el resto.
function sanitizeCfgPatch(patch) {
  const clean = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return clean;
  for (const [key, value] of Object.entries(patch)) {
    // Ignora cualquier prototipo heredado: solo propiedades propias.
    if (!Object.prototype.hasOwnProperty.call(CFG_WRITABLE, key)) continue;
    const kind = CFG_WRITABLE[key];
    if (kind === 'bool') {
      if (typeof value === 'boolean') clean[key] = value;
    } else if (Array.isArray(CFG_SCALES) && kind === 'scale') {
      if (CFG_SCALES.includes(value)) clean[key] = value;
    } else if (kind === 'dohServer') {
      if (CFG_DOH_SERVERS.includes(value)) clean[key] = value;
    } else if (kind === 'cookiePolicy') {
      if (CFG_COOKIE_POLICIES.includes(value)) clean[key] = value;
    } else if (kind === 'refererPolicy') {
      if (typeof value === 'string' && CFG_REFERRER_POLICIES.includes(value)) clean[key] = value;
    } else if (kind === 'lang') {
      if (typeof value === 'string' && CFG_LANGS.includes(value)) clean[key] = value;
    } else if (kind === 'ua') {
      // El <select> ofrece más perfiles que las etiquetas de display (win-chrome,
      // mac-safari, android). Aceptamos ambos conjuntos.
      if (typeof value === 'string' && (CFG_UA_KEYS.includes(value) || CFG_UA_OPTIONS.includes(value))) clean[key] = value;
    }
  }
  return clean;
}

// Convierte un nombre de archivo en ruta dentro de baseDir, sin poder escapar.
function resolveSafePath(baseDir, name) {
  const base = path.resolve(baseDir);
  const raw = String(name == null ? '' : name);
  // Descarta separadores, '..' y rutas absolutas de cualquier sabor.
  const safe = raw.replace(/[\\/]+/g, '_').replace(/^\.+/, '').trim();
  if (!safe) return null;
  const resolved = path.resolve(base, safe);
  // Debe ser un archivo dentro de base, no el propio directorio.
  if (resolved === base || !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

// Confina una ruta arbitraria a baseDir (para abrir/leer archivos ya guardados).
//
// TRAMPA — CODIGO MUERTO: no tiene ni una llamada en toda la aplicacion
// (verificado por conteo de identificadores sobre el archivo original).
// Se conserva aqui para que este commit sea un movimiento puro; su borrado
// queda como commit posterior. La incertidumbre a futuro es real: con el
// nombre "isPathInside" y este comentario, alguien asumira que es la
// proteccion de rutas que protege resolveSafePath, y no lo es — las rutas
// ya guardadas por el usuario se abren sin pasar por ninguna comprobacion.
function isPathInside(baseDir, target) {
  if (!target) return false;
  const base = path.resolve(baseDir);
  const resolved = path.resolve(String(target));
  return resolved === base || resolved.startsWith(base + path.sep);
}

module.exports = {
  CFG_PATH,
  CFG,
  loadCfg,
  saveCfg,
  setGpuRuntimeActive,
  cfgSnapshot,
  sanitizeCfgPatch,
  CFG_WRITABLE,
  CFG_DOH_SERVERS,
  CFG_COOKIE_POLICIES,
  CFG_REFERRER_POLICIES,
  CFG_LANGS,
  CFG_SCALES,
  CFG_UA_KEYS,
  CFG_UA_OPTIONS,
  DEFAULT_SESSION_DOMAINS,
  DEFAULT_SITE_RULES,
  ensureDefaultSessionDomains,
  ensureDefaultSiteRules,
  resolveSafePath,
  isPathInside,
};