'use strict';
/**
 * modules/document-editor/renderer.js — vista del editor de documentos.
 *
 * El renderer no es dueño de nada: el main tiene el archivo y el documento
 * (ver main.js). Acá se pintan los bloques, se renderizan las páginas del PDF
 * y se mandan parches. Cada cambio del usuario vuelve como parche (`doc:edit`),
 * igual que los de la IA (`doc:patch`): un solo camino y un solo control de
 * concurrencia (el hash).
 *
 * El editor vive como una PESTAÑA del navegador (mc://doc → panel-doc), no
 * como modal: no tapa la interfaz y se cierra con el mismo botón que las
 * demás pestañas. La UI se inyecta dentro de #doc-host.
 */

(function () {
  'use strict';

  const API = window.mc || {};
  // El nucleo del editor, cargado por script tag en renderer.html. Aporta el
  // render de Word (core/html.js): la vista edita sobre ese HTML, no sobre un
  // dibujo propio, para que pantalla, PDF y DOCX digan lo mismo.
  const html = (window.MCDoc && window.MCDoc.html) || null;
  // Formato en linea: algebra de tramos y lector del DOM (core/runs.js, core/dom-runs.js).
  const runsLib = (window.MCDoc && window.MCDoc.runs) || null;
  const domRuns = (window.MCDoc && window.MCDoc.domRuns) || null;
  const tablesLib = (window.MCDoc && window.MCDoc.tables) || null;
  const RUN_TYPES = ['paragraph', 'heading', 'quote'];
  const PANEL_ID = 'panel-doc';
  const HOST_ID = 'doc-host';
  const BTN_ID = 'doc-editor-btn';
  const TAB_URL = 'mc://doc';

  const ui = {
    snap: null,        // último estado que mandó el main
    selectedBlockId: null,
    view: 'content',   // 'content' | 'pages'
    pdfRenderToken: 0,
    toast: null
  };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const panel = () => document.getElementById(PANEL_ID);
  const host = () => document.getElementById(HOST_ID);
  const el = (id) => { const h = host(); return h ? h.querySelector('#' + id) : null; };

  function cssEscape(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
  }

  // El panel está activo cuando la app puso .active (showPanel) y cuando su
  // pestaña es la activa. Con los dos chequeos no hay que adivinar.
  function isActive() {
    const p = panel();
    if (!p || !p.classList.contains('active')) return false;
    try { return state0().activeTab === docTab()?.id; } catch { return true; }
  }
  function state0() {
    // `state` es un binding global del renderer.html; se accede por nombre para
    // no depender de window.
    return typeof state === 'object' ? state : { tabs: [], activeTab: null };
  }
  function docTab() {
    const s = state0();
    return (s.tabs || []).find((t) => t.url === TAB_URL) || null;
  }

  function toast(msg, kind, action) {
    const t = el('doc-toast');
    if (!t) { console.log('[DocEditor]', msg); return; }
    t.textContent = msg;
    if (action && action.label) {
      const b = document.createElement('button');
      b.className = 'doc-toast-action';
      b.textContent = action.label;
      b.addEventListener('click', () => { t.className = 'doc-toast'; action.run(); });
      t.appendChild(b);
    }
    t.className = 'doc-toast show' + (kind ? ' ' + kind : '') + (action ? ' has-action' : '');
    clearTimeout(ui.toast);
    ui.toast = setTimeout(() => { t.className = 'doc-toast'; }, kind === 'error' ? 6000 : (action ? 8000 : 3000));
  }

  // Dialogo propio en el DOM. window.confirm/alert nativos dejan a Electron
  // (Windows) sin foco de teclado en la pagina al cerrarse: no se podia volver
  // a escribir en el documento. Y window.prompt ni existe en Electron.
  // opts: { title, message, fields:[{name,label,value}], ok, cancel }
  // Devuelve una promesa con { campo: valor } o null si se cancela.
  function modal(opts) {
    const h = host();
    if (!h) return Promise.resolve(null);
    return new Promise((resolve) => {
      const o = opts || {};
      const back = document.createElement('div');
      back.className = 'doc-modal-back';
      const box = document.createElement('div');
      box.className = 'doc-modal';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const title = document.createElement('div');
      title.className = 'doc-modal-title';
      title.textContent = o.title || '';
      box.appendChild(title);
      if (o.message) {
        const m = document.createElement('div');
        m.className = 'doc-modal-msg';
        m.textContent = o.message;
        box.appendChild(m);
      }
      const inputs = {};
      (o.fields || []).forEach((f) => {
        const lab = document.createElement('label');
        lab.textContent = f.label || f.name;
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = f.value || '';
        inputs[f.name] = inp;
        lab.appendChild(inp);
        box.appendChild(lab);
      });
      const row = document.createElement('div');
      row.className = 'doc-modal-row';
      const okB = document.createElement('button');
      okB.className = 'doc-btn primary';
      okB.textContent = o.ok || 'Aceptar';
      row.appendChild(okB);
      let cancelB = null;
      if (o.cancel !== false) {
        cancelB = document.createElement('button');
        cancelB.className = 'doc-btn';
        cancelB.textContent = o.cancel || 'Cancelar';
        row.insertBefore(cancelB, okB);
      }
      box.appendChild(row);
      back.appendChild(box);
      const prev = document.activeElement;
      const close = (val) => {
        back.remove();
        try { if (prev && prev.focus && document.contains(prev)) prev.focus(); } catch (e) { /* sin foco previo */ }
        resolve(val);
      };
      const done = () => {
        const out = {};
        Object.keys(inputs).forEach((k) => { out[k] = inputs[k].value; });
        close(out);
      };
      okB.addEventListener('click', done);
      if (cancelB) cancelB.addEventListener('click', () => close(null));
      back.addEventListener('mousedown', (e) => { if (e.target === back && cancelB) close(null); });
      box.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); close(cancelB ? null : {}); }
        else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); done(); }
      });
      h.appendChild(back);
      const first = Object.keys(inputs)[0];
      (first ? inputs[first] : okB).focus();
      if (first) inputs[first].select();
    });
  }

  // ── Estilos ────────────────────────────────────────────────────────────
  const DOC_CSS = [
'#' + HOST_ID + '{font-family:Calibri,"Segoe UI",Arial,sans-serif;color:var(--text,#e6e8ee);}',
'#' + HOST_ID + ' .doc-bar{display:flex;align-items:center;gap:6px;padding:8px 14px;',
'border-bottom:1px solid var(--border,#2a2f3a);background:var(--surface2,#191c24);flex-wrap:wrap;flex-shrink:0;}',
'#' + HOST_ID + ' .doc-formatbar{display:flex;align-items:center;gap:8px;padding:7px 12px;',
'border-bottom:1px solid var(--border,#2a2f3a);background:var(--surface,#14161c);flex-wrap:wrap;flex-shrink:0;}',
'#' + HOST_ID + ' .doc-format-group{display:flex;align-items:center;gap:3px;padding-right:9px;border-right:1px solid var(--border,#2a2f3a);}',
'#' + HOST_ID + ' .doc-format-group:last-child{border:0;padding-right:0;}',
'#' + HOST_ID + ' .doc-formatbar select{height:27px;padding:3px 6px;background:var(--surface2,#191c24);',
'color:inherit;border:1px solid var(--border,#2a2f3a);border-radius:4px;font:inherit;font-size:.82rem;}',
'#' + HOST_ID + ' .doc-objbar{display:none;align-items:center;gap:6px;padding:5px 12px;border-bottom:1px solid var(--border,#2a2f3a);background:var(--surface,#14161c);flex-wrap:wrap;flex-shrink:0;font-size:.82rem;}',
'#' + HOST_ID + ' .doc-objbar.on{display:flex;}',
'#' + HOST_ID + ' .doc-objbar .doc-obj-label{opacity:.7;margin-right:4px;}',
'#' + HOST_ID + ' .doc-objbar input[type=number],#' + HOST_ID + ' .doc-objbar input[type=text]{height:26px;padding:2px 6px;background:var(--surface2,#191c24);color:inherit;border:1px solid var(--border,#2a2f3a);border-radius:4px;font:inherit;}',
'#' + HOST_ID + ' .doc-objbar input[type=number]{width:70px;}',
'#' + HOST_ID + ' .doc-objbar input[type=text]{width:220px;}',
'#' + HOST_ID + ' .doc-table-picker{position:absolute;z-index:30;display:none;padding:8px;background:var(--surface2,#191c24);border:1px solid var(--border,#2a2f3a);border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.4);}',
'#' + HOST_ID + ' .doc-table-picker.on{display:block;}',
'#' + HOST_ID + ' .doc-table-grid{display:grid;grid-template-columns:repeat(8,18px);gap:2px;}',
'#' + HOST_ID + ' .doc-table-grid i{width:18px;height:18px;border:1px solid var(--border,#2a2f3a);border-radius:2px;display:block;cursor:pointer;}',
'#' + HOST_ID + ' .doc-table-grid i.hot{background:rgba(77,163,255,.45);border-color:var(--accent,#4da3ff);}',
'#' + HOST_ID + ' .doc-table-size{margin-top:6px;text-align:center;font-size:.8rem;opacity:.8;}',
'.doc-b .doc-img-wrap{position:relative;display:inline-block;max-width:100%;margin:8px;line-height:0;}',
'.doc-b .doc-img-wrap img.doc-img{margin:0;display:block;width:100%;height:auto;}',
'.doc-b .doc-img-handle{display:none;position:absolute;right:-5px;bottom:-5px;width:12px;height:12px;background:var(--accent,#4da3ff);border:2px solid #fff;border-radius:3px;cursor:nwse-resize;}',
'.doc-b.sel .doc-img-handle{display:block;}',
'.doc-b.sel .doc-img-wrap{outline:2px solid var(--accent,#4da3ff);}',
'#' + HOST_ID + ' .doc-format-tool{min-width:28px;height:27px;padding:2px 6px;background:transparent;',
'color:inherit;border:1px solid transparent;border-radius:4px;cursor:pointer;font:inherit;}',
'#' + HOST_ID + ' .doc-format-tool:hover:not(:disabled){background:var(--surface3,#22262f);}',
'#' + HOST_ID + ' .doc-format-tool.active{background:rgba(77,163,255,.2);border-color:var(--accent,#4da3ff);}',
'#' + HOST_ID + ' .doc-format-tool:disabled,#' + HOST_ID + ' .doc-formatbar select:disabled{opacity:.4;cursor:default;}',
'#' + HOST_ID + ' .doc-color-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center;width:30px;height:27px;border:1px solid var(--border,#2a2f3a);border-radius:5px;cursor:pointer;overflow:hidden;}',
'#' + HOST_ID + ' .doc-color-wrap:hover{background:var(--surface3,#22262f);}',
'#' + HOST_ID + ' .doc-color-wrap input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;}',
'#' + HOST_ID + ' .doc-color-wrap:has(input:disabled){opacity:.4;cursor:default;}',
'#' + HOST_ID + ' .doc-color-wrap:has(input:disabled) input{cursor:default;}',
'#' + HOST_ID + ' .doc-color-a{font-weight:700;border-bottom:3px solid var(--doc-color-a,#d32f2f);line-height:1;padding:0 2px;}',
'#' + HOST_ID + ' .doc-color-h{font-weight:600;background:var(--doc-color-h,#fff176);color:#222;padding:0 3px;border-radius:2px;line-height:1.2;}',
'#' + HOST_ID + ' .doc-formatbar .doc-format-label{font-size:.72rem;color:var(--muted,#8b93a7);margin-right:3px;}',
'#' + HOST_ID + ' .doc-title{font-size:1.15rem;font-weight:700;overflow:hidden;',
'text-overflow:ellipsis;white-space:nowrap;max-width:46%;}',
'#' + HOST_ID + ' .doc-title .doc-star{color:var(--accent,#4da3ff);margin-left:4px;}',
'#' + HOST_ID + ' .doc-sub{font-size:.82rem;color:var(--muted,#8b93a7);margin-right:auto;}',
'#' + HOST_ID + ' .doc-views{display:flex;gap:2px;}',
'#' + HOST_ID + ' button.doc-btn{background:var(--surface,#14161c);color:inherit;',
'border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:5px 10px;font-size:.85rem;cursor:pointer;white-space:nowrap;}',
'#' + HOST_ID + ' button.doc-btn:hover:not(:disabled){background:var(--surface3,#22262f);color:var(--accent,#4da3ff);}',
'#' + HOST_ID + ' button.doc-btn:disabled{opacity:.4;cursor:default;}',
'#' + HOST_ID + ' button.doc-btn.primary{background:var(--accent,#4da3ff);color:#07101c;border-color:transparent;font-weight:600;}',
'#' + HOST_ID + ' button.doc-btn.on{background:var(--surface3,#22262f);color:var(--accent,#4da3ff);}',
'#' + HOST_ID + ' .doc-warn{padding:7px 14px;font-size:.82rem;background:rgba(255,183,77,.12);',
'border-bottom:1px solid rgba(255,183,77,.3);color:#ffb74d;flex-shrink:0;}',
'#' + HOST_ID + ' .doc-scroll{flex:1;overflow:auto;padding:24px;background:#d9dde5;}',
'#' + HOST_ID + ' .doc-paper-stack{display:flex;flex-direction:column;align-items:center;gap:22px;',
'width:max-content;min-width:100%;padding-bottom:22px;}',
'#' + HOST_ID + ' .doc-paper{box-sizing:border-box;background:#fff;color:#111;flex:0 0 auto;',
'border:1px solid #c8ccd2;box-shadow:0 2px 12px rgba(0,0,0,.25);}',
'#' + HOST_ID + ' .doc-paper-content{box-sizing:border-box;width:100%;overflow:visible;}',
'#' + HOST_ID + ' .doc-pages{display:flex;flex-direction:column;align-items:center;gap:14px;}',
'#' + HOST_ID + ' .doc-page-wrap{position:relative;box-shadow:0 4px 18px rgba(0,0,0,.45);background:#fff;}',
'#' + HOST_ID + ' .doc-page-wrap canvas{display:block;}',
'#' + HOST_ID + ' .doc-page-no{position:absolute;right:6px;bottom:4px;font-size:10px;color:#55606f;',
'background:rgba(255,255,255,.85);padding:1px 5px;border-radius:3px;}',
'#' + HOST_ID + ' .doc-empty{text-align:center;padding:70px 20px;color:var(--muted,#8b93a7);}',
'#' + HOST_ID + ' .doc-empty h3{color:inherit;margin:0 0 8px;font-size:1.15rem;}',
'#' + HOST_ID + ' .doc-empty ul{list-style:none;padding:0;margin:14px 0 0;text-align:left;display:inline-block;}',
'#' + HOST_ID + ' .doc-empty li{padding:8px 10px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:center;}',
'#' + HOST_ID + ' .doc-toast{position:absolute;left:50%;bottom:20px;transform:translateX(-50%) translateY(8px);',
'background:var(--surface3,#22262f);border:1px solid var(--border,#2a2f3a);color:inherit;padding:8px 14px;',
'border-radius:8px;font-size:.85rem;opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;max-width:80%;}',
'#' + HOST_ID + ' .doc-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}',
'#' + HOST_ID + ' .doc-toast.error{border-color:#d9534f;color:#ff8a85;}',
'#' + HOST_ID + ' .doc-toast.has-action{pointer-events:auto;}',
'#' + HOST_ID + ' .doc-toast-action{margin-left:12px;background:transparent;border:0;color:var(--accent,#4da3ff);cursor:pointer;font:inherit;font-weight:600;}',
'#' + HOST_ID + ' .doc-modal-back{position:absolute;inset:0;z-index:50;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;}',
'#' + HOST_ID + ' .doc-modal{min-width:320px;max-width:90%;background:var(--surface2,#191c24);border:1px solid var(--border,#2a2f3a);border-radius:10px;padding:16px 18px;box-shadow:0 10px 30px rgba(0,0,0,.5);}',
'#' + HOST_ID + ' .doc-modal-title{font-weight:600;margin-bottom:8px;}',
'#' + HOST_ID + ' .doc-modal-msg{white-space:pre-line;opacity:.9;margin-bottom:10px;}',
'#' + HOST_ID + ' .doc-modal label{display:block;font-size:.82rem;margin-bottom:8px;opacity:.9;}',
'#' + HOST_ID + ' .doc-modal input{display:block;width:100%;margin-top:3px;height:30px;padding:3px 8px;background:var(--surface,#14161c);color:inherit;border:1px solid var(--border,#2a2f3a);border-radius:5px;font:inherit;}',
'#' + HOST_ID + ' .doc-modal-row{display:flex;justify-content:flex-end;gap:8px;margin-top:10px;}',
'.doc-b{position:relative;margin:0;max-width:none;color:#111;font-size:11pt;line-height:1.15;}',
'.doc-b:hover{background:rgba(0,0,0,.025);}',
'.doc-b.sel{background:rgba(0,120,215,.08);box-shadow:inset 2px 0 0 #0078d4;}',
'.doc-b .doc-t{display:block;width:100%;border:0;background:transparent;color:inherit;font:inherit;',
'box-sizing:border-box;outline:none;resize:none;padding:0;line-height:1.15;text-align:inherit;',
'overflow:hidden;white-space:pre-wrap;word-break:break-word;margin:0 0 6pt;}',
'.doc-b[data-type="heading"]{font-weight:700;}',
'.doc-b[data-type="heading"][data-level="1"]{font-size:17pt;margin:12pt 0 6pt;}',
'.doc-b[data-type="heading"][data-level="2"]{font-size:14pt;margin:10pt 0 5pt;}',
'.doc-b[data-type="heading"][data-level="3"]{font-size:12pt;margin:8pt 0 4pt;}',
'.doc-b[data-type="quote"]{font-style:italic;color:#444;margin:4pt 0;padding-left:18pt;}',
'.doc-b[data-type="code"]{font-family:Consolas,"Cascadia Mono","Courier New",monospace;',
'font-size:9.5pt;margin:3pt 0;padding-left:18pt;}',
'.doc-list-item{display:flex;align-items:flex-start;}',
'.doc-list-item::before{content:attr(data-marker);box-sizing:border-box;flex:0 0 36pt;',
'text-align:center;padding-right:0;line-height:1.15;}',
'.doc-list-item[data-level="1"]{margin-left:18pt;}',
'.doc-list-item[data-level="2"]{margin-left:36pt;}',
'.doc-list-item[data-level="3"]{margin-left:54pt;}',
'.doc-b[data-type="hr"]{border-top:.5pt solid #bfbfbf;margin:4pt 0;height:1px;}',
'.doc-b table{border-collapse:collapse;width:100%;margin:0 0 6pt;font-size:10pt;}',
  '.doc-b th,.doc-b td{border:.5pt solid #999;padding:4pt 6pt;text-align:left;vertical-align:top;}',
  '.doc-b th{background:#eee;font-weight:600;}',
  // La celda ahora lleva un textarea transparente dentro: sin esto el texto
  // se dibujaria dos veces (el escapado + el textarea) y el borde se rompe.
  '.doc-b th>.doc-t,.doc-b td>.doc-t{display:block;width:100%;min-width:24px;}',
  '.doc-b td{padding:0;}.doc-b td>.doc-t{padding:4pt 6pt;}',
  '.doc-b th{padding:0;}.doc-b th>.doc-t{padding:4pt 6pt;background:#eee;font-weight:600;}',
  '.doc-b .doc-t:focus{outline:2px solid #0078d4;outline-offset:-2px;}',
  // ── Superficie de edicion (contenteditable) ──
  // Estas medidas son las de core/html.js, que es lo que imprime y exporta:
  // 17/14/12pt para los titulos, 11pt el cuerpo. Editar y ver tiene que ser
  // lo mismo que imprimir.
  '.doc-b .doc-ce{outline:0;margin:0 0 8pt;font-size:11pt;line-height:1.45;word-wrap:break-word;white-space:pre-wrap;}',
  '.doc-b h1.doc-ce{font-size:17pt;font-weight:700;margin:0 0 10pt;line-height:1.25;}',
  '.doc-b h2.doc-ce{font-size:14pt;font-weight:700;margin:16pt 0 6pt;}',
  '.doc-b h3.doc-ce{font-size:12pt;font-weight:700;margin:14pt 0 5pt;}',
  '.doc-b blockquote.doc-ce{border-left:3px solid #cfcfcf;padding-left:10pt;color:#444;margin:8pt 0;font-style:italic;}',
  '.doc-b pre.doc-ce{font-family:Consolas,"Cascadia Mono","Courier New",monospace;font-size:10pt;' +
  'background:#f6f6f6;padding:6pt 8pt;border-radius:4px;white-space:pre-wrap;overflow-x:auto;}',
  '.doc-b pre.doc-ce>code{font:inherit;}',
  // El foco se marca con un borde suave en el bloque, no con el outline azul
  // del textarea: se lee como un cursor de documento, no como un input web.
  '.doc-b .doc-ce:focus{outline:2px solid rgba(0,120,212,.45);outline-offset:3px;border-radius:2px;}',
  '.doc-b .doc-ce:empty::before{content:attr(data-ph);color:#9a9a9a;}',
  '.doc-b .doc-ce>br:only-child{display:none;}',
  '.doc-b .doc-ce[contenteditable="false]{opacity:.7;}',
'.doc-b img.doc-img{max-width:100%;display:block;margin:8px;border-radius:4px;}',
'#' + BTN_ID + '.open{background:var(--surface2);color:var(--accent,#4da3ff);}'
  ].join('\n');

  function injectStyles() {
    if (document.getElementById('doc-editor-css')) return;
    const s = document.createElement('style');
    s.id = 'doc-editor-css';
    s.textContent = DOC_CSS;
    document.head.appendChild(s);
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    const bar = document.getElementById('topnav');
    if (!bar) return;
    const labButton = Array.from(bar.querySelectorAll('.tnbtn'))
      .find(button => button.getAttribute('onclick') === "showPanel('lab')");
    if (!labButton) return;
    const b = document.createElement('button');
    b.id = BTN_ID;
    b.className = 'tnbtn';
    b.title = 'Documentos (Ctrl+Shift+D)';
    b.innerHTML = '&#128196;';
    b.addEventListener('click', () => api.toggle());
    labButton.insertAdjacentElement('afterend', b);
  }

  // ── UI dentro del panel ────────────────────────────────────────────────
  function buildUI() {
    const h = host();
    if (!h || h.dataset.built) return;
    h.dataset.built = '1';
    h.innerHTML = [
'<div class="doc-bar">',
  '<span class="doc-title" id="doc-title">Documentos</span>',
  '<span class="doc-sub" id="doc-sub"></span>',
  '<div class="doc-views" id="doc-views">',
    '<button class="doc-btn on" data-view="content" title="Contenido editable">Contenido</button>',
    '<button class="doc-btn" data-view="pages" title="Paginas del PDF original">Paginas</button>',
  '</div>',
  '<button class="doc-btn" id="doc-new" title="Documento nuevo">Nuevo</button>',
  '<button class="doc-btn" id="doc-open" title="Abrir PDF, DOCX, TXT o Markdown">Abrir</button>',
  '<button class="doc-btn" id="doc-recent" title="Documentos recientes">Recientes</button>',
  '<button class="doc-btn" id="doc-undo" title="Deshacer (Ctrl+Z)" disabled>↶</button>',
  '<button class="doc-btn" id="doc-redo" title="Rehacer (Ctrl+Y)" disabled>↷</button>',
  '<button class="doc-btn" id="doc-find" title="Buscar y reemplazar">Buscar</button>',
  '<button class="doc-btn" id="doc-stats" title="Recuento de palabras y elementos">Recuento</button>',
  '<button class="doc-btn primary" id="doc-save" title="Guardar (Ctrl+S)">Guardar</button>',
  '<button class="doc-btn" id="doc-saveas" title="Guardar como DOCX, PDF, TXT o Markdown">Guardar como</button>',
'</div>',
  '<div class="doc-formatbar" id="doc-formatbar" aria-label="Formato del bloque seleccionado">',
    '<div class="doc-format-group"><label class="doc-format-label" for="doc-style">Estilo</label>',
      '<select id="doc-style" title="Cambiar estilo del bloque"><option value="paragraph">Normal</option>',
        '<option value="heading-1">Título 1</option><option value="heading-2">Título 2</option>',
        '<option value="heading-3">Título 3</option><option value="quote">Cita</option>',
        '<option value="code">Código</option></select></div>',
    '<div class="doc-format-group"><label class="doc-format-label" for="doc-font">Fuente</label>',
      '<select id="doc-font" title="Fuente del texto seleccionado" disabled><option value="">Predeterminada</option>',
        '<option value="Calibri">Calibri</option><option value="Arial">Arial</option>',
        '<option value="Times New Roman">Times New Roman</option><option value="Georgia">Georgia</option>',
        '<option value="Verdana">Verdana</option><option value="Segoe UI">Segoe UI</option>',
        '<option value="Courier New">Courier New</option><option value="Consolas">Consolas</option></select></div>',
    '<div class="doc-format-group"><label class="doc-format-label" for="doc-size">Tamaño</label>',
      '<select id="doc-size" title="Tamaño del texto seleccionado (o del bloque)"><option value="11">11</option>',
        '<option value="9">9</option><option value="10">10</option><option value="12">12</option>',
        '<option value="14">14</option><option value="16">16</option><option value="18">18</option>',
        '<option value="24">24</option><option value="36">36</option></select>',
      '<button class="doc-format-tool" data-block-toggle="bold" title="Negrita (Ctrl+B)"><b>B</b></button>',
      '<button class="doc-format-tool" data-block-toggle="italic" title="Cursiva (Ctrl+I)"><i>I</i></button>',
      '<button class="doc-format-tool" data-block-toggle="underline" title="Subrayado (Ctrl+U)"><u>U</u></button>',
      '<button class="doc-format-tool" data-inline-only="strike" title="Tachado" disabled><s>S</s></button>',
      '<label class="doc-color-wrap" title="Color del texto"><span class="doc-color-a">A</span><input type="color" id="doc-color" value="#d32f2f" disabled></label>',
      '<label class="doc-color-wrap" title="Resaltado"><span class="doc-color-h">ab</span><input type="color" id="doc-highlight" value="#ffeb3b" disabled></label>',
      '<button class="doc-format-tool" data-inline-only="clear" title="Quitar el formato del texto seleccionado" disabled>Tx</button></div>',
    '<div class="doc-format-group" aria-label="Alineación">',
      '<button class="doc-format-tool" data-block-align="left" title="Alinear a la izquierda">⇤</button>',
      '<button class="doc-format-tool" data-block-align="center" title="Centrar">↔</button>',
      '<button class="doc-format-tool" data-block-align="right" title="Alinear a la derecha">⇥</button>',
      '<button class="doc-format-tool" data-block-align="justify" title="Justificar">☰</button></div>',
    '<div class="doc-format-group" aria-label="Insertar">',
      '<button class="doc-format-tool" id="doc-ins-table" data-always title="Insertar tabla">▦ Tabla</button>',
      '<button class="doc-format-tool" id="doc-ins-image" data-always title="Insertar imagen (también se puede pegar o arrastrar)">🖼 Imagen</button>',
      '<input type="file" id="doc-image-file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/bmp" hidden></div>',
    '<div class="doc-format-group" aria-label="Listas">',
      '<button class="doc-format-tool" data-block-list="bullet" title="Viñetas">•</button>',
      '<button class="doc-format-tool" data-block-list="ordered" title="Numeración">1.</button>',
      '<button class="doc-format-tool" id="doc-insert-pagebreak" title="Insertar salto de página">↵</button>',
      '<button class="doc-format-tool" data-block-move="up" title="Mover bloque arriba">↑</button>',
      '<button class="doc-format-tool" data-block-move="down" title="Mover bloque abajo">↓</button>',
      '<button class="doc-format-tool" data-block-delete title="Eliminar bloque seleccionado">×</button></div>',
  '</div>',
  '<div class="doc-objbar" id="doc-objbar" aria-label="Herramientas del objeto seleccionado"></div>',
'<div class="doc-table-picker" id="doc-table-picker"></div>',
'<div id="doc-warn-host"></div>',
'<div class="doc-scroll" id="doc-scroll"><div id="doc-body"></div></div>',
'<div class="doc-toast" id="doc-toast"></div>'].join('\n');

    h.querySelector('#doc-new').addEventListener('click', onNew);
    h.querySelector('#doc-open').addEventListener('click', onOpen);
    h.querySelector('#doc-recent').addEventListener('click', onRecents);
    h.querySelector('#doc-save').addEventListener('click', onSave);
    h.querySelector('#doc-saveas').addEventListener('click', onSaveAs);
    h.querySelector('#doc-undo').addEventListener('click', () => travelHistory('undo'));
    h.querySelector('#doc-redo').addEventListener('click', () => travelHistory('redo'));
    h.querySelector('#doc-find').addEventListener('click', findAndReplace);
    h.querySelector('#doc-stats').addEventListener('click', showDocumentStats);
    h.querySelector('#doc-formatbar').addEventListener('click', onFormatClick);
    h.querySelector('#doc-style').addEventListener('change', (e) => {
      if (e.target.value === 'paragraph' || e.target.value === 'quote' || e.target.value === 'code') {
        applyBlockType(e.target.value);
      } else {
        const level = Number(e.target.value.split('-')[1]);
        if (level >= 1 && level <= 3) applyBlockType('heading', level);
      }
    });
    h.querySelector('#doc-size').addEventListener('change', (e) => {
      const pt = Number(e.target.value);
      if (pt > 0 && activeCe()) { applyInline('size', pt); return; }
      applySelectedBlock((block) => {
        const next = Object.assign({}, block);
        const size = Number(e.target.value);
        if (size > 0) next.size = size;
        else delete next.size;
        return next;
      });
    });
    h.querySelector('#doc-views').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-view]');
      if (b) setView(b.dataset.view);
    });
    wireEditing();
  }

  function setView(v) {
    ui.view = v === 'pages' ? 'pages' : 'content';
    const h = host();
    if (!h) return;
    h.querySelectorAll('#doc-views button').forEach((b) => {
      b.classList.toggle('on', b.dataset.view === ui.view);
    });
    if (ui.view === 'pages') renderPages();
    else render();
  }

  // ── Pestaña ────────────────────────────────────────────────────────────
function ensureTab() {
    const existing = docTab();
    if (existing) return existing.id;
    if (typeof addTab !== 'function') return null;
    // Se crea con mc://doc y NO con about:blank a proposito: el webview de la
    // app convierte cualquier navegacion a about:blank de vuelta en
    // "mc://newtab" (ver el did-navigate de bindWebviewToTab), y eso borraria
    // la url de la pestaña. Con mc://doc la carga falla en silencio (no es
    // http) y la url se mantiene, tal como funciona la pestaña del Lab.
    addTab(TAB_URL);
    const t = docTab();
    return t ? t.id : null;
  }

  function setTabTitle(text) {
    const t = docTab();
    if (!t) return;
    t.title = text;
    const te = document.querySelector('#tab-' + t.id + ' .tab-title');
    if (te) te.textContent = text;
    const fav = document.querySelector('#tab-' + t.id + ' .tab-favicon');
    if (fav) fav.textContent = '📄';
  }

  function select(id) {
    const h = host();
    if (!h) return;
    ui.selectedBlockId = id || null;
    h.querySelectorAll('.doc-b.sel').forEach((x) => x.classList.remove('sel'));
    if (id) {
      const b = h.querySelector('.doc-b[data-id="' + cssEscape(id) + '"]');
      if (b) b.classList.add('sel');
    }
    refreshFormatBar();
  }

  function selectedBlock() {
    const h = host();
    const id = h && h.querySelector('.doc-b.sel')?.dataset.id;
    return id && ui.snap && ui.snap.doc
      ? (ui.snap.doc.blocks || []).find((block) => block.id === id) || null
      : null;
  }

  function refreshBlockFormatBar() {
    const h = host();
    const bar = h && h.querySelector('#doc-formatbar');
    if (!bar) return;
    const block = selectedBlock();
    const supported = block && ['paragraph', 'heading', 'quote', 'code', 'list'].includes(block.type);
    bar.querySelectorAll('button,select').forEach((control) => {
      const formatOnly = control.id === 'doc-style' || control.id === 'doc-size' ||
        control.hasAttribute('data-block-toggle') || control.hasAttribute('data-block-align') ||
        control.hasAttribute('data-block-list') || control.id === 'doc-insert-pagebreak';
      if (control.hasAttribute('data-always')) { control.disabled = !(ui.snap && ui.snap.open); return; }
      control.disabled = !block || (formatOnly && !supported);
    });
    if (!block) return;
    const blocks = ui.snap.doc.blocks || [];
    const index = blocks.findIndex((item) => item.id === block.id);
    bar.querySelectorAll('[data-block-move]').forEach((button) => {
      button.disabled = button.dataset.blockMove === 'up' ? index <= 0 : index < 0 || index >= blocks.length - 1;
    });
    bar.querySelector('#doc-style').value = block.type === 'heading' ? 'heading-' + (block.level || 1)
      : ['paragraph', 'quote', 'code'].includes(block.type) ? block.type : 'paragraph';
    if (!supported) return;
    bar.querySelector('#doc-size').value = String(block.size || 11);
    bar.querySelectorAll('[data-block-toggle]').forEach((button) => {
      button.classList.toggle('active', !!block[button.dataset.blockToggle]);
    });
    bar.querySelectorAll('[data-block-align]').forEach((button) => {
      button.classList.toggle('active', (block.align || 'left') === button.dataset.blockAlign);
    });
    bar.querySelectorAll('[data-block-list]').forEach((button) => {
      button.classList.toggle('active', block.type === 'list' && block.ordered === (button.dataset.blockList === 'ordered'));
    });
  }

  function refreshFormatBar() {
    refreshBlockFormatBar();
    refreshObjectBar();
    refreshInlineState();
  }

  async function applySelectedBlock(update) {
    const h = host();
    const selected = h && h.querySelector('.doc-b.sel');
    const id = selected && selected.dataset.id;
    if (!id || !ui.snap || !ui.snap.open) return;
    await flushPending();
    const current = (ui.snap.doc.blocks || []).find((block) => block.id === id);
    if (!current) return;
    const next = update(current);
    if (!next) return;
    const res = await API.docEdit({ expectedHash: ui.snap.doc.hash, ops: [{ op: 'replaceBlock', id, block: next }] });
    if (res && res.ok) { applySnapshot(res); select(id); scheduleAutoSave(); }
    else if (res && res.error) toast(res.error, 'error');
  }

  function applyBlockType(type, level) {
    applySelectedBlock((block) => {
      const next = Object.assign({}, block);
      if (type === 'list') {
        next.items = block.type === 'list' ? block.items.slice() : blockText(block).split(/\r?\n/).filter((item) => item.trim());
        if (!next.items.length) return null;
        next.ordered = false;
        if (block.type !== 'list') { delete next.text; delete next.runs; }
      } else if (block.type === 'list') {
        next.text = blockText(block);
        delete next.items; delete next.ordered;
      }
      next.type = type;
      if (type === 'heading') next.level = level || 1;
      else if (type !== 'list') delete next.level;
      return next;
    });
  }

  function onFormatClick(event) {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.inlineOnly) {
      applyInline(button.dataset.inlineOnly);
    } else if (button.dataset.blockToggle && ['bold', 'italic', 'underline'].includes(button.dataset.blockToggle) && activeCe()) {
      applyInline(button.dataset.blockToggle);
    } else if (button.dataset.blockToggle) {
      const key = button.dataset.blockToggle;
      applySelectedBlock((block) => {
        const next = Object.assign({}, block);
        if (next[key]) delete next[key];
        else next[key] = true;
        return next;
      });
    } else if (button.dataset.blockAlign) {
      applySelectedBlock((block) => Object.assign({}, block, { align: button.dataset.blockAlign }));
    } else if (button.dataset.blockList) {
      const block = selectedBlock();
      if (!block) return;
      const ordered = button.dataset.blockList === 'ordered';
      if (block.type === 'list' && block.ordered === ordered) applyBlockType('paragraph');
      else applySelectedBlock((current) => {
        const next = Object.assign({}, current);
        next.items = current.type === 'list' ? current.items.slice() : blockText(current).split(/\r?\n/).filter((item) => item.trim());
        if (!next.items.length) return null;
        next.type = 'list'; next.ordered = ordered;
        delete next.text; delete next.runs;
        return next;
      });
    } else if (button.id === 'doc-insert-pagebreak') {
      insertSelectedPageBreak();
    } else if (button.dataset.blockMove) {
      moveSelectedBlock(button.dataset.blockMove);
    } else if (button.hasAttribute('data-block-delete')) {
      deleteSelectedBlock();
    }
  }

  // ── Tablas e imagenes (hito 2) ─────────────────────────────────────────
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp'];
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const PICKER_COLS = 8;
  const PICKER_ROWS = 6;

  function contentWidthPx() {
    const page = (ui.snap && ui.snap.doc && ui.snap.doc.page) || {};
    const w = Number(page.width) || 595;
    const m = Number(page.margin);
    return Math.round((w - 2 * (Number.isFinite(m) ? m : 57)) * 96 / 72);
  }

  function refreshObjectBar() {
    const bar = el('doc-objbar');
    if (!bar || !tablesLib) return;
    const block = selectedBlock();
    const kind = block && (block.type === 'table' || block.type === 'image') ? block.type : '';
    if (bar.dataset.kind !== kind || bar.dataset.bid !== (block ? block.id : '')) {
      bar.dataset.kind = kind;
      bar.dataset.bid = block ? block.id : '';
      if (kind === 'table') {
        bar.innerHTML = '<span class="doc-obj-label">Tabla</span>' +
          '<button class="doc-format-tool" data-tbl="addRowBefore" title="Insertar fila arriba">+ Fila ↑</button>' +
          '<button class="doc-format-tool" data-tbl="addRowAfter" title="Insertar fila abajo">+ Fila ↓</button>' +
          '<button class="doc-format-tool" data-tbl="deleteRow" title="Eliminar la fila actual">− Fila</button>' +
          '<button class="doc-format-tool" data-tbl="addColBefore" title="Insertar columna a la izquierda">+ Col ←</button>' +
          '<button class="doc-format-tool" data-tbl="addColAfter" title="Insertar columna a la derecha">+ Col →</button>' +
          '<button class="doc-format-tool" data-tbl="deleteCol" title="Eliminar la columna actual">− Col</button>' +
          '<button class="doc-format-tool" data-tbl="header" title="Primera fila como encabezado">Encabezado</button>';
      } else if (kind === 'image') {
        bar.innerHTML = '<span class="doc-obj-label">Imagen</span>' +
          '<label>Ancho <input type="number" id="doc-img-w" min="16" max="2000"> px</label>' +
          '<button class="doc-format-tool" data-img-pct="25">25%</button>' +
          '<button class="doc-format-tool" data-img-pct="50">50%</button>' +
          '<button class="doc-format-tool" data-img-pct="75">75%</button>' +
          '<button class="doc-format-tool" data-img-pct="100">100%</button>' +
          '<label>Texto alternativo <input type="text" id="doc-img-alt" maxlength="300" placeholder="describe la imagen"></label>';
      } else bar.innerHTML = '';
    }
    bar.classList.toggle('on', !!kind);
    if (kind === 'table') {
      const hb = bar.querySelector('[data-tbl="header"]');
      if (hb) hb.classList.toggle('active', block.header !== false);
    } else if (kind === 'image') {
      const w = bar.querySelector('#doc-img-w');
      const a = bar.querySelector('#doc-img-alt');
      if (w && document.activeElement !== w) w.value = block.width || '';
      if (a && document.activeElement !== a) a.value = block.alt || '';
    }
  }

  function cellOf(block, c) {
    const last = block ? Math.max(0, (block.rows || []).length - 1) : 0;
    if (!c || !block || c.id !== block.id) return { row: last, col: Math.max(0, tablesLib.cols(block || { rows: [] }) - 1) };
    return { row: Math.min(c.row, last), col: Math.min(c.col, Math.max(0, tablesLib.cols(block) - 1)) };
  }

  function tableAction(name) {
    if (!tablesLib) return;
    // La celda se toma ANTES de confirmar lo pendiente: al repintar el foco
    // puede moverse y la fila nueva iria a otro lado.
    const at = ui.cell ? Object.assign({}, ui.cell) : null;
    applySelectedBlock((block) => {
      if (block.type !== 'table') return null;
      const c = cellOf(block, at);
      let next = null;
      if (name === 'addRowBefore') next = tablesLib.addRow(block, c.row, 'before');
      else if (name === 'addRowAfter') next = tablesLib.addRow(block, c.row, 'after');
      else if (name === 'deleteRow') next = tablesLib.deleteRow(block, c.row);
      else if (name === 'addColBefore') next = tablesLib.addCol(block, c.col, 'before');
      else if (name === 'addColAfter') next = tablesLib.addCol(block, c.col, 'after');
      else if (name === 'deleteCol') next = tablesLib.deleteCol(block, c.col);
      else if (name === 'header') next = tablesLib.setHeader(block, block.header === false);
      if (!next) { toast('Esa operación no es posible en esta tabla', 'error'); return null; }
      return next;
    });
  }

  // Inserta un bloque despues del seleccionado (o al final) y lo selecciona.
  async function insertBlockHere(block) {
    if (!ui.snap || !ui.snap.open) return null;
    await flushPending();
    const blocks = ui.snap.doc.blocks || [];
    const sel = selectedBlock();
    const at = sel ? blocks.findIndex((b) => b.id === sel.id) + 1 : blocks.length;
    const res = await API.docEdit({ expectedHash: ui.snap.doc.hash, ops: [{ op: 'insert', index: at, block }] });
    if (res && res.ok) {
      applySnapshot(res);
      const created = ((res.doc && res.doc.blocks) || [])[at];
      if (created) select(created.id);
      scheduleAutoSave();
      return created || null;
    }
    if (res && res.error) toast(res.error, 'error');
    return null;
  }

  async function insertTable(rows, cols) {
    if (!tablesLib) return;
    const created = await insertBlockHere(tablesLib.create(rows, cols, true));
    if (created) setTimeout(() => {
      const t = host() && host().querySelector('.doc-b[data-id="' + cssEscape(created.id) + '"] textarea.doc-t');
      if (t) t.focus();
    }, 30);
  }

  function hidePicker() {
    const p = el('doc-table-picker');
    if (p) p.classList.remove('on');
  }

  function showPicker() {
    const p = el('doc-table-picker');
    const btn = el('doc-ins-table');
    if (!p || !btn) return;
    if (p.classList.contains('on')) { hidePicker(); return; }
    let cells = '';
    for (let i = 0; i < PICKER_COLS * PICKER_ROWS; i++) {
      cells += '<i data-r="' + (Math.floor(i / PICKER_COLS) + 1) + '" data-c="' + ((i % PICKER_COLS) + 1) + '"></i>';
    }
    p.innerHTML = '<div class="doc-table-grid">' + cells + '</div><div class="doc-table-size">Elegí el tamaño</div>';
    const hostEl = host();
    const hr = hostEl.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    p.style.left = Math.max(0, br.left - hr.left) + 'px';
    p.style.top = Math.max(0, br.bottom - hr.top + 4) + 'px';
    p.classList.add('on');
  }

  function wirePicker() {
    const p = el('doc-table-picker');
    if (!p || p.dataset.wired) return;
    p.dataset.wired = '1';
    const paint = (r, c) => {
      p.querySelectorAll('.doc-table-grid i').forEach((i) => {
        i.classList.toggle('hot', Number(i.dataset.r) <= r && Number(i.dataset.c) <= c);
      });
      const label = p.querySelector('.doc-table-size');
      if (label) label.textContent = r && c ? c + ' × ' + r : 'Elegí el tamaño';
    };
    p.addEventListener('mouseover', (e) => {
      const i = e.target.closest && e.target.closest('i[data-r]');
      if (i) paint(Number(i.dataset.r), Number(i.dataset.c));
    });
    p.addEventListener('click', (e) => {
      const i = e.target.closest && e.target.closest('i[data-r]');
      if (!i) return;
      hidePicker();
      insertTable(Number(i.dataset.r), Number(i.dataset.c));
    });
    document.addEventListener('mousedown', (e) => {
      if (!p.classList.contains('on')) return;
      if (e.target.closest && (e.target.closest('#doc-table-picker') || e.target.closest('#doc-ins-table'))) return;
      hidePicker();
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error || new Error('no se pudo leer la imagen'));
      fr.readAsDataURL(file);
    });
  }

  // Tamano natural de la imagen. Si el navegador no la decodifica a tiempo se
  // usa un tamano razonable: mejor insertarla que dejar al usuario esperando.
  function naturalSize(src) {
    return new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      const img = new Image();
      img.onload = () => fin({ width: img.naturalWidth || 400, height: img.naturalHeight || 300 });
      img.onerror = () => fin({ width: 400, height: 300 });
      setTimeout(() => fin({ width: 400, height: 300 }), 2500);
      img.src = src;
    });
  }

  async function insertImageFile(file) {
    if (!file || !tablesLib) return;
    if (!IMAGE_TYPES.includes(file.type)) { toast('Formato de imagen no admitido (PNG, JPG, GIF, WebP, SVG o BMP)', 'error'); return; }
    if (file.size > MAX_IMAGE_BYTES) { toast('La imagen pesa más de 8 MB', 'error'); return; }
    let src;
    try { src = await readFileAsDataUrl(file); } catch (e) { toast('No se pudo leer la imagen', 'error'); return; }
    const nat = await naturalSize(src);
    const size = tablesLib.fitWidth(nat, contentWidthPx());
    await insertBlockHere({ type: 'image', src, alt: '', width: size.width, height: size.height });
  }

  function imageFilesOf(dt) {
    return dt && dt.files ? Array.from(dt.files).filter((f) => IMAGE_TYPES.includes(f.type)) : [];
  }

  async function setImageWidth(px) {
    if (!tablesLib) return;
    applySelectedBlock((block) => {
      if (block.type !== 'image') return null;
      const nat = block.width && block.height ? { width: block.width, height: block.height } : null;
      return tablesLib.resizeImage(block, { width: px }, nat);
    });
  }

  function wireObjects() {
    const h = host();
    const b0 = el('doc-body');
    if (!h || !b0 || b0.dataset.objWired || !tablesLib) return;
    b0.dataset.objWired = '1';
    wirePicker();

    el('doc-ins-table').addEventListener('click', showPicker);
    const fileInput = el('doc-image-file');
    el('doc-ins-image').addEventListener('click', () => { hidePicker(); fileInput.click(); });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (f) await insertImageFile(f);
    });

    // Celda actual: las filas y columnas se agregan/quitan relativas a ella.
    b0.addEventListener('focusin', (e) => {
      const ta = e.target.closest && e.target.closest('textarea[data-tr]');
      if (!ta) return;
      const bEl = ta.closest('.doc-b');
      if (bEl) ui.cell = { id: bEl.dataset.id, row: Number(ta.dataset.tr), col: Number(ta.dataset.tc) };
    });

    const bar = el('doc-objbar');
    bar.addEventListener('click', (e) => {
      const t = e.target.closest && e.target.closest('button');
      if (!t) return;
      if (t.dataset.tbl) tableAction(t.dataset.tbl);
      else if (t.dataset.imgPct) setImageWidth(Math.round(contentWidthPx() * Number(t.dataset.imgPct) / 100));
    });
    bar.addEventListener('change', (e) => {
      if (e.target.id === 'doc-img-w') {
        const v = Number(e.target.value);
        if (v >= 16) setImageWidth(v);
      } else if (e.target.id === 'doc-img-alt') {
        const alt = e.target.value;
        applySelectedBlock((block) => (block.type === 'image' ? tablesLib.setAlt(block, alt) : null));
      }
    });

    // Pegar una imagen del portapapeles: va como bloque, no como texto.
    b0.addEventListener('paste', (e) => {
      const files = imageFilesOf(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      insertImageFile(files[0]);
    }, true);
    b0.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
    });
    b0.addEventListener('drop', (e) => {
      const files = imageFilesOf(e.dataTransfer);
      if (!files.length) return;
      e.preventDefault();
      const bEl = e.target.closest && e.target.closest('.doc-b');
      if (bEl) select(bEl.dataset.id);
      insertImageFile(files[0]);
    });

    // Redimensionar arrastrando la esquina: proporcion siempre conservada.
    b0.addEventListener('mousedown', (e) => {
      const handle = e.target.closest && e.target.closest('[data-img-handle]');
      if (!handle) return;
      e.preventDefault();
      const bEl = handle.closest('.doc-b');
      const wrap = handle.closest('.doc-img-wrap');
      const img = wrap && wrap.querySelector('img');
      if (!bEl || !img) return;
      const startX = e.clientX;
      const startW = wrap.getBoundingClientRect().width || img.width || 100;
      const maxW = contentWidthPx();
      let width = startW;
      const move = (ev) => {
        width = Math.max(16, Math.min(maxW, startW + (ev.clientX - startX)));
        wrap.style.width = Math.round(width) + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        select(bEl.dataset.id);
        setImageWidth(Math.round(width));
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  async function insertSelectedPageBreak() {
    const block = selectedBlock();
    if (!block || !ui.snap) return;
    await flushPending();
    const index = ui.snap.doc.blocks.findIndex((item) => item.id === block.id);
    if (index < 0) return;
    const res = await API.docEdit({ expectedHash: ui.snap.doc.hash, ops: [
      { op: 'insert', index: index + 1, block: { type: 'pagebreak' } }
    ] });
    if (res && res.ok) { applySnapshot(res); select(block.id); }
    else if (res && res.error) toast(res.error, 'error');
  }

  async function moveSelectedBlock(direction) {
    const selected = selectedBlock();
    if (!selected || !ui.snap) return;
    await flushPending();
    const blocks = ui.snap.doc.blocks || [];
    const index = blocks.findIndex((block) => block.id === selected.id);
    const insertAt = direction === 'up' ? index - 1 : index + 2;
    if (index < 0 || insertAt < 0 || index >= blocks.length || (direction === 'down' && index >= blocks.length - 1)) return;
    const moved = Object.assign({}, blocks[index]);
    delete moved.id;
    const res = await API.docEdit({ expectedHash: ui.snap.doc.hash, ops: [
      { op: 'insert', index: insertAt, block: moved },
      { op: 'deleteBlock', id: selected.id }
    ] });
    if (res && res.ok) {
      const newIndex = direction === 'up' ? index - 1 : index + 1;
      const movedId = res.doc.blocks[newIndex]?.id;
      applySnapshot(res);
      if (movedId) select(movedId);
    } else if (res && res.error) toast(res.error, 'error');
  }

  async function deleteSelectedBlock() {
    const block = selectedBlock();
    if (!block || !ui.snap) return;
    await flushPending();
    const blocks = ui.snap.doc.blocks || [];
    const at = blocks.findIndex((x) => x.id === block.id);
    const res = await API.docEdit({ expectedHash: ui.snap.doc.hash, ops: [{ op: 'deleteBlock', id: block.id }] });
    if (!(res && res.ok)) { if (res && res.error) toast(res.error, 'error'); return; }
    // Sin confirmacion nativa: se borra y se ofrece Deshacer (como Word).
    ui.selectedBlockId = null;
    applySnapshot(res);
    scheduleAutoSave();
    const left = (res.doc && res.doc.blocks) || [];
    const next = left[Math.min(at, left.length - 1)];
    if (next) { select(next.id); setTimeout(() => focusBlock(next.id), 0); }
    toast('Bloque eliminado', null, { label: 'Deshacer', run: () => travelHistory('undo') });
  }

  async function travelHistory(direction) {
    await flushPending();
    const res = direction === 'undo' ? await API.docUndo() : await API.docRedo();
    if (res && res.ok) applySnapshot(res);
    else if (res && res.error) toast(res.error);
  }

  async function findAndReplace() {
    await flushPending();
    const r = await modal({
      title: 'Buscar y reemplazar',
      fields: [{ name: 'find', label: 'Buscar' }, { name: 'replace', label: 'Reemplazar por' }],
      ok: 'Reemplazar todo'
    });
    if (!r || !r.find) return;
    const res = await API.docEdit({ expectedHash: ui.snap?.doc?.hash, ops: [
      { op: 'replace', find: r.find, replace: r.replace || '', all: true, caseSensitive: false }
    ] });
    if (res && res.ok) {
      applySnapshot(res);
      toast('Reemplazo aplicado en ' + res.applied + ' bloque(s)', null, { label: 'Deshacer', run: () => travelHistory('undo') });
    } else if (res && res.error) toast(res.error, 'error');
  }

  async function showDocumentStats() {
    await flushPending();
    const res = await API.docRead({ maxChars: 200000 });
    if (res && res.error) { toast(res.error, 'error'); return; }
    const stats = res && res.stats;
    if (!stats) return;
    await modal({
      title: 'Recuento',
      message: 'Palabras: ' + stats.words + '\nCaracteres: ' + stats.chars +
        '\nBloques: ' + stats.blocks + '\nTítulos: ' + stats.headings +
        '\nTablas: ' + stats.tables + '\nImágenes: ' + stats.images + '\nPáginas: ' + stats.pages,
      cancel: false
    });
  }

  // ── Contenido ──────────────────────────────────────────────────────────
  function blockText(b) {
    if (typeof b.text === 'string') return b.text;
    if (Array.isArray(b.runs)) return b.runs.map((r) => (r && r.text) || '').join('');
    if (Array.isArray(b.items)) return b.items.join('\n');
    return '';
  }

  function blockMarkup(b) {
    if (b.type === 'list') {
      const items = Array.isArray(b.items) ? b.items.slice() : [];
      if (!items.length) items.push('');
      const level = Math.min(3, Math.max(0, Number(b.level) || 0));
      return items.map((it, i) => '<div class="doc-list-item" data-level="' + level + '" data-marker="' +
        esc(b.ordered ? (i + 1) + '.' : '•') + '"><textarea class="doc-t" rows="1" data-li="' + i +
        '" placeholder="elemento">' + esc(it) + '</textarea></div>').join('');
    }
    if (b.type === 'table') {
      const rows = Array.isArray(b.rows) ? b.rows : [];
      let out = '<table>';
      rows.forEach((row, ri) => {
        const tag = (b.header !== false && ri === 0) ? 'th' : 'td';
        out += '<tr>';
        // Cada celda es un textarea propio: una tabla importada de Word era
        // texto fijo y no se podia editar ni una letra.
        (Array.isArray(row) ? row : []).forEach((cell, ci) => {
          out += '<' + tag + '><textarea class="doc-t" rows="1" data-tr="' + ri + '" data-tc="' + ci +
            '">' + esc(cell) + '</textarea></' + tag + '>';
        });
        out += '</tr>';
      });
      return out + '</table>';
    }
    if (b.type === 'image') {
      const w = Number(b.width) > 0 ? ' style="width:' + Number(b.width) + 'px"' : '';
      return '<span class="doc-img-wrap"' + w + '><img class="doc-img" src="' + esc(b.src || '') + '" alt="' +
        esc(b.alt || '') + '" draggable="false"><span class="doc-img-handle" data-img-handle></span></span>';
    }
    if (b.type === 'pagebreak' || b.type === 'hr') return '';
    // Parrafo, titulo, cita y codigo: superficie unica de texto.
    // Se pinta con el MISMO HTML que usa la impresion y el export (core/html.js),
    // para que lo que se ve editando sea lo que sale en el PDF y en el DOCX.
    // El texto llega ya escapado y con su formato inline (strong/em/u/color).
    const tag = b.type === 'heading' ? ('h' + Math.min(3, Math.max(1, Number(b.level) || 1)))
      : b.type === 'quote' ? 'blockquote'
      : b.type === 'code' ? 'pre'
      : 'p';
    const inner = b.type === 'code'
      ? '<code>' + esc(blockText(b)) + '</code>'
      : (Array.isArray(b.runs) && b.runs.length ? html.runsToHtml(b) : esc(blockText(b)));
    return '<' + tag + ' class="doc-ce" contenteditable="true" spellcheck="false" ' +
      'data-ce="1" role="textbox" aria-multiline="true">' + inner + '</' + tag + '>';
  }

  function blockStyle(b) {
    const styles = [];
    if (b.align && ['left', 'center', 'right', 'justify'].includes(b.align)) styles.push('text-align:' + b.align);
    if (Number.isFinite(Number(b.size)) && Number(b.size) >= 4) styles.push('font-size:' + Number(b.size) + 'pt');
    if (b.color && /^#[0-9a-fA-F]{3,8}$/.test(b.color)) styles.push('color:' + b.color);
    if (b.bold) styles.push('font-weight:700');
    if (b.italic) styles.push('font-style:italic');
    if (b.underline) styles.push('text-decoration:underline');
    return styles.length ? ' style="' + esc(styles.join(';')) + '"' : '';
  }

  function createPaperPage(stack, page, pageNumber) {
    const scale = 96 / 72;
    const width = Math.max(100, Number(page.width) || 595) * scale;
    const height = Math.max(100, Number(page.height) || 842) * scale;
    const margin = Math.max(0, Number(page.margin) || 0) * scale;
    const paper = document.createElement('section');
    paper.className = 'doc-paper';
    paper.dataset.page = pageNumber;
    paper.style.width = width + 'px';
    paper.style.height = height + 'px';
    paper.style.padding = margin + 'px';
    const content = document.createElement('div');
    content.className = 'doc-paper-content';
    content.style.height = Math.max(1, height - margin * 2 - 2) + 'px';
    paper.appendChild(content);
    stack.appendChild(paper);
    return content;
  }

  function layoutPaperPages(stack, blocks, nodes, page) {
    stack.replaceChildren();
    let content = createPaperPage(stack, page, 1);
    for (const block of blocks) {
      if (block.type === 'pagebreak') {
        if (content.childElementCount) content = createPaperPage(stack, page, stack.children.length + 1);
        continue;
      }
      const node = nodes.get(block.id);
      if (!node) continue;
      content.appendChild(node);
      node.querySelectorAll('.doc-t').forEach(autosize);
      if (content.childElementCount > 1 && content.scrollHeight > content.clientHeight + 1) {
        content.removeChild(node);
        content = createPaperPage(stack, page, stack.children.length + 1);
        content.appendChild(node);
      }
    }
  }

  function textOffset(root, container, offset) {
    try {
      const r = document.createRange();
      r.setStart(root, 0);
      r.setEnd(container, offset);
      return r.toString().replace(/\u00a0/g, ' ').length;
    } catch (e) { return null; }
  }

  function placeAt(root, pos) {
    let left = Math.max(0, pos);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = null;
    let last = null;
    while ((node = walker.nextNode())) {
      const len = (node.nodeValue || '').length;
      if (left <= len) return { node: node, offset: left };
      left -= len;
      last = node;
    }
    if (last) return { node: last, offset: (last.nodeValue || '').length };
    return { node: root, offset: 0 };
  }

  function captureCaret() {
    const h = host();
    const sel = window.getSelection && window.getSelection();
    if (!h || !sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    const first = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    const surface = first && first.closest && first.closest('.doc-ce, .doc-t');
    if (!surface || !h.contains(surface)) return null;
    const bEl = surface.closest('.doc-b');
    if (!bEl) return null;
    if (surface.classList.contains('doc-t')) {
      return { id: bEl.dataset.id, ta: true, start: surface.selectionStart || 0, end: surface.selectionEnd || 0 };
    }
    const start = textOffset(surface, r.startContainer, r.startOffset);
    let end = start;
    if (!r.collapsed) {
      const otro = textOffset(surface, r.endContainer, r.endOffset);
      if (otro != null) end = otro;
    }
    return { id: bEl.dataset.id, start: start == null ? 0 : start, end: end };
  }

  function restoreCaret(st) {
    if (!st) return false;
    const h = host();
    if (!h) return false;
    const wrap = h.querySelector('.doc-b[data-id="' + cssEscape(st.id) + '"]');
    if (!wrap) return false;
    if (st.ta) {
      const ta = wrap.querySelector('.doc-t');
      if (!ta) return false;
      ta.focus({ preventScroll: true });
      try { ta.setSelectionRange(st.start, st.end); } catch (e) { /* sin seleccion util */ }
      return true;
    }
    const ce = wrap.querySelector('.doc-ce');
    if (!ce) return false;
    const a = placeAt(ce, st.start);
    const b = st.end === st.start ? a : placeAt(ce, st.end);
    const sel = window.getSelection && window.getSelection();
    if (!sel) return false;
    try {
      const r = document.createRange();
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      sel.removeAllRanges();
      sel.addRange(r);
      ce.focus({ preventScroll: true });
    } catch (e) {
      ce.focus();
    }
    return true;
  }

  function render() {
    const b0 = el('doc-body');
    if (!b0) return;
    const snap = ui.snap;
    if (!snap || !snap.open) {
      b0.innerHTML = '<div class="doc-empty"><h3>Ningun documento abierto</h3>' +
        '<p>Abri un PDF, DOCX, TXT o Markdown para editarlo.</p>' +
        '<p style="margin-top:14px"><button class="doc-btn primary" id="doc-open2">Abrir documento</button></p></div>';
      const b2 = b0.querySelector('#doc-open2');
      if (b2) b2.addEventListener('click', onOpen);
      return;
    }
    const caret = captureCaret();
    const scrollY = b0.scrollTop;
    const blocks = (snap.doc && snap.doc.blocks) || [];
    b0.innerHTML = blocks.map((b) =>
      '<div class="doc-b" data-type="' + esc(b.type) + '" data-level="' + (b.level || '') +
        '" data-id="' + esc(b.id) + '"' + blockStyle(b) + '>' + blockMarkup(b) + '</div>'
    ).join('');
    const nodes = new Map(Array.from(b0.querySelectorAll(':scope > .doc-b')).map(node => [node.dataset.id, node]));
    const stack = document.createElement('div');
    stack.className = 'doc-paper-stack';
    b0.replaceChildren(stack);
    layoutPaperPages(stack, blocks, nodes, snap.doc.page || { width: 595, height: 842, margin: 57 });
    if (ui.selectedBlockId) select(ui.selectedBlockId);
    else refreshFormatBar();
    restoreCaret(caret);
    b0.scrollTop = scrollY;
  }

  // Para distinguir pestañas manda el nombre del archivo; el titulo que trae el
  // documento dentro (primer encabezado) va como dato secundario.
  function labelOf(snap) {
    if (!snap || !snap.open) return 'Documentos';
    return snap.sourceName || (snap.doc && snap.doc.title) || 'Documento';
  }

  function renderChrome() {
    const h = host();
    if (!h) return;
    const snap = ui.snap;
    const t = el('doc-title');
    const s = el('doc-sub');
    const btnSave = el('doc-save');
    const btnUndo = el('doc-undo');
    const btnRedo = el('doc-redo');
    if (!snap || !snap.open) {
      t.textContent = 'Documentos';
      s.textContent = '';
      btnSave.disabled = true;
      btnUndo.disabled = true;
      btnRedo.disabled = true;
      setTabTitle('📄 Documentos');
      return;
    }
    const nombre = labelOf(snap);
    paintSaveState();
    const bits = [];
    bits.push(snap.capabilities && snap.capabilities.isPdfSource ? 'PDF' : String(snap.format || '').toUpperCase());
    if (snap.pageCount) bits.push(snap.pageCount + ' pag');
    bits.push(((snap.doc && snap.doc.blocks) || []).length + ' bloques');
    const tituloDoc = snap.doc && snap.doc.title;
    if (tituloDoc && tituloDoc !== nombre) bits.push(tituloDoc);
    s.textContent = bits.join(' · ');
    btnSave.disabled = !snap.dirty || !snap.sourcePath;
    btnUndo.disabled = !snap.history?.canUndo;
    btnRedo.disabled = !snap.history?.canRedo;
    setTabTitle('📄 ' + nombre + (snap.dirty ? ' *' : ''));
  }

  function renderWarnings() {
    const wh = el('doc-warn-host');
    if (!wh) return;
    const w = (ui.snap && ui.snap.warnings) || [];
    wh.innerHTML = w.length
      ? '<div class="doc-warn">' + esc(w.slice(0, 3).join(' · ')) +
        (w.length > 3 ? ' (+' + (w.length - 3) + ' avisos)' : '') + '</div>'
      : '';
  }

  function repaint() {
    if (!host()) return;
    renderChrome();
    renderWarnings();
    if (ui.view === 'pages') renderPages();
    else render();
  }

  function autosize(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, 18) + 'px';
  }

  // ── Paginas del PDF ────────────────────────────────────────────────────
  async function renderPages() {
    const scroll = el('doc-scroll');
    if (!scroll) return;
    const b0 = el('doc-body');
    const token = ++ui.pdfRenderToken;
    b0.innerHTML = '<div class="doc-empty"><p>Cargando paginas...</p></div>';
    const res = await API.docBytes();
    if (token !== ui.pdfRenderToken) return;
    if (!res || !res.ok || !res.bytes) {
      b0.innerHTML = '<div class="doc-empty"><h3>Sin paginas que mostrar</h3>' +
        '<p>La vista de paginas solo existe para los PDF originales. Para TXT, Markdown o DOCX usa la pestana Contenido.</p></div>';
      return;
    }
    try {
      const lib = await loadPdfjs();
      if (token !== ui.pdfRenderToken) return;
      const task = lib.getDocument({ data: new Uint8Array(res.bytes), disableWorker: true, isEvalSupported: false });
      const pdf = await task.promise;
      if (token !== ui.pdfRenderToken) return;
      b0.innerHTML = '<div class="doc-pages"></div>';
      const pages = b0.querySelector('.doc-pages');
      const total = pdf.numPages;
      const MAX = 60;
      for (let i = 1; i <= Math.min(total, MAX); i++) {
        const page = await pdf.getPage(i);
        if (token !== ui.pdfRenderToken) return;
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min((scroll.clientWidth - 60) / base.width, 1.5) || 1;
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        const wrap = document.createElement('div');
        wrap.className = 'doc-page-wrap';
        wrap.appendChild(canvas);
        const no = document.createElement('span');
        no.className = 'doc-page-no';
        no.textContent = i + ' / ' + total;
        wrap.appendChild(no);
        pages.appendChild(wrap);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      }
      if (total > MAX) {
        const note = document.createElement('div');
        note.className = 'doc-empty';
        note.innerHTML = '<p>Solo se pintan las primeras ' + MAX + ' paginas de ' + total +
          '.<br>El texto completo esta en la pestana Contenido.</p>';
        pages.appendChild(note);
      }
    } catch (e) {
      if (token !== ui.pdfRenderToken) return;
      b0.innerHTML = '<div class="doc-empty"><h3>No pude pintar las paginas</h3><p>' + esc(e.message) + '</p></div>';
    }
  }

  // pdf.js en el renderer: los bundles estan vendorizados y se sirven por
  // file://, asi que se puede usar el worker fake sin CSP que lo bloquee.
  const VENDOR = '../modules/document-editor/vendor/';
  let pdfjsPromise = null;
  function loadPdfjs() {
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = injectScript(VENDOR + 'pdf.worker.min.js')
      .then(() => injectScript(VENDOR + 'pdf.min.js'))
      .then(() => {
        const lib = window.pdfjsLib;
        if (!lib) throw new Error('pdf.js no se cargo');
        if (lib.GlobalWorkerOptions) lib.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.js';
        return lib;
      })
      .catch((e) => { pdfjsPromise = null; throw e; });
    return pdfjsPromise;
  }

  function injectScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve(true);
      s.onerror = () => reject(new Error('No se pudo cargar ' + src));
      document.head.appendChild(s);
    });
  }

  // ── Acciones ───────────────────────────────────────────────────────────
  // Todas las acciones de abrir/create usan el snapshot que devuelve el main y,
  // ademas, el evento doc:changed. Aplicar el retorno evita que, si el evento
  // llegara tarde o perdiera el renderer, la pestana quedara mostrando el
  // documento anterior.
  async function onOpen() {
    const res = await API.docOpen();
    if (!res) return;
    if (res.error) toast(res.error, 'error');
    else { applySnapshot(res); setView('content'); }
  }

  async function onNew() {
    const res = await API.docCreate({ title: 'Documento nuevo' });
    if (res && res.error) toast(res.error, 'error');
    else { applySnapshot(res); setView('content'); }
  }

  async function onRecents() {
    const res = await API.docRecents();
    const items = (res && res.recents) || [];
    const b0 = el('doc-body');
    if (!b0) return;
    if (ui.view === 'pages') setView('content');
    b0.innerHTML = '<div class="doc-empty" style="text-align:left;padding:26px">' +
      '<h3>Documentos recientes</h3>' +
      (items.length
        ? '<ul>' + items.map((r) =>
            '<li><button class="doc-btn" data-recent="' + esc(r.path) + '">Abrir</button>' +
            '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.name || r.path) + '</span>' +
            '<span style="color:var(--muted);font-size:.78rem">' + esc(String(r.format || '').toUpperCase()) + '</span></li>').join('') + '</ul>'
        : '<p style="margin-top:10px">Todavia no abriste ningun documento.</p>') +
      '</div>';
    b0.querySelectorAll('[data-recent]').forEach((b) => b.addEventListener('click', async () => {
      const r = await API.docRecentOpen({ path: b.dataset.recent });
      if (r && r.error) toast(r.error, 'error');
      else { applySnapshot(r); setView('content'); }
    }));
  }

  async function onSave() {
    await flushPending();
    const res = await API.docSave();
    if (!res) return;
    if (res.needsSaveAs) {
      toast(res.error || 'Elige "Guardar como"');
      return onSaveAs();
    }
    if (res.error) toast(res.error, 'error');
    else { applySnapshot(res); toast('Guardado ' + res.sourceName); }
  }

  async function onSaveAs() {
    await flushPending();
    cancelAutoSave();
    const res = await API.docSaveAs({});
    if (res && res.error) toast(res.error, 'error');
    else if (res && res.canceled) return;
    else if (res) { applySnapshot(res); toast('Guardado ' + res.sourceName); }
  }

  // El estado de guardado se pinta desde dos sitios: el snapshot que llega del
  // main y el autoguardado que dispara el renderer. Tener un solo pintor evita
  // que uno de los dos pise al otro.
  function paintSaveState() {
    const snap = ui.snap;
    const t = el('doc-title');
    const btnSave = el('doc-save');
    if (!snap || !snap.open) return;
    const nombre = labelOf(snap);
    t.innerHTML = esc(nombre) + (snap.dirty ? '<span class="doc-star">*</span>' : '');
    btnSave.disabled = !snap.dirty || !snap.sourcePath;
  }

  // ── Autoguardado ────────────────────────────────────────────────────────
  // Antes solo se guardaba al abrir, al crear y al deshacer, y al cerrar la
  // pestaña el trabajo se perdia. Ahora cada cambio confirmed dispara una copia
  // de trabajo con rebote: escribir seguido no golpea el disco, y si la app se
  // cae quedan los ultimos cambios en userData/doc-editor/work/.
  let autoSaveTimer = null;
  let autoSaveAt = 0;

  function cancelAutoSave() {
    if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
  }

  function scheduleAutoSave() {
    if (!ui.snap || !ui.snap.open || !ui.snap.dirty) return;
    cancelAutoSave();
    autoSaveAt = Date.now();
    autoSaveTimer = setTimeout(async () => {
      autoSaveTimer = null;
      try {
        await flushPending();
        const res = await API.docWorkSave();
        if (res && res.ok) {
          const s = ui.snap;
          if (s) s.workSavedAt = Date.now();
          paintSaveState();
        }
      } catch {}
    }, 900);
  }

  // ── Edición ────────────────────────────────────────────────────────────
  let pending = null;   // { id, text } esperando confirmación

  // Suma de caracteres de los tramos con formato. Si coincide con el largo del
  // texto nuevo, los indices siguen sirviendo y el formato se conserva.
  function runsTotalLength(runs) {
    return runs.reduce((n, r) => n + String((r && r.text) || '').length, 0);
  }

  // Re-proyecta los tramos sobre el texto editado: el caracter i del texto
  // nuevo toma el formato del tramo que lo cubria en el original.
  function projectRuns(runs, text) {
    const marks = new Array(text.length);
    let at = 0;
    for (const run of runs) {
      const t = String((run && run.text) || '');
      for (let i = 0; i < t.length; i++) marks[at + i] = run;
      at += t.length;
    }
    const out = [];
    for (let i = 0; i < text.length; i++) {
      const src = marks[i];
      const last = out[out.length - 1];
      const text0 = text[i];
      if (last && last.src === src) {
        last.text += text0;
      } else {
        const chunk = { src, text: text0 };
        out.push(chunk);
      }
    }
    const merged = [];
    for (const c of out) {
      const last = merged[merged.length - 1];
      // Se comparan las PROPIEDADES de los tramos, no los objetos: comparar
      // `last` contra `c.src` comparaba un {text,props} contra un run y nunca
      // coincidia, dejando la negrita corrida una palabra mas adelante.
      if (last && sameRunProps(last.props, c.src)) last.text += c.text;
      else merged.push({ text: c.text, props: c.src });
    }
    return merged
      .filter((m) => m.text.length)
      .map((m) => Object.assign({}, runPropsOf(m.props), { text: m.text }));
  }

  function runPropsOf(run) {
    if (!run) return {};
    const out = {};
    if (run.bold) out.bold = true;
    if (run.italic) out.italic = true;
    if (run.underline) out.underline = true;
    if (run.color) out.color = run.color;
    if (run.size != null) out.size = run.size;
    return out;
  }

  function sameRunProps(a, b) {
    const pa = runPropsOf(a);
    const pb = runPropsOf(b);
    return JSON.stringify(pa) === JSON.stringify(pb);
  }

// Un textarea puede ser de item de lista o de celda de tabla; un contenteditable
  // es el parrafo, el titulo, la cita y el codigo. Todos llegan a `commit` con
  // su propia coordenada.
  function pendingFor(bEl, ta) {
    const isCe = ta.hasAttribute && ta.hasAttribute('data-ce');
    // Del contenteditable sale texto plano, no HTML: si se mandara el innerHTML
    // el modelo terminaria guardando etiquetas.
    const runs = isCe && domRuns && runsLib ? domRuns.read(ta) : null;
    const text = runs ? runsLib.toPlain(runs) : isCe ? ceText(ta) : ta.value;
    return {
      id: bEl.dataset.id,
      text: text,
      runs: runs,
      itemIndex: ta.dataset.li == null ? null : Number(ta.dataset.li),
      cellRow: ta.dataset.tr == null ? null : Number(ta.dataset.tr),
      cellCol: ta.dataset.tc == null ? null : Number(ta.dataset.tc)
    };
  }

  // Parte el texto del contenteditable en el cursor y devuelve las dos mitades
  // o null si el cursor estaba al final (no hay nada que repartir).
  // No toca el DOM: si primero se cortara el nodo y despues fallara el commit,
  // el texto quedaria afuera del modelo y desapareceria en el siguiente repintado.
  function splitCeAtCaret(node) {
    const sel = window.getSelection && window.getSelection();
    if (!sel || !sel.rangeCount || !node.contains(sel.anchorNode) && sel.anchorNode !== node) {
      return null;
    }
    const range = sel.getRangeAt(0);
    if (!node.contains(range.endContainer) || !node.contains(range.startContainer)) return null;
    const tail = document.createRange();
    tail.setStart(range.endContainer, range.endOffset);
    tail.setEnd(node, node.childNodes.length);
    if (domRuns && runsLib) {
      // Cada mitad conserva su formato. Lo seleccionado se descarta (Enter
      // reemplaza la seleccion, como en Word): la izquierda llega hasta el
      // INICIO de la seleccion y la derecha empieza en su FIN.
      const head = document.createRange();
      head.setStart(node, 0);
      head.setEnd(range.startContainer, range.startOffset);
      const restRuns = domRuns.read(tail.cloneContents());
      const rest = runsLib.toPlain(restRuns);
      if (!rest.length) return null;
      const leftRuns = domRuns.read(head.cloneContents());
      return { left: runsLib.toPlain(leftRuns), rest, leftRuns, restRuns };
    }
    const rest = ceText(tail.cloneContents());
    if (!rest.length) return null;
    const full = ceText(node);
    return { left: full.slice(0, Math.max(0, full.length - rest.length)), rest: rest };
  }

  // Texto de un contenteditable: los <br> son saltos de linea reales, y el
  // &nbsp; que Chrome inserta al final no debe quedarse pegado en el texto.
  function ceText(node) {
    if (!node) return '';
    let out = '';
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.nodeType === 1) {
        const tag = (n.tagName || '').toLowerCase();
        if (tag === 'br') out += '\n';
        else out += ceText(n);
      }
    });
    return out.replace(/\u00a0/g, ' ');
  }

  function flushPending() {
    if (!pending) return Promise.resolve();
    const p = pending;
    pending = null;
    return commit(p.id, p.text, p.itemIndex, p.cellRow, p.cellCol, p.runs);
  }

  async function commit(id, text, itemIndex, cellRow, cellCol, runs) {
    const snap = ui.snap;
    if (!snap || !snap.open) return;
    // Cualquier confirmacion arranca el reloj del autoguardado.
    const block = ((snap.doc && snap.doc.blocks) || []).find((b) => b.id === id);
    if (!block) return;
    if (cellRow != null && block.type === 'table') {
      const rows = (block.rows || []).map((r) => (Array.isArray(r) ? r.slice() : []));
      if (!rows[cellRow] || rows[cellRow][cellCol] === text) return;
      rows[cellRow][cellCol] = text;
      scheduleAutoSave();
      const res = await API.docEdit({
        expectedHash: snap.doc.hash,
        ops: [{ op: 'replaceBlock', id, block: Object.assign({}, block, { rows }) }]
      });
      if (res && res.ok) applySnapshot(res);
      else if (res && res.error) toast(res.error, 'error');
      return;
    }
    if (itemIndex != null && block.type === 'list') {
      if (block.items[itemIndex] === text) return;
      const items = block.items.slice();
      items[itemIndex] = text;
      scheduleAutoSave();
      const res = await API.docEdit({
        expectedHash: snap.doc.hash,
        ops: [{ op: 'replaceBlock', id, block: Object.assign({}, block, { items }) }]
      });
      if (res && res.ok) applySnapshot(res);
      else if (res && res.error) toast(res.error, 'error');
      return;
    }
    if (Array.isArray(runs) && runsLib && RUN_TYPES.includes(block.type)) {
      // El DOM es la verdad mientras se escribe: los tramos salen de lo que se
      // ve (negritas, colores, fuentes...) y ya no se reproyectan por posicion,
      // que perdia TODO el formato del parrafo al cambiar su longitud.
      const clean = runsLib.compact(runs, runsLib.defaultsOf(block));
      if (runsLib.equal(clean, runsLib.ofBlock(block))) return;
      scheduleAutoSave();
      const withRuns = Object.assign({}, block);
      if (runsLib.hasFormatting(clean)) { withRuns.runs = clean; delete withRuns.text; }
      else { withRuns.text = runsLib.toPlain(clean); delete withRuns.runs; }
      const done = await API.docEdit({
        expectedHash: snap.doc.hash,
        ops: [{ op: 'replaceBlock', id, block: withRuns }]
      });
      if (done && done.ok) applySnapshot(done);
      else if (done && done.error) toast(done.error, 'error');
      return;
    }
    if (blockText(block) === text) return;
    scheduleAutoSave();
    const next = Object.assign({}, block, { text });
    // Superficies sin tramos (codigo, o sin el nucleo cargado): si el bloque
    // traia formato mixto solo se conserva cuando el largo no cambio.
    if (Array.isArray(block.runs) && block.runs.length) {
      if (runsTotalLength(block.runs) === text.length) {
        next.runs = projectRuns(block.runs, text);
      } else {
        delete next.runs;
      }
    }
    const res = await API.docEdit({
      expectedHash: snap.doc.hash,
      ops: [{ op: 'replaceBlock', id, block: next }]
    });
    if (res && res.ok) applySnapshot(res);
    else if (res && res.error) toast(res.error, 'error');
  }

  // Solo acepta snapshots de verdad: `{canceled:true}` de un dialogo o
  // `{error}` no pueden pisar lo que hay en pantalla.
  function applySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    if (snap.error || snap.canceled) return;
    if (!('open' in snap)) return;
    ui.snap = snap;
    repaint();
  }

  // Inserta un bloque nuevo despues de `id`. Si `con` trae texto (el caso de
  // partir un parrafo con Enter), se usa ese texto en vez de uno vacio.
  async function insertAfter(id, con) {
    const snap = ui.snap;
    if (!snap || !snap.open) return;
    const blocks = (snap.doc && snap.doc.blocks) || [];
    const i = blocks.findIndex((b) => b.id === id);
    const nuevo = con && con.runs && runsLib && runsLib.hasFormatting(con.runs)
      ? { type: 'paragraph', runs: con.runs }
      : con && con.text ? { type: 'paragraph', text: con.text } : { type: 'paragraph', text: '' };
    const res = await API.docEdit({
      expectedHash: snap.doc.hash,
      ops: [{ op: 'insert', index: i + 1, block: nuevo }]
    });
    if (res && res.ok) {
      applySnapshot(res);
      const nuevo = ((res.doc.blocks || [])[i + 1] || {}).id;
      setTimeout(() => focusBlock(nuevo), 30);
    } else if (res && res.error) toast(res.error, 'error');
  }

  async function mergeIntoPrevious(blocks, i) {
    const prev = blocks[i - 1];
    const cur = blocks[i];
    if (!prev || !cur) return;
    const hash = ui.snap.doc.hash;
    const texto = blockText(cur);
    const items = (cur.items || []).filter((x) => x !== '');
    let ops;
    if (prev.type === 'list') {
      const nuevo = (prev.items || []).concat(texto.split('\n')).filter((x) => x !== '');
      if (!nuevo.length) return;
      ops = [
        { op: 'replaceBlock', id: prev.id, block: Object.assign({}, prev, { items: nuevo }) },
        { op: 'deleteBlock', id: cur.id }
      ];
    } else if (items.length) {
      ops = [
        { op: 'replaceBlock', id: prev.id, block: Object.assign({}, prev, { text: blockText(prev) + '\n' + items.join('\n') }) },
        { op: 'deleteBlock', id: cur.id }
      ];
    } else if (texto === '') {
      return;   // un bloque vacío no se fusiona: se deja para borrar
    } else {
      ops = [
        { op: 'replaceBlock', id: prev.id, block: Object.assign({}, prev, { text: blockText(prev) + '\n' + texto }) },
        { op: 'deleteBlock', id: cur.id }
      ];
    }
    const res = await API.docEdit({ expectedHash: hash, ops });
    if (res && res.ok) {
      applySnapshot(res);
      setTimeout(() => focusBlock(prev.id), 30);
    } else if (res && res.error) toast(res.error, 'error');
  }

  function focusBlock(id) {
const h = host();
      if (!h) return;
      const wrap = h.querySelector('.doc-b[data-id="' + cssEscape(id) + '"]');
      if (!wrap) return;
      const ce = wrap.querySelector('.doc-ce');
      if (ce) {
        // La superficie de texto crece sola con white-space:pre-wrap: no hay
        // que medir nada, solo llevar el cursor al final.
        ce.focus();
        placeCaretAtEnd(ce);
        return;
      }
      const t = wrap.querySelector('.doc-t');
      if (t) {
        t.focus();
        t.selectionStart = t.selectionEnd = t.value.length;
      }
    }

    function placeCaretAtEnd(node) {
      const sel = window.getSelection && window.getSelection();
      if (!sel) return;
      try {
        const r = document.createRange();
        r.selectNodeContents(node);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      } catch {}
    }

  // ── Formato en línea (sobre la selección) ────────────────────────────
  // El DOM es la verdad mientras se escribe: el formato se aplica con
  // execCommand (negrita, color, fuente...) sobre la selección real, y al
  // confirmar el bloque core/dom-runs.js lo traduce a tramos del modelo.

  function ceOf(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const ce = el && el.closest && el.closest('.doc-ce');
    const h = host();
    return ce && h && h.contains(ce) ? ce : null;
  }

  function liveCe() {
    const sel = window.getSelection && window.getSelection();
    return sel && sel.rangeCount ? ceOf(sel.getRangeAt(0).startContainer) : null;
  }

  // La superficie de texto con la selección actual. Si el foco pasó a un
  // control de la barra (fuente, tamaño, color) vale la selección guardada,
  // siempre que siga siendo la del bloque seleccionado.
  function activeCe() {
    const live = liveCe();
    if (live) return live;
    const saved = ui.savedCe;
    const h = host();
    const selected = h && h.querySelector('.doc-b.sel');
    return saved && saved.isConnected && ui.savedRange && selected && selected.contains(saved) ? saved : null;
  }

  function restoreSavedSelection() {
    const ce = ui.savedCe;
    const range = ui.savedRange;
    if (!ce || !range || !ce.isConnected) return false;
    ce.focus({ preventScroll: true });
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  // execCommand('fontSize') solo conoce la escala 1-7: se pide el 7 y se
  // cambia por el tamaño real en puntos.
  function convertSizeMarkers(ce, pt) {
    let changed = false;
    ce.querySelectorAll('font[size="7"]').forEach((f) => {
      const span = document.createElement('span');
      span.style.fontSize = pt + 'pt';
      while (f.firstChild) span.appendChild(f.firstChild);
      f.replaceWith(span);
      changed = true;
    });
    ce.querySelectorAll('span').forEach((sp) => {
      if (sp.style.fontSize === 'xxx-large') { sp.style.fontSize = pt + 'pt'; changed = true; }
    });
    return changed;
  }

  function applySizeInline(ce, pt) {
    if (!(pt > 0)) return;
    try { document.execCommand('fontSize', false, '7'); } catch (e) { return; }
    // Con el cursor sin selección todavía no hay nodo: se convierte al escribir.
    ui.pendingSizePt = convertSizeMarkers(ce, pt) ? null : pt;
  }

  function fixPendingSize(ce) {
    if (ui.pendingSizePt && convertSizeMarkers(ce, ui.pendingSizePt)) ui.pendingSizePt = null;
  }

  async function applyInline(action, value) {
    const ce = activeCe();
    if (!ce) return;
    if (liveCe() !== ce && !restoreSavedSelection()) return;
    ce.focus({ preventScroll: true });
    const exec = (cmd, arg) => { try { return document.execCommand(cmd, false, arg); } catch (e) { return false; } };
    exec('styleWithCSS', true);
    switch (action) {
      case 'bold': exec('bold'); break;
      case 'italic': exec('italic'); break;
      case 'underline': exec('underline'); break;
      case 'strike': exec('strikeThrough'); break;
      case 'color': exec('foreColor', value); break;
      case 'highlight': exec('hiliteColor', value); break;
      case 'font': exec('fontName', value || 'inherit'); break;
      case 'size': applySizeInline(ce, Number(value)); break;
      case 'clear': exec('removeFormat'); break;
      default: return;
    }
    // Lo escrito hasta ahora sale del DOM tal cual está y se confirma ya: así
    // el formato entra al historial (deshacer/rehacer) y al autoguardado.
    const bEl = ce.closest('.doc-b');
    if (bEl) pending = pendingFor(bEl, ce);
    await flushPending();
    refreshInlineState();
  }

  function refreshInlineState() {
    const h = host();
    const bar = h && h.querySelector('#doc-formatbar');
    if (!bar) return;
    const ce = activeCe();
    bar.querySelectorAll('[data-inline-only], #doc-font, #doc-color, #doc-highlight').forEach((c) => {
      c.disabled = !ce;
    });
    // Con el foco en un control de la barra no se lee nada: seria el estado
    // de otra seleccion.
    if (!ce || liveCe() !== ce) return;
    const state = (cmd) => { try { return document.queryCommandState(cmd); } catch (e) { return false; } };
    const value = (cmd) => { try { return String(document.queryCommandValue(cmd) || ''); } catch (e) { return ''; } };
    const mark = (sel, on) => { const b = bar.querySelector(sel); if (b) b.classList.toggle('active', !!on); };
    mark('[data-block-toggle="bold"]', state('bold'));
    mark('[data-block-toggle="italic"]', state('italic'));
    mark('[data-block-toggle="underline"]', state('underline'));
    mark('[data-inline-only="strike"]', state('strikeThrough'));

    const fontSel = bar.querySelector('#doc-font');
    const family = value('fontName').split(',')[0].replace(/^["']|["']$/g, '').trim();
    fontSel.value = Array.from(fontSel.options).some((o) => o.value === family) ? family : '';

    const sel = window.getSelection();
    const node = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const px = el ? parseFloat(window.getComputedStyle(el).fontSize) : NaN;
    const pt = Math.round(px * 0.75 * 2) / 2;
    const sizeSel = bar.querySelector('#doc-size');
    if (isFinite(pt) && Array.from(sizeSel.options).some((o) => Number(o.value) === pt)) sizeSel.value = String(pt);

    const paint = (id, cssVar, color) => {
      const input = bar.querySelector(id);
      if (input && color) { input.value = color; input.parentElement.style.setProperty(cssVar, color); }
    };
    paint('#doc-color', '--doc-color-a', domRuns && domRuns.parseColor(value('foreColor')));
    paint('#doc-highlight', '--doc-color-h', domRuns && domRuns.parseColor(value('hiliteColor') || value('backColor')));
  }

  let inlineSelectionWired = false;
  function wireInlineFormatting() {
    const h = host();
    const bar = h && h.querySelector('#doc-formatbar');
    if (!bar || bar.dataset.inlineWired) return;
    bar.dataset.inlineWired = '1';
    // Los botones no deben quitarle el foco ni la selección al texto.
    bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    bar.querySelector('#doc-font').addEventListener('change', (e) => applyInline('font', e.target.value));
    bar.querySelector('#doc-color').addEventListener('change', (e) => applyInline('color', e.target.value));
    bar.querySelector('#doc-highlight').addEventListener('change', (e) => applyInline('highlight', e.target.value));
    if (inlineSelectionWired) return;
    inlineSelectionWired = true;
    let frame = 0;
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      const ce = sel && sel.rangeCount ? ceOf(sel.getRangeAt(0).startContainer) : null;
      if (!ce) return;
      ui.savedCe = ce;
      ui.savedRange = sel.getRangeAt(0).cloneRange();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refreshInlineState);
    });
  }

  // Backspace con el cursor al inicio de un párrafo: se une al anterior
  // conservando el formato de los dos.
  async function mergeRunsIntoPrevious(id) {
    await flushPending();
    const blocks = (ui.snap && ui.snap.doc && ui.snap.doc.blocks) || [];
    const i = blocks.findIndex((b) => b.id === id);
    const prev = blocks[i - 1];
    const cur = blocks[i];
    if (i < 1 || !prev || !cur || !RUN_TYPES.includes(prev.type) || !RUN_TYPES.includes(cur.type)) return;
    const prevRuns = runsLib.ofBlock(prev);
    const at = runsLib.length(prevRuns);
    let ops;
    let focusId;
    if (at === 0) {
      // El anterior está vacío: se descarta y el actual conserva su tipo.
      ops = [{ op: 'deleteBlock', id: prev.id }];
      focusId = cur.id;
    } else {
      const joined = runsLib.concat(prevRuns, runsLib.ofBlock(cur));
      const next = Object.assign({}, prev);
      if (runsLib.hasFormatting(joined)) { next.runs = joined; delete next.text; }
      else { next.text = runsLib.toPlain(joined); delete next.runs; }
      ops = [{ op: 'replaceBlock', id: prev.id, block: next }, { op: 'deleteBlock', id: cur.id }];
      focusId = prev.id;
    }
    const res = await API.docEdit({ expectedHash: ui.snap.doc.hash, ops });
    if (res && res.ok) {
      applySnapshot(res);
      const pos = focusId === prev.id ? at : 0;
      setTimeout(() => restoreCaret({ id: focusId, start: pos, end: pos }), 30);
    } else if (res && res.error) toast(res.error, 'error');
  }

  // ── Fila flotante de bloque ────────────────────────────────────────────
  // ── Cableado de edición ────────────────────────────────────────────────
  function wireEditing() {
    const b0 = el('doc-body');
    if (!b0 || b0.dataset.wired) return;
    b0.dataset.wired = '1';

    b0.addEventListener('focusin', (e) => {
      const ta = e.target.closest && e.target.closest('.doc-t, .doc-ce');
      if (!ta) return;
      if (ta.classList.contains('doc-t')) autosize(ta);
      const bEl = ta.closest('.doc-b');
      if (bEl) {
        select(bEl.dataset.id);
        pending = pendingFor(bEl, ta);
      }
    });
    b0.addEventListener('input', (e) => {
      const ta = e.target.closest && e.target.closest('.doc-t, .doc-ce');
      if (!ta) return;
      if (ta.classList.contains('doc-t')) autosize(ta);
      else fixPendingSize(ta);
      const bEl = ta.closest('.doc-b');
      if (bEl) pending = pendingFor(bEl, ta);
    });
    b0.addEventListener('focusout', () => {
      // Un tick de retardo deja que el click en la fila flotante cuente como
      // edición y no como "perdí el foco sin guardar nada".
      setTimeout(() => flushPending(), 0);
    });
    // Pegar en la superficie de texto trae HTML de la web con scripts, estilos
    // y clases que el modelo no representa. Se pega solo el texto plano, que
    // es lo que el usuario ve en el portapapeles de todos modos.
    b0.addEventListener('paste', (e) => {
      const ce = e.target.closest && e.target.closest('.doc-ce');
      if (!ce) return;
      e.preventDefault();
      const dt = e.clipboardData || window.clipboardData;
      const txt = dt ? String(dt.getData('text/plain') || '') : '';
      if (!txt) return;
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.rangeCount && ce.contains(sel.getRangeAt(0).startContainer)) {
        sel.deleteFromDocument();
        const r = sel.getRangeAt(0);
        const lines = txt.split(/\r?\n/);
        const frag = document.createDocumentFragment();
        lines.forEach((line, i) => {
          if (i) frag.appendChild(document.createElement('br'));
          if (line) frag.appendChild(document.createTextNode(line));
        });
        const last = frag.lastChild;
        r.insertNode(frag);
        if (last) {
          const after = document.createRange();
          after.setStartAfter(last);
          after.collapse(true);
          sel.removeAllRanges();
          sel.addRange(after);
        }
      } else {
        ce.textContent = ce.textContent + txt;
      }
      ce.dispatchEvent(new Event('input', { bubbles: true }));
    });
    b0.addEventListener('mousedown', (e) => {
      const bEl = e.target.closest('.doc-b');
      select(bEl ? bEl.dataset.id : null);
    });
    wireInlineFormatting();
    wireObjects();
  }

  // ── Teclado ────────────────────────────────────────────────────────────
  async function onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      api.toggle();
      return;
    }
    if (!isActive()) return;

    const enCampo = !!(e.target && e.target.closest && e.target.closest('textarea, input, .doc-ce'));
    if (e.key === 'Escape' && !enCampo) { e.preventDefault(); api.close(); return; }
    if (e.ctrlKey || e.metaKey) {
      const k = String(e.key || '').toLowerCase();
      if (k === 'z') { e.preventDefault(); await travelHistory(e.shiftKey ? 'redo' : 'undo'); return; }
      if (k === 'y') { e.preventDefault(); await travelHistory('redo'); return; }
      if (k === 'f') { e.preventDefault(); findAndReplace(); return; }
      if (k === 's') { e.preventDefault(); onSave(); return; }
      if (k === 'o') { e.preventDefault(); onOpen(); return; }
    }

    const ta = e.target && e.target.closest && e.target.closest('.doc-t');
    const ce = e.target && e.target.closest && e.target.closest('.doc-ce');
    const bEl = (ta || ce) && (ta || ce).closest('.doc-b');
    if (ce) {
      // En la superficie de texto, Enter divide el bloque en el punto del
      // cursor. Shift+Enter es el salto de linea dentro del parrafo.
      if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && bEl && runsLib) {
        const caret = captureCaret();
        if (caret && !caret.ta && caret.start === 0 && caret.end === 0) {
          const list = (ui.snap && ui.snap.doc && ui.snap.doc.blocks) || [];
          const at = list.findIndex((x) => x.id === bEl.dataset.id);
          if (at > 0 && RUN_TYPES.includes(list[at].type) && RUN_TYPES.includes(list[at - 1].type)) {
            e.preventDefault();
            await mergeRunsIntoPrevious(bEl.dataset.id);
            return;
          }
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const id = bEl && bEl.dataset.id;
        if (id == null) return;
        const partes = splitCeAtCaret(ce);
        if (partes) {
          // El texto que queda arriba manda: lo que decia `pending` podia
          // incluir la cola que ahora se mueve al bloque nuevo.
          if (pending && pending.id === id) pending = null;
          await commit(id, partes.left, null, null, null, partes.leftRuns);
          await insertAfter(id, { text: partes.rest, runs: partes.restRuns });
        } else {
          await flushPending();
          await insertAfter(id);
        }
        return;
      }
      return;
    }
    if (!ta || ta.dataset.li) return;
    if (!bEl) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      // Enter confirma y crea el bloque siguiente.
      e.preventDefault();
      await flushPending();
      await insertAfter(bEl.dataset.id);
      return;
    }
    if (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      const blocks = (ui.snap && ui.snap.doc && ui.snap.doc.blocks) || [];
      const i = blocks.findIndex((x) => x.id === bEl.dataset.id);
      if (i > 0) {
        e.preventDefault();
        await flushPending();
        await mergeIntoPrevious(blocks, i);
      }
    }
  }

  // ── API pública ────────────────────────────────────────────────────────
  const api = {
    async open() {
      injectStyles(); injectButton(); buildUI();
      const id = ensureTab();
      if (id != null && typeof switchTab === 'function' && state0().activeTab !== id) switchTab(id);
      // showPanel deja el panel visible; si la pestaña quedó activa, switchTab
      // ya lo hizo.
      if (panel() && !panel().classList.contains('active') && typeof showPanel === 'function') showPanel('doc');
      wireEditing();
      if (!ui.snap) {
        ui.snap = await API.docState({});
        repaint();
      } else {
        repaint();
      }
      return api;
    },
    toggle() {
      const t = docTab();
      if (t && state0().activeTab === t.id) return api.close();
      return api.open();
    },
    close() {
      // Volcar lo que haya en el textarea antes de cerrar la pestaña: si no, el
      // ultimo renglon que se estaba escribiendo se perdia.
      flushPending();
      if (ui.snap && ui.snap.dirty) API.docWorkSave();
      const t = docTab();
      const s = state0();
      if (!t) return;
      // No se puede cerrar la última pestaña: en ese caso se vuelve a la
      // primera que no sea de documentos.
      if (typeof closeTab === 'function' && (s.tabs || []).length > 1) {
        closeTab({ stopPropagation() {} }, t.id);
      } else {
        const otra = (s.tabs || []).find((x) => x.url !== TAB_URL);
        if (otra && typeof switchTab === 'function') switchTab(otra.id);
      }
      const btn = document.getElementById(BTN_ID);
      if (btn) btn.classList.remove('open');
    },
    isOpen() {
      const t = docTab();
      return !!(t && state0().activeTab === t.id);
    },
    /** Lo llama el main cuando el SO abre un archivo con la app. */
    async openPath(p) {
      await api.open();
      // El main ya abrio el archivo y mando el snapshot con la peticion: solo
      // hay que mostrarlo. Si por alguna razon no vino, se pide explicitamente
      // (con withBytes:false, que los bytes del PDF se piden aparte).
      if (p && p.snap) {
        applySnapshot(p.snap);
      } else {
        const res = await API.docOpenPath({ path: (p && p.path) || '', withBytes: false });
        if (res && res.error) { toast(res.error, 'error'); return res; }
        if (res && res.ok) applySnapshot(res);
      }
      setView('content');
      return ui.snap;
    },
    snapshot() { return ui.snap; },
    applySnapshot
  };

  window.DocEditor = api;

  // ── Eventos del main ───────────────────────────────────────────────────
  try {
    API.on('doc:changed', (snap) => {
      ui.snap = snap;
      if (!host()) return;
      if (isActive()) repaint();
      else renderChrome();   // alcanza con actualizar el título de la pestaña
      const btn = document.getElementById(BTN_ID);
      if (btn) btn.classList.toggle('open', api.isOpen());
    });
    API.on('doc:open-request', (p) => { api.openPath(p); });
    API.on('doc:error', (p) => toast((p && p.error) || 'Error del editor', 'error'));
  } catch {}

  // ── Arranque ───────────────────────────────────────────────────────────
  function boot() {
    injectStyles();
    injectButton();
    buildUI();
    document.addEventListener('keydown', onKeyDown, true);
    API.docState({}).then((snap) => {
      ui.snap = snap;
      if (snap && snap.open && host()) renderChrome();
    }).catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // El panel y la barra lateral pueden aparecer después (la barra se
  // reemplaza al cambiar de sesión). Se agrupa con rAF para no correr por
  // cada nodo que mueve la app.
  let moQueued = false;
  const mo = new MutationObserver(() => {
    if (moQueued) return;
    moQueued = true;
    requestAnimationFrame(() => {
      moQueued = false;
      injectButton();
      buildUI();
    });
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();