'use strict';
/**
 * MC Browser -- modulo document-editor / core/tables.js
 *
 * Operaciones puras sobre bloques `table` e `image`. Sin DOM ni Electron:
 * las usan igual el renderer (botones), el main (parches de la IA) y los tests.
 * Todas devuelven un bloque NUEVO; nunca mutan el de entrada. Si la operacion
 * no es valida devuelven null.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else { root.MCDoc = root.MCDoc || {}; root.MCDoc.tables = mod; }
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_ROWS = 100;
  const MAX_COLS = 20;
  const MIN_IMG = 16;
  const MAX_IMG = 2000;

  function int(v, lo, hi, def) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return def;
    return Math.min(hi, Math.max(lo, n));
  }

  function cols(block) {
    return Math.max(0, ...(block.rows || []).map(r => (Array.isArray(r) ? r.length : 0)));
  }

  /** Iguala el ancho de todas las filas (rellena con ''). */
  function rectangular(rows) {
    const n = Math.max(1, ...rows.map(r => r.length));
    return rows.map(r => { const c = r.slice(); while (c.length < n) c.push(''); return c; });
  }

  function create(nRows, nCols, header) {
    const r = int(nRows, 1, MAX_ROWS, 2);
    const c = int(nCols, 1, MAX_COLS, 2);
    const rows = [];
    for (let i = 0; i < r; i++) rows.push(new Array(c).fill(''));
    const block = { type: 'table', rows };
    block.header = header !== false;
    return block;
  }

  // El formato de las celdas (cellRuns, clave "fila,col") acompana a su celda
  // cuando se insertan o quitan filas y columnas.
  function remap(b, fn) {
    if (!b.cellRuns) return;
    const out = {};
    for (const key of Object.keys(b.cellRuns)) {
      const [r, c] = key.split(',').map(Number);
      const to = fn(r, c);
      if (to) out[to[0] + ',' + to[1]] = b.cellRuns[key];
    }
    if (Object.keys(out).length) b.cellRuns = out; else delete b.cellRuns;
  }

  function clone(block) {
    if (!block || block.type !== 'table' || !Array.isArray(block.rows) || !block.rows.length) return null;
    const b = Object.assign({}, block, { rows: rectangular(block.rows.map(r => (Array.isArray(r) ? r.map(String) : []))) });
    if (b.cellRuns) b.cellRuns = Object.assign({}, b.cellRuns);
    return b;
  }

  /** at = indice de la fila de referencia; where 'before' | 'after' (def. after). */
  function addRow(block, at, where) {
    const b = clone(block);
    if (!b || b.rows.length >= MAX_ROWS) return null;
    const i = int(at, 0, b.rows.length - 1, b.rows.length - 1);
    const at2 = where === 'before' ? i : i + 1;
    b.rows.splice(at2, 0, new Array(cols(b)).fill(''));
    remap(b, (r, c) => [r >= at2 ? r + 1 : r, c]);
    return b;
  }

  function deleteRow(block, at) {
    const b = clone(block);
    if (!b || b.rows.length <= 1) return null; // una tabla sin filas no existe
    const i = int(at, 0, b.rows.length - 1, -1);
    if (i < 0) return null;
    b.rows.splice(i, 1);
    remap(b, (r, c) => (r === i ? null : [r > i ? r - 1 : r, c]));
    return b;
  }

  function addCol(block, at, where) {
    const b = clone(block);
    if (!b || cols(b) >= MAX_COLS) return null;
    const i = int(at, 0, cols(b) - 1, cols(b) - 1);
    const at2 = where === 'before' ? i : i + 1;
    b.rows.forEach(r => r.splice(at2, 0, ''));
    remap(b, (r, c) => [r, c >= at2 ? c + 1 : c]);
    return b;
  }

  function deleteCol(block, at) {
    const b = clone(block);
    if (!b || cols(b) <= 1) return null;
    const i = int(at, 0, cols(b) - 1, -1);
    if (i < 0) return null;
    b.rows.forEach(r => r.splice(i, 1));
    remap(b, (r, c) => (c === i ? null : [r, c > i ? c - 1 : c]));
    return b;
  }

  function setCell(block, row, col, text) {
    const b = clone(block);
    if (!b) return null;
    const r = Number(row), c = Number(col);
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= b.rows.length || c >= cols(b)) return null;
    b.rows[r][c] = String(text == null ? '' : text);
    remap(b, (rr, cc) => (rr === r && cc === c ? null : [rr, cc]));
    return b;
  }

  function setHeader(block, on) {
    const b = clone(block);
    if (!b) return null;
    b.header = !!on;
    return b;
  }

  /**
   * Tamano de imagen. Con solo uno de width/height el otro sale de la
   * proporcion natural (nat = {width, height}) o de la que ya tiene el bloque.
   */
  function resizeImage(block, size, nat) {
    if (!block || block.type !== 'image') return null;
    const ref = nat && nat.width && nat.height ? nat
      : (block.width && block.height ? { width: block.width, height: block.height } : null);
    let w = size && size.width != null ? Number(size.width) : null;
    let h = size && size.height != null ? Number(size.height) : null;
    if (w != null && !isFinite(w)) return null;
    if (h != null && !isFinite(h)) return null;
    if (w == null && h == null) return null;
    if (ref) {
      const ratio = ref.width / ref.height;
      if (w != null && h == null) h = w / ratio;
      else if (h != null && w == null) w = h * ratio;
    }
    const next = Object.assign({}, block);
    if (w != null) next.width = int(w, MIN_IMG, MAX_IMG, null);
    if (h != null) next.height = int(h, MIN_IMG, MAX_IMG, null);
    // Si al limitar un lado se rompio la proporcion, el otro lo sigue.
    if (ref && w != null && h != null) {
      const ratio = ref.width / ref.height;
      if (Math.abs(next.width / next.height - ratio) / ratio > 0.02 && !(size.width != null && size.height != null)) {
        next.height = int(next.width / ratio, MIN_IMG, MAX_IMG, next.height);
      }
    }
    return next;
  }

  /** Reduce unas dimensiones naturales para que quepan en maxWidth px. */
  function fitWidth(nat, maxWidth) {
    const w = Math.max(1, Number(nat && nat.width) || 1);
    const h = Math.max(1, Number(nat && nat.height) || 1);
    const max = Math.max(MIN_IMG, Number(maxWidth) || 600);
    if (w <= max) return { width: int(w, MIN_IMG, MAX_IMG, w), height: int(h, MIN_IMG, MAX_IMG, h) };
    return { width: int(max, MIN_IMG, MAX_IMG, max), height: int(h * max / w, MIN_IMG, MAX_IMG, h) };
  }

  function setAlt(block, alt) {
    if (!block || block.type !== 'image') return null;
    const next = Object.assign({}, block);
    const a = String(alt == null ? '' : alt).slice(0, 300);
    if (a) next.alt = a; else delete next.alt;
    return next;
  }

  return { MAX_ROWS, MAX_COLS, MIN_IMG, MAX_IMG, cols, create, addRow, deleteRow, addCol, deleteCol,
    setHeader, setCell, resizeImage, fitWidth, setAlt };
});
