'use strict';
/**
 * MC Browser -- modulo document-editor / core/model.js
 *
 * Modelo canonico de documento. Es la pieza central del modulo: PDF y DOCX
 * son solo importadores y exportadores de este formato.
 *
 * Decisiones que conviene no romper:
 *  - Un bloque tiene `text` O `runs`. Nunca ambos. `runs` existe para el
 *    formato mixto dentro de un parrafo (media palabra en negrita); si se
 *    escribe `text` se limpian los `runs`. Asi los tres formatos convergen.
 *  - `hash` es contenido, no identidad: cambia con cada mutacion. Es lo que
 *    permite que un parche de la IA falle en vez de pisar una edicion que no
 *    vio. No es criptografico, es deteccion de concurrencia optimista.
 *  - Toda funcion de este archivo es pura y no depende de Electron, del DOM
 *    ni de Node: se usa igual en el main, en el renderer y en los tests.
 */

(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.MCDoc = window.MCDoc || {};
    window.MCDoc.model = mod;
  }
})(this, function () {
  const SCHEMA = 'mc-doc/1';

  // Carta / A4 en puntos, con margenes de 2 cm.
  const PAGE = {
    A4:      { width: 595.28, height: 841.89, margin: 56.7 },
    LETTER:  { width: 612,    height: 792,    margin: 72 }
  };

  const BLOCK_TYPES = ['heading', 'paragraph', 'list', 'quote', 'code', 'image', 'table', 'pagebreak', 'hr'];
  const ALIGNS = ['left', 'center', 'right', 'justify'];

  let idSeq = 0;
  function genId(prefix) {
    idSeq = (idSeq + 1) % 0xFFFFFF;
    const rand = Math.floor(Math.random() * 0xFFFFFF).toString(36);
    return `${prefix || 'b'}${Date.now().toString(36)}${idSeq.toString(36)}${rand}`;
  }

  // --------------------------------------------------------------- texto

  /** Texto plano de un bloque, incluyendo runs. */
  function blockText(block) {
    if (!block) return '';
    if (Array.isArray(block.runs) && block.runs.length) {
      return block.runs.map(r => (r && r.text) || '').join('');
    }
    return block.text == null ? '' : String(block.text);
  }

  /** Devuelve una copia del bloque con `text` y sin `runs`. */
  function withText(block, text) {
    const next = Object.assign({}, block);
    next.text = text == null ? '' : String(text);
    delete next.runs;
    return next;
  }

  function hasFormatting(block) {
    if (!block) return false;
    return Boolean(block.bold || block.italic || block.underline);
  }

  // ------------------------------------------------------------ normalizar

  function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  // Nombre de familia tipografica: letras, numeros, espacios y . _ - (sin
  // comillas ni punto y coma: va a parar a un atributo style y a un DOCX).
  const FONT_RE = /^[\p{L}\p{N} ._-]{1,60}$/u;
  const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
  // Solo enlaces que un documento puede llevar sin riesgo: nada de javascript:
  // ni data:. Sin espacios ni comillas, porque va a un atributo y a un DOCX.
  const LINK_RE = /^(https?:\/\/|mailto:)[^\s"'<>]{1,2000}$/i;
  const isSafeLink = (url) => LINK_RE.test(String(url == null ? '' : url).trim());

  /**
   * Un tramo con formato. bold/italic/underline/strike admiten `false`
   * explicito (ver core/runs.js): normalizeBlock descarta los redundantes.
   */
  function normalizeRun(run) {
    if (!run) return null;
    const text = run.text == null ? '' : String(run.text);
    if (!text) return null;
    const out = { text };
    for (const key of ['bold', 'italic', 'underline', 'strike']) {
      if (run[key] === true) out[key] = true;
      else if (run[key] === false) out[key] = false;
    }
    if (run.color && HEX_RE.test(String(run.color))) out.color = String(run.color);
    if (run.highlight && HEX_RE.test(String(run.highlight))) out.highlight = String(run.highlight);
    if (run.font && FONT_RE.test(String(run.font).trim())) out.font = String(run.font).trim();
    if (run.size != null) out.size = clampInt(run.size, 4, 96, null);
    if (run.link && isSafeLink(run.link)) out.link = String(run.link).trim();
    return out;
  }

  /**
   * Descarta los `false` que no cambian nada (un tramo no-negrita en un
   * parrafo que no es negrita) y fusiona tramos contiguos con igual formato.
   */
  function compactBlockRuns(block) {
    const defaults = {
      bold: block.type === 'heading' || block.bold === true,
      italic: block.italic === true,
      underline: block.underline === true,
      strike: false
    };
    const keys = ['bold', 'italic', 'underline', 'strike', 'color', 'highlight', 'font', 'size', 'link'];
    const out = [];
    for (const run of block.runs) {
      const next = Object.assign({}, run);
      for (const k of ['bold', 'italic', 'underline', 'strike']) {
        if (next[k] === false && !defaults[k]) delete next[k];
      }
      const last = out[out.length - 1];
      if (last && keys.every((k) => last[k] === next[k])) last.text += next.text;
      else out.push(next);
    }
    return out;
  }

  // ---- formato dentro de items de lista y celdas de tabla ----------------
  // `items` y `rows` siguen siendo texto plano (es lo que leen el buscador, el
  // markdown, la IA...). El formato de un fragmento vive aparte:
  //   list.itemRuns = [runs | null, ...]      (uno por item)
  //   table.cellRuns = { "fila,col": runs }   (solo celdas con formato)
  // Regla: el texto plano manda. Si los tramos ya no dicen lo mismo que el
  // texto (alguien edito el texto sin pasar por el formato), se descartan.
  const FORMAT_KEYS = ['bold', 'italic', 'underline', 'strike'];
  function runsHaveFormat(runs) {
    return runs.some(r => FORMAT_KEYS.some(k => r[k] === true) || r.color || r.highlight || r.font || r.size || r.link);
  }
  function richRunsFor(rawRuns, text, trim) {
    if (!Array.isArray(rawRuns)) return null;
    let runs = rawRuns.map(normalizeRun).filter(Boolean);
    if (trim && runs.length) {
      runs = runs.map(r => Object.assign({}, r));
      runs[0].text = runs[0].text.replace(/^\s+/, '');
      runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '');
      runs = runs.filter(r => r.text.length);
    }
    if (!runs.length || !runsHaveFormat(runs)) return null;
    return runs.map(r => r.text).join('') === text ? runs : null;
  }

  function normalizeBlock(raw) {
    if (!raw) return null;
    const type = BLOCK_TYPES.includes(raw.type) ? raw.type : 'paragraph';
    const block = { id: raw.id ? String(raw.id) : genId(), type };

    if (type === 'heading') {
      block.level = clampInt(raw.level, 1, 3, 1);
      const t = blockText(raw);
      if (Array.isArray(raw.runs)) block.runs = raw.runs.map(normalizeRun).filter(Boolean);
      else block.text = t;
      if (!block.text && !block.runs) return null;
    } else if (type === 'list') {
      const rawItems = Array.isArray(raw.items) ? raw.items : String(raw.text || '').split('\n');
      const items = [];
      const itemRuns = [];
      rawItems.forEach((item, i) => {
        const text = (item && typeof item === 'object' ? blockText(item) : String(item == null ? '' : item)).trim();
        if (!text.length) return;
        items.push(text);
        itemRuns.push(richRunsFor(Array.isArray(raw.itemRuns) ? raw.itemRuns[i] : null, text, true));
      });
      if (!items.length) return null;
      block.items = items;
      if (itemRuns.some(Boolean)) block.itemRuns = itemRuns;
      block.ordered = raw.ordered === true;
      if (raw.level != null) block.level = clampInt(raw.level, 0, 3, 0);
    } else if (type === 'table') {
      const rows = (Array.isArray(raw.rows) ? raw.rows : [])
        .map(row => (Array.isArray(row) ? row : [row]).map(cell => String(cell == null ? '' : cell)));
      if (!rows.length) return null;
      block.rows = rows;
      block.header = raw.header !== false;
      if (raw.cellRuns && typeof raw.cellRuns === 'object') {
        const cellRuns = {};
        for (const key of Object.keys(raw.cellRuns)) {
          const m = /^(\d+),(\d+)$/.exec(key);
          if (!m) continue;
          const cell = rows[Number(m[1])] && rows[Number(m[1])][Number(m[2])];
          if (cell == null) continue;
          const runs = richRunsFor(raw.cellRuns[key], cell, false);
          if (runs) cellRuns[key] = runs;
        }
        if (Object.keys(cellRuns).length) block.cellRuns = cellRuns;
      }
    } else if (type === 'image') {
      const src = String(raw.src || '');
      if (!isSafeImageSrc(src)) return null;
      block.src = src;
      if (raw.alt) block.alt = String(raw.alt).slice(0, 300);
      if (raw.width != null) block.width = clampInt(raw.width, 16, 2000, null);
      if (raw.height != null) block.height = clampInt(raw.height, 16, 2000, null);
    } else if (type === 'pagebreak' || type === 'hr') {
      // sin contenido
    } else {
      // paragraph | quote | code
      // Un parrafo vacio es un bloque valido: es la linea en blanco que deja
      // Word y es lo que crea Enter con el cursor al final del renglon.
      // Si el texto tiene un valor pero solo espacios es residuo de una
      // operacion sobre el contenido, y eso si se tira.
      if (Array.isArray(raw.runs)) {
        const runs = raw.runs.map(normalizeRun).filter(Boolean);
        if (runs.length) block.runs = runs;
        else block.text = blockText(raw);
      } else {
        block.text = blockText(raw);
      }
      if (!block.runs && block.text && !String(block.text).trim()) return null;
      if (type === 'code' && raw.lang) block.lang = String(raw.lang).slice(0, 30);
    }

    if (raw.bold) block.bold = true;
    if (raw.italic) block.italic = true;
    if (raw.underline) block.underline = true;
    if (raw.align && ALIGNS.includes(raw.align)) block.align = raw.align;
    if (raw.color && /^#[0-9a-fA-F]{3,8}$/.test(String(raw.color))) block.color = String(raw.color);
    if (raw.size != null) block.size = clampInt(raw.size, 4, 96, null);
    if (raw.page != null) block.page = clampInt(raw.page, 0, 100000, 0);
    if (raw.indent != null) block.indent = clampInt(raw.indent, 0, 8, 0);
    if (raw.lineHeight != null) {
      const lh = Math.round(Number(raw.lineHeight) * 100) / 100;
      if (isFinite(lh)) block.lineHeight = Math.min(3, Math.max(0.8, lh));
    }

    if (Array.isArray(block.runs) && block.runs.length) block.runs = compactBlockRuns(block);

    return block;
  }

  /**
   * Solo se aceptan imagenes embebidas. El HTML de exportacion se imprime
   * en una ventana sin red: una URL remota no se resolveria y, si se
   * resolviera, seria una peticion que el usuario no pidio.
   */
  function isSafeImageSrc(src) {
    if (!src) return false;
    const s = String(src).trim();
    return /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml|bmp);base64,[A-Za-z0-9+/=\s]+$/i.test(s);
  }

  /** Margenes efectivos en puntos de una pagina. */
  function margins(page) {
    const p = page || PAGE.A4;
    const m = Number.isFinite(Number(p.margin)) ? Number(p.margin) : PAGE.A4.margin;
    const pick = (v) => (v == null || !isFinite(Number(v)) ? m : Number(v));
    return { top: pick(p.marginTop), right: pick(p.marginRight), bottom: pick(p.marginBottom), left: pick(p.marginLeft) };
  }

  // Estilos del documento: formato por defecto de cada tipo de bloque. Un
  // bloque con una propiedad propia gana sobre el estilo. Solo se guardan las
  // propiedades validas; un documento sin estilos no lleva el campo.
  const STYLE_KEYS = ['heading1', 'heading2', 'heading3', 'paragraph', 'quote', 'code'];

  function normalizeStyle(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    if (raw.font && FONT_RE.test(String(raw.font).trim())) out.font = String(raw.font).trim();
    if (raw.size != null) { const n = clampInt(raw.size, 4, 96, null); if (n != null) out.size = n; }
    if (raw.color && HEX_RE.test(String(raw.color))) out.color = String(raw.color);
    if (raw.bold === true || raw.bold === false) out.bold = raw.bold;
    if (raw.italic === true || raw.italic === false) out.italic = raw.italic;
    if (ALIGNS.includes(raw.align)) out.align = raw.align;
    if (raw.lineHeight != null) {
      const lh = Math.round(Number(raw.lineHeight) * 100) / 100;
      if (isFinite(lh)) out.lineHeight = Math.min(3, Math.max(0.8, lh));
    }
    return Object.keys(out).length ? out : null;
  }

  function normalizeStyles(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (const key of STYLE_KEYS) {
      const st = normalizeStyle(raw[key]);
      if (st) out[key] = st;
    }
    return Object.keys(out).length ? out : null;
  }

  /** Clave de estilo de un bloque (heading1..3, paragraph, quote, code) o null. */
  function styleKeyOf(block) {
    if (!block) return null;
    if (block.type === 'heading') return 'heading' + Math.min(3, Math.max(1, Number(block.level) || 1));
    return ['paragraph', 'quote', 'code'].includes(block.type) ? block.type : null;
  }

  function normalizeDoc(raw) {
    const input = raw || {};
    const blocks = (Array.isArray(input.blocks) ? input.blocks : [])
      .map(normalizeBlock)
      .filter(Boolean);

    const page = Object.assign({}, PAGE.A4, input.page && typeof input.page === 'object' ? input.page : {});
    page.width = clampInt(page.width, 100, 5000, PAGE.A4.width);
    page.height = clampInt(page.height, 100, 5000, PAGE.A4.height);
    page.margin = clampInt(page.margin, 0, 300, PAGE.A4.margin);
    // Margenes por lado: solo se guardan los que difieren del margen general.
    for (const side of ['marginTop', 'marginRight', 'marginBottom', 'marginLeft']) {
      if (page[side] == null) { delete page[side]; continue; }
      const v = clampInt(page[side], 0, 300, null);
      if (v == null || v === page.margin) delete page[side]; else page[side] = v;
    }
    // Encabezado y pie: texto simple. pageNumbers coloca "N" en el pie.
    for (const k of ['header', 'footer']) {
      const v = String(page[k] == null ? '' : page[k]).slice(0, 200);
      if (v.trim()) page[k] = v; else delete page[k];
    }
    if (!['left', 'center', 'right'].includes(page.pageNumbers)) delete page.pageNumbers;

    const doc = {
      schema: SCHEMA,
      id: input.id ? String(input.id) : genId('d'),
      title: String(input.title == null ? 'Documento sin titulo' : input.title).slice(0, 300),
      version: clampInt(input.version, 1, 1e9, 1),
      meta: {
        author: String((input.meta && input.meta.author) || '').slice(0, 200),
        subject: String((input.meta && input.meta.subject) || '').slice(0, 400),
        keywords: String((input.meta && input.meta.keywords) || '').slice(0, 400),
        created: String((input.meta && input.meta.created) || new Date().toISOString()),
        modified: String((input.meta && input.meta.modified) || new Date().toISOString()),
        source: String((input.meta && input.meta.source) || '').slice(0, 400),
        sourcePath: String((input.meta && input.meta.sourcePath) || '').slice(0, 1000)
      },
      page,
      blocks,
      warnings: Array.isArray(input.warnings) ? input.warnings.slice(0, 50) : []
    };
    const styles = normalizeStyles(input.styles);
    if (styles) doc.styles = styles;
    doc.hash = hashDoc(doc);
    return doc;
  }

  function createDoc(opts) {
    return normalizeDoc(opts || {});
  }

  // ---------------------------------------------------------------- hash

  function canonical(doc) {
    const parts = [doc.title, doc.meta.author, doc.meta.subject];
    for (const b of doc.blocks) {
      const runs = Array.isArray(b.runs)
        ? b.runs.map(r => `${r.text}${r.bold ? 'B' : ''}${r.italic ? 'I' : ''}`).join('\\u0001')
        : '';
      parts.push([
        b.type,
        b.level == null ? '' : b.level,
        blockText(b),
        runs,
        b.items ? b.items.join('\\u0002') : '',
        b.rows ? b.rows.map(r => r.join('\\u0003')).join('\\u0004') : '',
        b.src ? String(b.src).length : '',
        b.bold ? 'B' : '', b.italic ? 'I' : '', b.align || '',
        // Todo lo demas del bloque (sangria, interlineado, tamano, color,
        // encabezado de tabla, medidas de imagen, enlaces y formato de tramos):
        // un parche viejo debe fallar tambien si solo cambio el formato.
        JSON.stringify(Object.assign({}, b, { id: undefined, text: undefined, items: undefined, rows: undefined, src: undefined }))
      ].join('\\u0005'));
    }
    parts.push(JSON.stringify(doc.page || null), JSON.stringify(doc.styles || null));
    return parts.join('\\u0006');
  }

  function fnv1a(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  /**
   * Hash de contenido, formato `h-<16 hex>-<largo>`. Doble semilla FNV para
   * reducir colisiones sin criptografia: el objetivo es que un parche viejo
   * falle, no proteger un secreto.
   */
  function hashDoc(doc) {
    const str = canonical(doc);
    const a = fnv1a(str, 0x811c9dc5);
    const b = fnv1a(str, 0x1000193);
    return `h-${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}-${str.length}`;
  }

  function clone(doc) {
    return normalizeDoc(JSON.parse(JSON.stringify(doc)));
  }

  /** Copia con los bloques reemplazados, version incrementada y hash nuevo. */
  function withBlocks(doc, blocks, extra) {
    const next = Object.assign({}, doc, { blocks, version: (doc.version || 1) + 1 });
    if (extra) Object.assign(next, extra);
    return normalizeDoc(next);
  }

  // --------------------------------------------------------------- lectura

  function plainText(doc, opts) {
    const o = opts || {};
    const max = o.maxChars > 0 ? o.maxChars : Infinity;
    const lines = [];
    let chars = 0;
    for (const b of (doc && doc.blocks) || []) {
      let line = null;
      if (b.type === 'heading') line = '#'.repeat(b.level || 1) + ' ' + blockText(b);
      else if (b.type === 'paragraph') line = blockText(b);
      else if (b.type === 'quote') line = '> ' + blockText(b);
      else if (b.type === 'code') line = blockText(b);
      else if (b.type === 'list') line = (b.items || []).map((it, i) => (b.ordered ? `${i + 1}. ` : '- ') + it).join('\n');
      else if (b.type === 'table') line = (b.rows || []).map(r => '| ' + r.join(' | ') + ' |').join('\n');
      else if (b.type === 'image') line = '[imagen' + (b.alt ? ': ' + b.alt : '') + ']';
      else if (b.type === 'pagebreak') line = '--- [salto de pagina] ---';
      if (line == null) continue;
      chars += line.length + 1;
      if (chars > max) { lines.push(line.slice(0, Math.max(0, max - chars + line.length))); break; }
      lines.push(line);
      if (b.type === 'list' || b.type === 'table') lines.push('');
    }
    if (o.trim !== false) {
      while (lines.length && !lines[0].trim()) lines.shift();
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    }
    return lines.join('\n');
  }

  function toMarkdown(doc, opts) {
    return plainText(doc, opts);
  }

  function outline(doc) {
    const out = [];
    (doc.blocks || []).forEach((b, i) => {
      if (b.type !== 'heading') return;
      out.push({ id: b.id, index: i, level: b.level || 1, text: blockText(b) });
    });
    return out;
  }

  function stats(doc) {
    const blocks = (doc && doc.blocks) || [];
    const text = plainText(doc);
    const words = text ? (text.match(/[^\s]+/g) || []).length : 0;
    return {
      blocks: blocks.length,
      words,
      chars: text.length,
      headings: blocks.filter(b => b.type === 'heading').length,
      images: blocks.filter(b => b.type === 'image').length,
      tables: blocks.filter(b => b.type === 'table').length,
      pages: blocks.filter(b => b.type === 'pagebreak').length + 1
    };
  }

  function findBlocks(doc, needle, opts) {
    const o = opts || {};
    const q = String(needle || '').toLowerCase();
    if (!q) return [];
    const limit = o.limit || 200;
    const out = [];
    for (let i = 0; i < (doc.blocks || []).length; i++) {
      const b = doc.blocks[i];
      const hay = b.type === 'table'
        ? (b.rows || []).flat().join(' ').toLowerCase()
        : blockText(b).toLowerCase();
      if (!hay.includes(q)) continue;
      const at = blockText(b).toLowerCase().indexOf(q);
      out.push({
        index: i, id: b.id, type: b.type,
        preview: blockText(b).slice(Math.max(0, at - 40), at + q.length + 80)
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Devuelve un doc con el titulo derivado del primer heading. */
  function deriveTitle(doc) {
    const first = (doc.blocks || []).find(b => b.type === 'heading');
    if (first) {
      const t = blockText(first).trim();
      if (t) return t.slice(0, 200);
    }
    const firstText = plainText(doc, { maxChars: 120 }).split('\n')[0];
    return (firstText || 'Documento sin titulo').trim().slice(0, 200);
  }

  return {
    SCHEMA, PAGE, BLOCK_TYPES, ALIGNS, STYLE_KEYS, normalizeStyles, styleKeyOf, margins, isSafeLink,
    createDoc, normalizeDoc, normalizeBlock, clone, withBlocks,
    hashDoc, blockText, withText, hasFormatting, isSafeImageSrc,
    plainText, toMarkdown, outline, stats, findBlocks, deriveTitle, genId, normalizeRun
  };
});
