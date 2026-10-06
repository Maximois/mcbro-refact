'use strict';
/**
 * MC Browser -- src/main/data/history.js
 *
 * Propietario del historial de navegacion persistido (history.json).
 *
 * QUE HACE
 *   - Carga y guarda el historial en disco (con tope de 2000 entradas).
 *   - Expone el array vivo para que los handlers de IPC lo muten.
 *
 * QUE NO DEBE HACER
 *   - No registra IPC ni toca sesiones. Solo persistencia.
 *   - No deduplica mas alla de "no repetir la ultima entrada": esa regla vive
 *     en el handler porque depende de como el renderer envia las entradas.
 *
 * POR QUE UN OBJETO CONTENEDOR Y NO UN `let HISTORY` EXPORTADO
 *   HISTORY se REASIGNA en caliente, no solo se muta:
 *     - `history:clear`      -> HISTORY = []
 *     - `history:add`        -> HISTORY = HISTORY.slice(-2000) al pasar el tope
 *     - `clear-all`/`clear-data` con settings.history -> HISTORY = []
 *   Un `export let` de CommonJS no propaga la reasignacion al que ya lo
 *   importo, y `const { HISTORY } = require(...)` congela el array original:
 *   despues de un `history:clear` el importador seguiria viendo (y persistiendo)
 *   el historial viejo. Por eso el estado vive en `store.items` y se reasigna
 *   ahi. Ver docs/RESTRUCTURACION.md seccion 2.1.
 *
 *   REGLA PARA LOS IMPORTADORES: siempre `store.items`, nunca
 *   `const { items } = require(...)`. Y escribir siempre por
 *   `store.items = ...`, nunca por una copia local.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// Tope de entradas, aplicado en tres sitios independientes (load, save, add).
// Si se cambia, cambiar los tres: si no, se recorta en un sitio y se
// re-expande en otro al siguiente guardado.
const HISTORY_LIMIT = 2000;

const HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');
const store = { items: [] };

function load() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      const stored = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      if (Array.isArray(stored)) store.items = stored.slice(-HISTORY_LIMIT);
    }
  } catch (e) { console.error('[HISTORY] Load error:', e.message); }
}

function save() {
  try {
    const dir = path.dirname(HISTORY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(store.items.slice(-HISTORY_LIMIT), null, 2), 'utf8');
  } catch (e) { console.error('[HISTORY] Save error:', e.message); }
}

load();

module.exports = { store, HISTORY_PATH, HISTORY_LIMIT, load, save };