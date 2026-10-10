'use strict';

// ── LAB FILE SYSTEM BRIDGE ──────────────────────────────────────
// Expone window.lab.fs al iframe del laboratorio para leer/escribir archivos
// El iframe tiene allow-same-origin, así que puede acceder a window.parent
window.lab = window.lab || {};
window.lab.fs = {
  /** Guardar archivo (texto) */
  async save(filename, content) {
    return await mc.labFsWrite({ filePath: filename, content });
  },
  /** Leer archivo (texto) */
  async load(filename) {
    const res = await mc.labFsRead({ filePath: filename });
    if (res.ok) return res.content;
    return null;
  },
  /** Guardar archivo binario (base64) */
  async saveBinary(filename, base64Data) {
    return await mc.labFsWrite({ filePath: filename, content: base64Data });
  },
  /** Leer archivo binario (devuelve base64) */
  async loadBinary(filename) {
    return await mc.labFsReadBinary({ filePath: filename });
  },
  /** Verificar si existe */
  async exists(filename) {
    const res = await mc.labFsExists({ filePath: filename });
    return res.exists || false;
  },
  /** Listar archivos en directorio */
  async list(dirPath) {
    const res = await mc.labFsList({ dirPath: dirPath || '.' });
    return res.files || [];
  },
  /** Eliminar archivo */
  async remove(filename) {
    return await mc.labFsDelete({ filePath: filename });
  },
  /** Crear directorio */
  async mkdir(dirPath) {
    return await mc.labFsMkdir({ dirPath });
  },
  /** Guardar diálogo nativo */
  async saveDialog(content, defaultName) {
    return await mc.labFsSaveDialog({ defaultName: defaultName || 'game.js', content });
  },
  /** Abrir diálogo nativo */
  async openDialog() {
    return await mc.labFsOpenDialog();
  }
};
// ── laboratorio web (tabs, búsqueda, historial) ──
const LAB_TEMPLATES = {
  blank: '<!DOCTYPE html>\n<html>\n<head>\n  <title>Lab</title>\n</head>\n<body>\n\n</body>\n</html>',
  hello: '<!DOCTYPE html>\n<html>\n<head>\n  <title>Hola Mundo</title>\n  <style>\n    body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #667eea, #764ba2); color: #fff; }\n    h1 { font-size: 3em; text-shadow: 2px 2px 4px rgba(0,0,0,.3); }\n  </style>\n</head>\n<body>\n  <h1>✨ Hola, Mundo!</h1>\n</body>\n</html>',
  fetch: '<!DOCTYPE html>\n<html>\n<head>\n  <title>Fetch API</title>\n  <style>\n    body { font-family: sans-serif; padding: 20px; background: #1a1a2e; color: #eee; }\n    pre { background: #16213e; padding: 10px; border-radius: 6px; overflow-x: auto; }\n    button { background: #0f3460; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }\n    button:hover { background: #1a5276; }\n  </style>\n</head>\n<body>\n  <h2>Fetch API Demo</h2>\n  <button onclick="fetch(\'https://jsonplaceholder.typicode.com/todos/1\').then(r=>r.json()).then(d=>document.getElementById(\'out\').textContent=JSON.stringify(d,null,2))">Cargar JSON</button>\n  <pre id="out">Hacé clic para cargar datos</pre>\n</body>\n</html>',
  canvas: '<!DOCTYPE html>\n<html>\n<head>\n  <title>Canvas Demo</title>\n  <style>\n    body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #111; }\n    canvas { border-radius: 8px; box-shadow: 0 0 20px rgba(0,0,0,.5); }\n  </style>\n</head>\n<body>\n  <canvas id="c"></canvas>\n  <script>\n    const c = document.getElementById(\'c\');\n    const ctx = c.getContext(\'2d\');\n    c.width = 400; c.height = 400;\n    let t = 0;\n    function draw() {\n      ctx.clearRect(0, 0, c.width, c.height);\n      for (let i = 0; i < 20; i++) {\n        ctx.beginPath();\n        ctx.arc(200 + Math.sin(t + i * 0.3) * 100, 200 + Math.cos(t + i * 0.3) * 100, 15, 0, Math.PI * 2);\n        ctx.fillStyle = \`hsl(\${i * 18 + t * 20}, 80%, 60%)\`;\n        ctx.fill();\n      }\n      t += 0.02;\n      requestAnimationFrame(draw);\n    }\n    draw();\n  <\\/script>\n</body>\n</html>',
  'css-anim': '<!DOCTYPE html>\n<html>\n<head>\n  <title>CSS Animation</title>\n  <style>\n    * { margin: 0; padding: 0; box-sizing: border-box; }\n    body { display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #0f0f23; overflow: hidden; }\n    .scene { position: relative; width: 300px; height: 300px; }\n    .orbit { position: absolute; inset: 0; border: 1px solid rgba(255,255,255,0.1); border-radius: 50%; animation: spin 4s linear infinite; }\n    .orbit:nth-child(2) { inset: 30px; animation-duration: 3s; animation-direction: reverse; }\n    .orbit:nth-child(3) { inset: 60px; animation-duration: 5s; }\n    .dot { position: absolute; width: 12px; height: 12px; background: #00d4ff; border-radius: 50%; box-shadow: 0 0 20px #00d4ff, 0 0 40px #00d4ff; top: -6px; left: 50%; transform: translateX(-50%); }\n    .orbit:nth-child(2) .dot { background: #ff006e; box-shadow: 0 0 20px #ff006e, 0 0 40px #ff006e; }\n    .orbit:nth-child(3) .dot { background: #00ff87; box-shadow: 0 0 20px #00ff87, 0 0 40px #00ff87; }\n    .center { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); width: 30px; height: 30px; background: radial-gradient(circle, #fff, #00d4ff); border-radius: 50%; box-shadow: 0 0 40px rgba(0,212,255,0.5); animation: pulse 2s ease-in-out infinite; }\n    @keyframes spin { to { transform: rotate(360deg); } }\n    @keyframes pulse { 0%,100% { transform: translate(-50%,-50%) scale(1); } 50% { transform: translate(-50%,-50%) scale(1.3); } }\n  </style>\n</head>\n<body>\n  <div class="scene">\n    <div class="orbit"><div class="dot"></div></div>\n    <div class="orbit"><div class="dot"></div></div>\n    <div class="orbit"><div class="dot"></div></div>\n    <div class="center"></div>\n  </div>\n</body>\n</html>',
  'svg-anim': '<!DOCTYPE html>\n<html>\n<head>\n  <title>SVG Animation</title>\n  <style>\n    body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #0a0a1a; }\n    svg { filter: drop-shadow(0 0 30px rgba(139,92,246,0.4)); }\n    .ring { fill: none; stroke-width: 3; stroke-linecap: round; stroke-dasharray: 280; stroke-dashoffset: 280; animation: draw 3s ease-in-out infinite; }\n    .r1 { stroke: #8b5cf6; animation-delay: 0s; }\n    .r2 { stroke: #ec4899; animation-delay: 0.5s; }\n    .r3 { stroke: #06b6d4; animation-delay: 1s; }\n    .r4 { stroke: #10b981; animation-delay: 1.5s; }\n    @keyframes draw { 0% { stroke-dashoffset: 280; } 50% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: -280; } }\n    .star { fill: #fff; animation: twinkle 1.5s ease-in-out infinite; }\n    .star:nth-child(2) { animation-delay: 0.3s; }\n    .star:nth-child(3) { animation-delay: 0.7s; }\n    @keyframes twinkle { 0%,100% { opacity: 0.2; r: 2; } 50% { opacity: 1; r: 4; } }\n  </style>\n</head>\n<body>\n  <svg width="400" height="400" viewBox="0 0 400 400">\n    <circle class="ring r1" cx="200" cy="200" r="150" />\n    <circle class="ring r2" cx="200" cy="200" r="120" />\n    <circle class="ring r3" cx="200" cy="200" r="90" />\n    <circle class="ring r4" cx="200" cy="200" r="60" />\n    <circle class="star" cx="200" cy="50" r="3" />\n    <circle class="star" cx="350" cy="200" r="3" />\n    <circle class="star" cx="200" cy="350" r="3" />\n  </svg>\n</body>\n</html>',
  'particles': '<!DOCTYPE html>\n<html>\n<head>\n  <title>Partículas</title>\n  <style>\n    body { margin: 0; overflow: hidden; background: #000; }\n    canvas { display: block; }\n  </style>\n</head>\n<body>\n  <canvas id="c"></canvas>\n  <script>\n    const c = document.getElementById(\'c\'); const ctx = c.getContext(\'2d\');\n    let W, H; function resize() { W = c.width = innerWidth; H = c.height = innerHeight; } resize(); addEventListener(\'resize\', resize);\n    const particles = Array.from({length: 120}, () => ({\n      x: Math.random() * innerWidth, y: Math.random() * innerHeight,\n      vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2,\n      r: Math.random() * 3 + 1, hue: Math.random() * 360\n    }));\n    function draw() {\n      ctx.fillStyle = \`rgba(0,0,0,0.08)\`; ctx.fillRect(0, 0, W, H);\n      for (const p of particles) {\n        p.x += p.vx; p.y += p.vy; p.hue += 0.5;\n        if (p.x < 0 || p.x > W) p.vx *= -1;\n        if (p.y < 0 || p.y > H) p.vy *= -1;\n        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);\n        ctx.fillStyle = \`hsl(\${p.hue}, 80%, 60%)\`; ctx.fill();\n      }\n      for (let i = 0; i < particles.length; i++) {\n        for (let j = i + 1; j < particles.length; j++) {\n          const dx = particles[i].x - particles[j].x;\n          const dy = particles[i].y - particles[j].y;\n          const d = Math.sqrt(dx*dx + dy*dy);\n          if (d < 120) {\n            ctx.beginPath(); ctx.moveTo(particles[i].x, particles[i].y);\n            ctx.lineTo(particles[j].x, particles[j].y);\n            ctx.strokeStyle = \`hsla(\${particles[i].hue}, 70%, 50%, \${1 - d/120})\`;\n            ctx.lineWidth = 0.5; ctx.stroke();\n          }\n        }\n      }\n      requestAnimationFrame(draw);\n    }\n    draw();\n  <\\/script>\n</body>\n</html>',
  'gradient-wave': '<!DOCTYPE html>\n<html>\n<head>\n  <title>Gradient Wave</title>\n  <style>\n    body { margin: 0; overflow: hidden; background: #0f0f23; }\n    canvas { display: block; }\n  </style>\n</head>\n<body>\n  <canvas id="c"></canvas>\n  <script>\n    const c = document.getElementById(\'c\'); const ctx = c.getContext(\'2d\');\n    let W, H; function resize() { W = c.width = innerWidth; H = c.height = innerHeight; } resize(); addEventListener(\'resize\', resize);\n    let t = 0;\n    function draw() {\n      ctx.fillStyle = \'rgba(15,15,35,0.15)\'; ctx.fillRect(0, 0, W, H);\n      for (let i = 0; i < 5; i++) {\n        ctx.beginPath(); ctx.moveTo(0, H / 2);\n        for (let x = 0; x <= W; x += 4) {\n          const y = H / 2 + Math.sin(x * 0.005 + t + i * 0.8) * (60 + i * 25) * Math.sin(t * 0.3 + i);\n          ctx.lineTo(x, y);\n        }\n        ctx.strokeStyle = \`hsla(\${200 + i * 35}, 80%, 60%, 0.6)\`;\n        ctx.lineWidth = 2; ctx.stroke();\n      }\n      t += 0.03; requestAnimationFrame(draw);\n    }\n    draw();\n  <\\/script>\n</body>\n</html>',
  video: '<!DOCTYPE html>\n<html>\n<head>\n  <title>Reproductor de Video</title>\n  <style>\n    body { font-family: sans-serif; padding: 20px; background: #1a1a2e; color: #eee; }\n    video { width: 100%; max-width: 640px; border-radius: 8px; }\n    input { width: 100%; max-width: 640px; padding: 8px; margin: 8px 0; background: #16213e; color: #eee; border: 1px solid #333; border-radius: 4px; }\n    button { background: #0f3460; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }\n  </style>\n</head>\n<body>\n  <h2>Reproductor</h2>\n  <input id="url" type="text" placeholder="URL del video (.mp4, .m3u8)" value="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4">\n  <button onclick="document.getElementById(\'v\').src=document.getElementById(\'url\').value">Cargar</button>\n  <br>\n  <video id="v" controls autoplay></video>\n</body>\n</html>'
};

// Estado del laboratorio
let labTabs = [];
let labActiveTab = null;
let labTabCounter = 0;
let labHistory = [];
let labHistoryVisible = false;
let labSearchIndex = -1;
let labSearchMatches = [];

function labInit() {
  // labLoadState puede devolver Promise (disco) o valor sync (localStorage fallback)
  const result = labLoadState();
  const applyState = (saved) => {
    if (saved && saved.tabs && saved.tabs.length) {
      labTabs = saved.tabs;
      labActiveTab = saved.activeTab || labTabs[0]?.id || null;
      labHistory = saved.history || [];
      // Restaurar tamaño de exportación
      if (saved.exportSize) {
        const sz = document.getElementById('lab-size');
        if (sz) sz.value = saved.exportSize;
      }
    } else {
      labAddTab(true);
    }
    labRenderTabs();
    labSwitchTab(labActiveTab);
    // Restaurar estado colapsado del editor
    try {
      if (localStorage.getItem('mc_lab_editor_collapsed') === '1') {
        _labEditorCollapsed = false; // reset para que toggle lo active
        labToggleEditor();
      }
    } catch {}
    _labUpdateUndoRedoBtns();
  };
  if (result && typeof result.then === 'function') {
    result.then(applyState).catch(() => applyState(null));
  } else {
    applyState(result);
  }
}

function labSaveState() {
  try {
    const ta = document.getElementById('lab-code');
    if (ta) {
      const tab = labTabs.find(t => t.id === labActiveTab);
      if (tab) tab.code = ta.value;
    }
    const sz = document.getElementById('lab-size');
    const payload = { tabs: labTabs, activeTab: labActiveTab, history: labHistory, exportSize: sz ? sz.value : 'auto' };
    localStorage.setItem('mc_lab_state', JSON.stringify(payload));
    if (typeof mc !== 'undefined' && mc.labStateSave) {
      mc.labStateSave(payload).catch(e => {});
    }
  } catch {}
}
function labLoadState() {
  try {
    // Intentar cargar del disco primero
    if (typeof mc !== 'undefined' && mc.labStateLoad) {
      return mc.labStateLoad().then(res => {
        if (res?.ok && res.state) {
          // Actualizar localStorage como fallback
          localStorage.setItem('mc_lab_state', JSON.stringify(res.state));
          return res.state;
        }
        // Fallback a localStorage
        return JSON.parse(localStorage.getItem('mc_lab_state') || 'null');
      }).catch(() => JSON.parse(localStorage.getItem('mc_lab_state') || 'null'));
    }
    return JSON.parse(localStorage.getItem('mc_lab_state') || 'null');
  } catch { return null; }
}

function labAddTab(silent) {
  labTabCounter++;
  const id = 'lab-tab-' + labTabCounter;
  const tab = { id, name: 'Hoja ' + labTabCounter, code: LAB_TEMPLATES.blank };
  labTabs.push(tab);
  if (!silent) {
    labSwitchTab(id);
    labRenderTabs();
    labSaveState();
  }
  return id;
}

function labRemoveTab(id) {
  if (labTabs.length <= 1) { labAddTab(); }
  const idx = labTabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  labTabs.splice(idx, 1);
  if (labActiveTab === id) {
    const next = labTabs[Math.min(idx, labTabs.length - 1)];
    labSwitchTab(next.id);
  }
  labRenderTabs();
  labSaveState();
}

function labRenameTab(id, name) {
  const tab = labTabs.find(t => t.id === id);
  if (!tab) return;
  tab.name = name;
  labRenderTabs();
  labSaveState();
}

function labSwitchTab(id) {
  // Save current tab's code
  const ta = document.getElementById('lab-code');
  if (ta) {
    const old = labTabs.find(t => t.id === labActiveTab);
    if (old) old.code = ta.value;
  }
  labActiveTab = id;
  // Load new tab's code
  const tab = labTabs.find(t => t.id === id);
  if (ta && tab) {
    ta.value = tab.code;
    _labPushHistory(tab.code);
    // Run preview
    if (tab.code) {
      const frame = document.getElementById('lab-frame');
      if (frame) frame.srcdoc = tab.code;
    }
  }
  labRenderTabs();
  labSaveState();
}

function labRenderTabs() {
  const bar = document.getElementById('lab-tabbar');
  if (!bar) return;
  bar.innerHTML = labTabs.map(t =>
    '<div class="lab-tab' + (t.id === labActiveTab ? ' active' : '') + '" onclick="labSwitchTab(\'' + t.id + '\')" ondblclick="labRenamePrompt(\'' + t.id + '\')">' +
    '<span>' + t.name + '</span>' +
    '<span class="lab-tab-close" onclick="event.stopPropagation();labRemoveTab(\'' + t.id + '\')">✕</span>' +
    '</div>'
  ).join('') + '<button class="lab-tab-add" onclick="labAddTab()" title="Nueva hoja">+</button>';
}

async function labRenamePrompt(id) {
  const tab = labTabs.find(t => t.id === id);
  if (!tab) return;
  const name = await mcDialog.prompt('Nombre de la hoja:', tab.name);
  if (name && name.trim()) labRenameTab(id, name.trim());
}

// ── UNDO / REDO ──
const _labHistory = { stack: [], pointer: -1, maxSize: 100, _skipNext: false };

function _labPushHistory(val) {
  if (_labHistory._skipNext) { _labHistory._skipNext = false; return; }
  // Si estamos en medio del stack (después de un undo), cortar el futuro
  if (_labHistory.pointer < _labHistory.stack.length - 1) {
    _labHistory.stack = _labHistory.stack.slice(0, _labHistory.pointer + 1);
  }
  // No duplicar si es igual al último
  if (_labHistory.stack.length && _labHistory.stack[_labHistory.stack.length - 1] === val) return;
  _labHistory.stack.push(val);
  if (_labHistory.stack.length > _labHistory.maxSize) _labHistory.stack.shift();
  _labHistory.pointer = _labHistory.stack.length - 1;
  _labUpdateUndoRedoBtns();
}

function labUndo() {
  if (_labHistory.pointer <= 0) return;
  _labHistory.pointer--;
  _labHistory._skipNext = true;
  document.getElementById('lab-code').value = _labHistory.stack[_labHistory.pointer];
  _labUpdateUndoRedoBtns();
}

function labRedo() {
  if (_labHistory.pointer >= _labHistory.stack.length - 1) return;
  _labHistory.pointer++;
  _labHistory._skipNext = true;
  document.getElementById('lab-code').value = _labHistory.stack[_labHistory.pointer];
  _labUpdateUndoRedoBtns();
}

function _labUpdateUndoRedoBtns() {
  const undo = document.getElementById('lab-undo-btn');
  const redo = document.getElementById('lab-redo-btn');
  if (undo) undo.style.opacity = _labHistory.pointer > 0 ? '1' : '0.35';
  if (redo) redo.style.opacity = _labHistory.pointer < _labHistory.stack.length - 1 ? '1' : '0.35';
}

// ── ejecutar / limpiar ──
// ── LAB CONSOLE MONITOR ──────────────────────────────────────
// Captura console.log/error/warning del iframe del lab para que el AI sepa qué pasa
const _labConsoleLogs = [];  // {type, text, time}
const _labMaxLogs = 50;

function _labInjectConsoleCapture(frame) {
  try {
    const doc = frame.contentDocument || frame.contentWindow?.document;
    if (!doc) return;
    const script = doc.createElement('script');
    script.textContent = `
      (function() {
        const _origConsole = { log: console.log, error: console.error, warn: console.warn, info: console.info };
        function _send(type, args) {
          try {
            const text = Array.from(args).map(a => {
              if (a === null) return 'null';
              if (a === undefined) return 'undefined';
              if (typeof a === 'object') try { return JSON.stringify(a).slice(0,500); } catch { return String(a); }
              return String(a).slice(0, 500);
            }).join(' ');
            window.parent.postMessage({ __labConsole: true, type, text, time: Date.now() }, '*');
          } catch {}
        }
        console.log = function() { _send('log', arguments); _origConsole.log.apply(console, arguments); };
        console.error = function() { _send('error', arguments); _origConsole.error.apply(console, arguments); };
        console.warn = function() { _send('warn', arguments); _origConsole.warn.apply(console, arguments); };
        console.info = function() { _send('info', arguments); _origConsole.info.apply(console, arguments); };
        window.onerror = function(msg, src, line, col, err) {
          _send('error', ['[Uncaught] ' + msg + ' (line ' + line + ':' + col + ')']);
        };
        window.addEventListener('unhandledrejection', function(e) {
          _send('error', ['[UnhandledRejection] ' + String(e.reason).slice(0, 300)]);
        });
      })();
    `;
    doc.head.appendChild(script);
  } catch {}
}

// Escuchar mensajes del iframe
window.addEventListener('message', (e) => {
  if (e.data && e.data.__labConsole) {
    _labConsoleLogs.push({ type: e.data.type, text: e.data.text, time: e.data.time });
    if (_labConsoleLogs.length > _labMaxLogs) _labConsoleLogs.shift();
    // Mostrar errores en el sidebar
    if (e.data.type === 'error') {
      addSidebarLog('error', '[LAB] ' + e.data.text.slice(0, 200));
    }
  }
});

function labGetConsoleLogs() {
  return _labConsoleLogs.slice(-20);  // últimos 20
}

function runLab() {
  const ta = document.getElementById('lab-code');
  if (!ta) return;
  const code = ta.value;
  if (!code) return;
  const frame = document.getElementById('lab-frame');
  if (frame) {
    // Limpiar logs anteriores
    _labConsoleLogs.length = 0;
    // Force a full reload to ensure scripts re-run and animations restart
    try { frame.src = 'about:blank'; } catch {}
    setTimeout(() => {
      try { frame.srcdoc = code; } catch {}
      // Inyectar captura de consola después de cargar
      setTimeout(() => _labInjectConsoleCapture(frame), 100);
    }, 10);
  }
  // Reset segment counter on new code
  if (_labRecorder && _labRecorder.state === 'recording') {
    labStopRecording();
  }
  _labSegments = 0;
  const info = document.getElementById('lab-rec-info');
  if (info) { info.style.display = 'none'; info.textContent = ''; }
  const tab = labTabs.find(t => t.id === labActiveTab);
  if (tab) tab.code = code;
  const tabEl = state.tabs.find(t => t.id === state.activeTab);
  if (tabEl) { tabEl.url = 'mc://lab'; tabEl.title = '⚗ Lab'; }
  const te = document.querySelector('#tab-'+state.activeTab+' .tab-title');
  if (te) te.textContent = '⚗ Lab';
  labAddHistory(code);
  labSaveState();
}

function labClearCurrent() {
  const ta = document.getElementById('lab-code');
  if (ta) { ta.value = ''; _labPushHistory(''); }
  const frame = document.getElementById('lab-frame');
  if (frame) frame.srcdoc = '';
  const tab = labTabs.find(t => t.id === labActiveTab);
  if (tab) tab.code = '';
  labSaveState();
}

function loadLabTemplate(val) {
  if (!val || !LAB_TEMPLATES[val]) return;
  const ta = document.getElementById('lab-code');
  if (ta) { ta.value = LAB_TEMPLATES[val]; _labPushHistory(LAB_TEMPLATES[val]); }
  const tab = labTabs.find(t => t.id === labActiveTab);
  if (tab) tab.code = LAB_TEMPLATES[val];
  setTimeout(runLab, 100);
}

// ── exportar ──
function labExportCount() {
  let n = 1;
  try { n = parseInt(localStorage.getItem('mc_lab_export_count') || '1', 10); } catch {}
  return n;
}
function labExportBump() {
  try { localStorage.setItem('mc_lab_export_count', String(labExportCount() + 1)); } catch {}
}
function labExportName(ext) {
  const tab = labTabs.find(t => t.id === labActiveTab);
  const base = tab ? tab.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase() : 'lab';
  const n = labExportCount();
  return base + '-' + n + '.' + ext;
}
function exportLabHtml() {
  const code = document.getElementById('lab-code')?.value;
  if (!code) return;
  const blob = new Blob([code], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = labExportName('html');
  a.click();
  URL.revokeObjectURL(a.href);
  labExportBump();
  addSidebarLog('info', '[LAB] HTML exportado: ' + a.download);
}
function exportLabJs() {
  const code = document.getElementById('lab-code')?.value;
  if (!code) return;
  const js = `(function(){\n'use strict';\nconst container = document.getElementById('app') || document.body;\ncontainer.innerHTML = \`${code.replace(/`/g, '\\`').replace(/\${/g, '\\${')}\`;\n})();`;
  const blob = new Blob([js], { type: 'text/javascript' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = labExportName('js');
  a.click();
  URL.revokeObjectURL(a.href);
  labExportBump();
  addSidebarLog('info', '[LAB] JS exportado: ' + a.download);
}

// ── obtener tamaño de exportación del selector ──
function labGetSize() {
  const sel = document.getElementById('lab-size');
  const val = sel ? sel.value : 'auto';
  if (val === 'auto') return null;
  const [w, h] = val.split('x').map(Number);
  return (w > 0 && h > 0) ? { w, h } : null;
}

// ── exportar como imagen (PNG/JPEG) ──
async function exportLabImage(format) {
  const code = document.getElementById('lab-code')?.value;
  if (!code) { addSidebarLog('error', '[LAB] No hay código para capturar'); return; }
  const frame = document.getElementById('lab-frame');
  const sz = labGetSize();
  const w = sz?.w || (frame ? Math.round(frame.clientWidth) || 1280 : 1280);
  const h = sz?.h || (frame ? Math.round(frame.clientHeight) || 800 : 800);
  try {
    addSidebarLog('info', `[LAB] Capturando ${format.toUpperCase()} ${w}×${h}...`);
    const res = await mc.labCapture({ html: code, width: w, height: h, format, delay: 600 });
    if (!res.ok) { addSidebarLog('error', '[LAB] Error: ' + res.error); return; }
    const ext = format === 'jpeg' ? 'jpg' : 'png';
    const saveRes = await mc.aiMediaSave({ data: res.data, mimeType: res.mimeType, filename: labExportName(ext) });
    if (saveRes.ok) {
      addSidebarLog('info', `[LAB] ✓ Captura guardada: ${saveRes.filename} (${(res.size/1024).toFixed(1)} KB)`);
    } else {
      const buf = Uint8Array.from(atob(res.data), c => c.charCodeAt(0));
      const blob = new Blob([buf], { type: res.mimeType });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = labExportName(ext);
      a.click();
      URL.revokeObjectURL(a.href);
      addSidebarLog('info', `[LAB] ✓ Captura descargada: ${a.download}`);
    }
    labExportBump();
  } catch (e) {
    addSidebarLog('error', '[LAB] Error captura: ' + e.message);
  }
}

// ── grabación por segmentos (start/stop manual) ──
let _labRecorder = null;
let _labChunks = [];
let _labSegments = 0;
let _labRecTimer = null;
let _labRecStartTime = 0;
let _labRecFrameQueue = [];
let _labRecFrameProcessing = false;

async function labToggleRecording() {
  if (_labRecorder && _labRecorder.state === 'recording') {
    labStopRecording();
    return;
  }
  // Auto-ejecutar el código antes de grabar para que la animación arranque desde el inicio
  const code = document.getElementById('lab-code')?.value;
  if (!code) { addSidebarLog('error', '[LAB] No hay código para grabar. Escribí algo primero.'); return; }
  runLab();
  // Esperar un instante para que el iframe cargue y la animación inicie
  await new Promise(r => setTimeout(r, 200));
  const ok = await labStartRecording();
  if (!ok) addSidebarLog('error', '[LAB] No se pudo iniciar grabación.');
}

let _labRecCanvas = null;
let _labRecCtx = null;

async function labStartRecording() {
  const code = document.getElementById('lab-code')?.value;
  if (!code) { addSidebarLog('error', '[LAB] No hay código para grabar. Escribí algo primero.'); return false; }
  const frame = document.getElementById('lab-frame');
  if (!frame) { addSidebarLog('error', '[LAB] iframe no encontrado'); return false; }
  const sz = labGetSize();
  const w = sz?.w || Math.round(frame.clientWidth) || 800;
  const h = sz?.h || Math.round(frame.clientHeight) || 600;
  try {
    // Obtener bounds del iframe relativo al viewport (CSS pixels)
    const iframeRect = frame.getBoundingClientRect();
    const bounds = {
      x: Math.round(iframeRect.left),
      y: Math.round(iframeRect.top),
      width: Math.round(iframeRect.width),
      height: Math.round(iframeRect.height)
    };
    addSidebarLog('info', `[LAB] Bounds: x=${bounds.x} y=${bounds.y} ${bounds.width}×${bounds.height}`);
    // Create local canvas that receives frames from main window capture
    _labRecCanvas = document.createElement('canvas');
    _labRecCanvas.width = bounds.width; _labRecCanvas.height = bounds.height;
    _labRecCtx = _labRecCanvas.getContext('2d');
    _labRecCtx.fillStyle = '#000'; _labRecCtx.fillRect(0, 0, bounds.width, bounds.height);
    // Start capture from main window (includes user interactions)
    const res = await mc.labRecStart({ bounds });
    if (!res.ok) { addSidebarLog('error', '[LAB] Error al iniciar captura: ' + (res.error || '?')); return false; }
    // Receive frames and draw onto local canvas (sequential queue)
    _labRecFrameQueue = [];
    _labRecFrameProcessing = false;
    mc.labRecOnFrame(({ data, bounds: fb }) => {
      _labRecFrameQueue.push({ data, bounds: fb || bounds });
      if (!_labRecFrameProcessing) _labRecProcessNextFrame();
    });
    function _labRecProcessNextFrame() {
      if (_labRecFrameQueue.length === 0) { _labRecFrameProcessing = false; return; }
      _labRecFrameProcessing = true;
      const { data: b64, bounds: fb } = _labRecFrameQueue.shift();
      const img = new Image();
      img.onload = () => {
        if (_labRecCtx) {
          // La imagen capturada es la ventana completa; recortar solo el área del iframe
          // fb contiene los bounds CSS del iframe relativos al viewport
          const dpr = window.devicePixelRatio || 1;
          const sx = Math.round(fb.x * dpr);
          const sy = Math.round(fb.y * dpr);
          const sw = Math.round(fb.width * dpr);
          const sh = Math.round(fb.height * dpr);
          _labRecCtx.drawImage(img, sx, sy, sw, sh, 0, 0, bounds.width, bounds.height);
        }
        _labRecProcessNextFrame();
      };
      img.onerror = () => { _labRecProcessNextFrame(); };
      img.src = 'data:image/jpeg;base64,' + b64;
    }
    // Setup MediaRecorder on the local canvas stream
    const stream = _labRecCanvas.captureStream(30);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    _labChunks = [];
    _labRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3000000 });
    _labRecorder.ondataavailable = (e) => { if (e.data.size > 0) _labChunks.push(e.data); };
    _labRecorder.onstop = () => labSaveSegment();
    _labRecorder.start();
    _labRecStartTime = Date.now();
    // UI
    const btn = document.getElementById('lab-rec-btn');
    const info = document.getElementById('lab-rec-info');
    if (btn) { btn.textContent = '⏹ Detener'; btn.style.background = '#dc3545'; btn.style.color = '#fff'; }
    if (info) { info.style.display = 'inline'; info.textContent = '⏺ 0s'; }
    _labRecTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - _labRecStartTime) / 1000);
      if (info) {
        const m = Math.floor(sec / 60); const s = sec % 60;
        info.textContent = m > 0 ? `⏺ ${m}:${String(s).padStart(2,'0')}` : `⏺ ${sec}s`;
      }
      if (sec >= 300) { addSidebarLog('warn', '[LAB] Tope de 5 min.'); labStopRecording(); }
    }, 500);
    addSidebarLog('info', `[LAB] ⏺ Grabando #${_labSegments + 1} (${bounds.width}×${bounds.height})... (máx 5 min)`);
    return true;
  } catch (e) {
    addSidebarLog('error', '[LAB] Error: ' + (e && e.message ? e.message : String(e)));
    console.error('[LAB] Recording error', e);
    return false;
  }
}

async function labStopRecording() {
  if (!_labRecorder || _labRecorder.state !== 'recording') return;
  clearInterval(_labRecTimer);
  mc.labRecStop();
  mc.labRecOffFrame();
  _labRecorder.stop();
  _labRecCanvas = null; _labRecCtx = null;
  _labRecFrameQueue = [];
  _labRecFrameProcessing = false;
}

async function labSaveSegment() {
  _labSegments++;
  try {
    const blob = new Blob(_labChunks, { type: 'video/webm' });
    const dur = Math.round((Date.now() - _labRecStartTime) / 1000);
    const sizeKB = (blob.size / 1024).toFixed(1);
    const fname = labExportName('webm').replace('.webm', `-s${_labSegments}.webm`);
    // Conversión base64 por chunks (evita stack overflow con buffers grandes)
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const chunkSize = 8192;
    let b64 = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      b64 += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    addSidebarLog('info', `[LAB] ⏺ Guardando segmento #${_labSegments} (${dur}s, ${sizeKB} KB)...`);
    const saveRes = await mc.aiMediaSave({ data: b64, mimeType: 'video/webm', filename: fname });
    if (saveRes && saveRes.ok) {
      addSidebarLog('info', `[LAB] ✓ Segmento #${_labSegments} guardado en: ${saveRes.path || saveRes.filename} (${dur}s, ${sizeKB} KB)`);
    } else {
      // Fallback: descargar vía browser
      addSidebarLog('warn', `[LAB] No se pudo guardar en disco, descargando...`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      addSidebarLog('info', `[LAB] ✓ Segmento #${_labSegments} descargado (${dur}s, ${sizeKB} KB)`);
    }
  } catch (e) {
    addSidebarLog('error', `[LAB] ✗ Error guardando segmento #${_labSegments}: ${e.message}`);
  }
  // Reset UI
  const btn = document.getElementById('lab-rec-btn');
  const info = document.getElementById('lab-rec-info');
  if (btn) { btn.textContent = '🎥 Grabar'; btn.style.background = ''; btn.style.color = ''; }
  if (info) { info.textContent = `${_labSegments} OK`; }
  _labRecorder = null;
  _labChunks = [];
  labExportBump();
}

function labDiagnoseRecording() {
  const frame = document.getElementById('lab-frame');
  if (!frame) { addSidebarLog('error', '[LAB] iframe no presente'); return; }
  try {
    const sandbox = frame.getAttribute('sandbox');
    addSidebarLog('info', `[LAB] iframe sandbox: ${sandbox}`);
    addSidebarLog('info', `[LAB] iframe src: ${frame.src || '<<no src>>'}`);
    addSidebarLog('info', `[LAB] srcdoc length: ${frame.srcdoc ? frame.srcdoc.length : 0}`);
    let doc = null; try { doc = frame.contentDocument || frame.contentWindow?.document; } catch (e) { doc = null; }
    addSidebarLog('info', `[LAB] contentDocument: ${doc ? 'available' : 'null/denied'}`);
    if (doc) {
      addSidebarLog('info', `[LAB] readyState: ${doc.readyState}`);
      const canvases = Array.from(doc.querySelectorAll('canvas'));
      addSidebarLog('info', `[LAB] canvases found: ${canvases.length}`);
      canvases.forEach((c, i) => {
        addSidebarLog('info', `[LAB] canvas[${i}] id:${c.id||'<no-id>'} size:${c.width}x${c.height} captureStream:${!!(c.captureStream||c.mozCaptureStream)}`);
      });
      try {
        const body = doc.body;
        addSidebarLog('info', `[LAB] body innerHTML length: ${body ? body.innerHTML.length : 'n/a'}`);
        addSidebarLog('info', `[LAB] first 200 chars body: ${body ? body.innerHTML.replace(/\s+/g,' ').substring(0,200) : 'n/a'}`);
        const allEls = doc.getElementsByTagName('*').length;
        addSidebarLog('info', `[LAB] total elements in doc: ${allEls}`);
        const scripts = doc.getElementsByTagName('script').length;
        addSidebarLog('info', `[LAB] scripts found: ${scripts}`);
      } catch (e) { console.debug('[LAB DIAG] body read error', e); }
    }
    const src = frame.srcdoc || '';
    addSidebarLog('info', `[LAB] srcdoc contains '<canvas': ${/\<canvas/i.test(src)}`);
    addSidebarLog('info', `[LAB] MediaRecorder supported: ${typeof MediaRecorder !== 'undefined'}`);
    addSidebarLog('info', `[LAB] isTypeSupported(video/webm;codecs=vp9): ${MediaRecorder && MediaRecorder.isTypeSupported ? MediaRecorder.isTypeSupported('video/webm;codecs=vp9') : 'n/a'}`);
    console.debug('[LAB DIAG] frame', frame, 'doc', doc);
  } catch (e) {
    addSidebarLog('error', '[LAB] Error diagnóstico: ' + (e && e.message ? e.message : String(e)));
    console.error('[LAB DIAG] error', e);
  }
}

// ── búsqueda en editor ──
function labEditorKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    labOpenSearch();
  }
  if (e.key === 'Escape') labCloseSearch();
  // Ctrl+Z = undo, Ctrl+Y / Ctrl+Shift+Z = redo
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); labUndo(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); labRedo(); }
}
function labOpenSearch() {
  const panel = document.getElementById('lab-search');
  if (!panel) return;
  panel.classList.add('visible');
  const inp = document.getElementById('lab-search-inp');
  if (inp) { inp.value = ''; inp.focus(); }
  labSearchIndex = -1;
  labSearchMatches = [];
  document.getElementById('lab-search-count').textContent = '0/0';
}
function labCloseSearch() {
  const panel = document.getElementById('lab-search');
  if (panel) panel.classList.remove('visible');
  labClearHighlight();
  document.getElementById('lab-code')?.focus();
}
function labSearchKey(e) {
  if (e.key === 'Enter') { e.preventDefault(); labFindNext(); }
  if (e.key === 'Escape') labCloseSearch();
  labDoSearch();
}
function labDoSearch() {
  const ta = document.getElementById('lab-code');
  const inp = document.getElementById('lab-search-inp');
  if (!ta || !inp) return;
  const q = inp.value;
  if (!q) { labSearchMatches = []; labSearchIndex = -1; document.getElementById('lab-search-count').textContent = '0/0'; labClearHighlight(); return; }
  const val = ta.value;
  labSearchMatches = [];
  let idx = 0;
  while (true) {
    const pos = val.indexOf(q, idx);
    if (pos === -1) break;
    labSearchMatches.push(pos);
    idx = pos + 1;
  }
  labSearchIndex = labSearchMatches.length > 0 ? 0 : -1;
  labHighlightMatches(q);
  labScrollToMatch();
}
function labHighlightMatches(q) {
  const ta = document.getElementById('lab-code');
  if (!ta) return;
  const val = ta.value;
  if (!q || !labSearchMatches.length) { labClearHighlight(); return; }
  // Use a highlighted version — we can't visually highlight in a textarea,
  // but we can use selection to show the current match
  labScrollToMatch();
}
function labClearHighlight() {
  const ta = document.getElementById('lab-code');
  if (ta) ta.selectionStart = ta.selectionEnd = ta.value.length;
}
function labScrollToMatch() {
  const ta = document.getElementById('lab-code');
  if (!ta || labSearchIndex < 0 || !labSearchMatches.length) return;
  const pos = labSearchMatches[labSearchIndex];
  ta.focus();
  ta.selectionStart = pos;
  ta.selectionEnd = pos + document.getElementById('lab-search-inp')?.value.length || 0;
  ta.scrollTop = ta.scrollHeight * (pos / ta.value.length) - 50;
  document.getElementById('lab-search-count').textContent = (labSearchIndex + 1) + '/' + labSearchMatches.length;
}
function labFindNext() {
  if (!labSearchMatches.length) return;
  labSearchIndex = (labSearchIndex + 1) % labSearchMatches.length;
  labScrollToMatch();
}
function labFindPrev() {
  if (!labSearchMatches.length) return;
  labSearchIndex = (labSearchIndex - 1 + labSearchMatches.length) % labSearchMatches.length;
  labScrollToMatch();
}

// ── historial de trabajos ──
function labAddHistory(code) {
  if (!code || code.length < 20) return;
  const prev = labHistory[0];
  if (prev && prev.code === code) return;
  const tab = labTabs.find(t => t.id === labActiveTab);
  labHistory.unshift({ code, tab: tab ? tab.name : '?', ts: Date.now() });
  if (labHistory.length > 50) labHistory.length = 50;
  labRenderHistory();
  labSaveState();
}
let _labEditorCollapsed = false;
function labToggleEditor() {
  _labEditorCollapsed = !_labEditorCollapsed;
  const editor = document.getElementById('lab-editor');
  const toggle = document.getElementById('lab-editor-toggle');
  const preview = document.querySelector('.lab-preview');
  if (editor) editor.classList.toggle('collapsed', _labEditorCollapsed);
  if (toggle) {
    toggle.classList.toggle('collapsed', _labEditorCollapsed);
    toggle.textContent = _labEditorCollapsed ? '❯❮' : '❮❯';
    toggle.title = _labEditorCollapsed ? 'Mostrar editor' : 'Ocultar editor';
  }
  if (preview) preview.classList.toggle('expanded', _labEditorCollapsed);
  // Guardar estado
  try { localStorage.setItem('mc_lab_editor_collapsed', _labEditorCollapsed ? '1' : '0'); } catch {}
}
function labToggleHistory() {
  const panel = document.getElementById('lab-history-panel');
  if (!panel) return;
  labHistoryVisible = !labHistoryVisible;
  panel.classList.toggle('visible', labHistoryVisible);
  if (labHistoryVisible) labRenderHistory();
}
function labRenderHistory() {
  const list = document.getElementById('lab-history-list');
  if (!list) return;
  if (!labHistory.length) {
    list.innerHTML = '<div style="font-size: 0.769rem;color:var(--muted);text-align:center;padding:12px;">Sin historial — ejecutá código para guardar versiones</div>';
    return;
  }
  list.innerHTML = labHistory.map((h, i) => {
    const t = new Date(h.ts).toLocaleTimeString();
    const preview = h.code.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').substring(0, 80);
    return '<div class="lab-history-item" onclick="labRestoreHistory(' + i + ')">' +
      '<div style="flex:1;overflow:hidden;">' +
      '<div style="font-size: 0.769rem;font-weight:600;">' + h.tab + ' <span class="time">' + t + '</span></div>' +
      '<div class="code">' + preview + '</div></div>' +
      '<span class="restore">↩</span></div>';
  }).join('');
}
function labRestoreHistory(idx) {
  const h = labHistory[idx];
  if (!h) return;
  const ta = document.getElementById('lab-code');
  if (ta) { ta.value = h.code; _labPushHistory(h.code); }
  const tab = labTabs.find(t => t.id === labActiveTab);
  if (tab) tab.code = h.code;
  runLab();
  labToggleHistory();
}
async function labClearHistory() {
  if (!await mcDialog.confirm('¿Limpiar todo el historial de trabajos?', { ok: 'Limpiar', danger: true })) return;
  labHistory = [];
  labRenderHistory();
  labSaveState();
}

// Init lab on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => { setTimeout(labInit, 500); });

