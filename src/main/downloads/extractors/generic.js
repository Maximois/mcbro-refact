'use strict';
/**
 * MC Browser -- src/main/downloads/extractors/generic.js
 *
 * Fallback para cualquier host sin logica propia: solo valida que sea una URL
 * http(s). No sabe re-fabricar enlaces (no exporta mint): el reanudador con
 * Range usa la URL original y, si el servidor contesta 200 (ignora Range),
 * continua saltando los bytes ya bajados sin reiniciar.
 */

function match(u) {
  try { return /^https?:\/\//i.test(String(u)); } catch { return false; }
}

module.exports = { name: 'generic', match };