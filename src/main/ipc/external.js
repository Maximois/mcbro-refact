'use strict';
/**
 * MC Browser -- src/main/ipc/external.js
 *
 * Los documentos/URLs que llegan "por fuera" del navegador: el argv con el que
 * se lanzó la app (o la segunda instancia), y el modo en que nos llegaron.
 *
 * Expone las funciones por las que main.js las consulta: consumePendingExternalUrl()
 * para el arranque caliente, setDocEditor/setPendingDocument para cuando llega el
 * modulo de documentos, y registerExternalIpc() para escuchar 'second-instance'.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA -- un documento tiene prioridad sobre una URL
 * -----------------------------------------------------------------------------
 * En second-instance se intenta primero openDocumentFromArgv(commandLine) y solo
 * después se ve si hubo URL. Un file-path arrastra una URL implifica (el ABSOLUTE
 * PATH suele contener "://..."), y si se usase extractExternalUrl primero,
 * "C:\\file.pdf" a veces es una URL illegal. Esa prioridad se mantiene tal cual.
 */

const { app } = require('electron');
const { getMainWin } = require('../runtime');

let pendingDocumentPath = '';
let docEditorMod = null;
let pendingExternalUrl = extractExternalUrl(process.argv);

function extractExternalUrl(argv = []) {
  return (Array.isArray(argv) ? argv : [])
    .map(value => String(value || '').replace(/^['"]|['"]$/g, ''))
    .find(value => /^https?:\/\//i.test(value)) || '';
}

function openDocumentFromArgv(argv) {
  if (!docEditorMod) return false;
  let p = '';
  try { p = docEditorMod.extractDocumentPath(argv) || ''; } catch { p = ''; }
  if (!p) return false;
  docEditorMod.handleExternalOpen(p).catch((e) => console.error('[DOC-ED]', e.message));
  return true;
}

function flushPendingDocument() {
  if (!pendingDocumentPath) return false;
  if (!openDocumentFromArgv([pendingDocumentPath])) return false;
  pendingDocumentPath = '';
  return true;
}

function openExternalUrl(url) {
  const target = extractExternalUrl([url]);
  if (!target) return false;
  if (!getMainWin() || getMainWin().isDestroyed()) {
    pendingExternalUrl = target;
    return false;
  }
  if (getMainWin().isMinimized()) getMainWin().restore();
  getMainWin().focus();
  if (getMainWin().webContents.isLoading()) {
    pendingExternalUrl = target;
    return false;
  }
  getMainWin().webContents.send('external-url', target);
  return true;
}

function consumePendingExternalUrl() {
  const t = pendingExternalUrl;
  pendingExternalUrl = '';
  return t || null;
}

function setPendingDocument(p) {
  if (p) pendingDocumentPath = p;
}

function setDocEditor(m) { docEditorMod = m; }

function registerExternalIpc() {
  app.on('second-instance', (_event, commandLine) => {
    try {
      // Un documento asociado tiene prioridad: si vino un archivo, se abre en la
      // pestana de Documentos en vez de navegar a una URL.
      if (openDocumentFromArgv(commandLine)) return;
      const target = extractExternalUrl(commandLine);
      if (target) openExternalUrl(target);
      if (getMainWin()) {
        if (getMainWin().isMinimized()) getMainWin().restore();
        getMainWin().focus();
      }
    } catch {}
  });
}

module.exports = {
  extractExternalUrl,
  openDocumentFromArgv,
  flushPendingDocument,
  openExternalUrl,
  consumePendingExternalUrl,
  setPendingDocument,
  setDocEditor,
  registerExternalIpc
};
