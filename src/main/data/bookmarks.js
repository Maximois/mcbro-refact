'use strict';
/**
 * MC Browser -- src/main/data/bookmarks.js
 *
 * Propietario de los marcadores persistidos (bookmarks.json).
 *
 * QUE HACE
 *   - Carga y guarda la lista de marcadores en disco.
 *   - Expone el array vivo para que los handlers de IPC lo muten.
 *
 * QUE NO DEBE HACER
 *   - No registra IPC, no normaliza URLs y no busca favicons. Es solo el
 *     almacen; las reglas de deduplicacion y de presentacion viven en el
 *     renderer (src/renderer.html).
 *
 * POR QUE UN OBJETO CONTENEDOR Y NO UN `let BOOKMARKS` EXPORTADO
 *   BOOKMARKS se REASIGNA en caliente, no solo se muta: `bookmarks:remove`
 *   hace `BOOKMARKS = BOOKMARKS.filter(...)`. Un `export let` de CommonJS no
 *   propaga esa reasignacion, y `const { BOOKMARKS } = require(...)` dejaria
 *   al importador apuntando al array viejo (borrado incluido). El estado vive
 *   en `store.items`. Mismo motivo y mismo contrato que en history.js.
 *   Ver docs/RESTRUCTURACION.md seccion 2.1.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const BOOKMARKS_PATH = path.join(app.getPath('userData'), 'bookmarks.json');
const store = { items: [] };

function load() {
  try {
    if (fs.existsSync(BOOKMARKS_PATH)) {
      store.items = JSON.parse(fs.readFileSync(BOOKMARKS_PATH, 'utf8'));
    }
  } catch (e) { console.error('[BOOKMARKS] Load error:', e.message); }
}

function save() {
  try {
    const dir = path.dirname(BOOKMARKS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(BOOKMARKS_PATH, JSON.stringify(store.items, null, 2), 'utf8');
  } catch (e) { console.error('[BOOKMARKS] Save error:', e.message); }
}

load();

module.exports = { store, BOOKMARKS_PATH, load, save };