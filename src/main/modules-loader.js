'use strict';
/**
 * MC Browser -- src/main/modules-loader.js
 *
 * Punto único de registro de los módulos externos: AI, whatsapp-extractor,
 * editor de documentos y adblocker. Cada uno va en try/catch propio porque son
 * independientes: si uno falla, los demás registran igualmente.
 *
 * El AI module tiene una alternativa más pequeña (aiFallbacks) que registra
 * stubs para los canales ai:*. Esos stubs solo viven en el catch: nunca deben
 * registrar los mismos canales reales que el módulo principal, así que el
 * orden importa — primero se intenta el módulo AI y solo si falla se cargan los
 * stubs.
 */

const { ipcMain } = require('electron');

function aiFallbacks(ctx) {
  ipcMain.handle('ai:config:get', () => ctx.aiConfig);
  ipcMain.handle('ai:config:save', (_e, cfg) => { ctx.aiConfig = { ...ctx.aiConfig, ...cfg }; ctx.saveCfg(); return ctx.aiConfig; });
  const aiUnavail = () => ({ error: 'AI module not available' });
  ['ai:chat','ai:chat:abort','ai:models','ai:dl:url','ai:exec','ai:session:load',
   'ai:page:dom','ai:web:fetch','ai:fetch:url','ai:script:run',
   'ai:page:resources','ai:page:console','ai:scraping:isolate',
   'ai:scraping:analyze-structure','ai:scraping:extract-pattern',
   'ai:scraping:detect-dynamic','ai:scraping:discover-apis','ai:scraping:metrics',
   'ai:security:analyze-url','ai:security:analyze-html',
   'ai:auto-scrape','ai:get-cache','ai:clear-cache'].forEach(ch =>
    ipcMain.handle(ch, aiUnavail));
  ipcMain.handle('ai:decode', () => ({ error: 'AI module not available' }));
  ipcMain.handle('ai:security:rules', () => ({ error: 'AI module not available' }));
  ipcMain.handle('ai:security:rule:toggle', () => ({ error: 'AI module not available' }));
  ipcMain.handle('ai:security:rule:add', () => ({ error: 'AI module not available' }));
  ipcMain.handle('ai:adblock:info', () => ({ ok: true, blockAds: false, rulesCount: 0 }));
  ipcMain.handle('ai:adblock:import', async () => ({ error: 'AI module not available' }));
  ipcMain.handle('ai:adblock:test', async () => ({ error: 'AI module not available' }));
}

function registerModules(deps) {
  const { CFG, saveCfg, getMainWin, ACTIONS, External, sess,
          NavDomains, MediaDetect, StatsTracker, RequestGuard, DoH,
          resolveSafePath } = deps;

  // AI module
  try {
    const m = require('../../modules/ai-assistant/main');
    m.setup({ cfg: CFG, aiConfig: CFG.aiConfig, saveCfg, emit: ACTIONS.emit, getMainWin });
  } catch (e) {
    console.error('[AI]', e.message);
    aiFallbacks({ aiConfig: CFG.aiConfig, saveCfg });
  }

  // WhatsApp extractor module (independiente)
  try {
    const m = require('../../modules/whatsapp-extractor/main');
    m.setup({ cfg: CFG, resolveSafePath });
  } catch (e) { console.error('[WA-EXTRACT]', e.message); }

  // Editor de documentos (PDF/DOCX/TXT/MD). Dueño del archivo y del
  // documento abierto; el renderer es una vista y la IA usa los mismos
  // handlers de parche.
  try {
    const m = require('../../modules/document-editor/main');
    m.setup({ cfg: CFG, getMainWin });
    External.setDocEditor(m);
    // Si se lanzo la app haciendo doble clic en un .pdf/.docx, la ruta quedo
    // esperando en pendingDocumentPath. Se intenta ahora y, si todavía no esta
    // lista la ventana, en did-finish-load.
    try {
      External.setPendingDocument(m.extractDocumentPath(process.argv));
    } catch {}
    External.flushPendingDocument();
  } catch (e) { console.error('[DOC-ED]', e.message); }

  // Adblocker module
  try {
    const m = require('../../modules/adblocker/main');
    const ret = m.setup({ cfg: CFG, saveCfg, emit: ACTIONS.emit, session: sess, allowedDomains: NavDomains.AUTH_DOMAINS, mediaCallback: MediaDetect.checkMedia, requestCallback: StatsTracker.recordObservedRequest, blockCallback: StatsTracker.recordBlockedRequest, requestGuard: RequestGuard.createRequestGuard() });
    if (ret && ret.toggleBlocking) ACTIONS.adblockToggle = ret.toggleBlocking;
  } catch (e) { console.error('[ADBLOCK]', e.message); }

  // Apply initial DoH config if enabled
  DoH.applyDoH();
}

module.exports = { registerModules, aiFallbacks };
