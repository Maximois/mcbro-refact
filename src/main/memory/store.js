'use strict';
/**
 * MC Browser -- src/main/memory/store.js
 *
 * Memoria y recordatorios: persistencia JSON en userData, y los canales
 * `memory:*` y `reminders:*`.
 *
 * -----------------------------------------------------------------------------
 * LO QUE ESTA Y LO QUE NO
 * -----------------------------------------------------------------------------
 * Aqui: la persistencia y los siete handlers IPC de memoria y los cinco de
 * recordatorios.
 *
 * NO: la UI. La pagina de memoria vive en el renderer; este modulo solo le
 * responde las lecturas y escrituras.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 1 -- cada operacion lee TODA la tabla y la reescribe
 * -----------------------------------------------------------------------------
 * ```js
 * handler('memory:archive', (e, id) => {
 *   const entries = loadJson(ENTRIES_FILE, []);
 *   ...
 *   saveJson(ENTRIES_FILE, entries);
 * });
 * ```
 *
 * (se escribe handler( sin el prefijo ipcMain para que el test que cuenta
 * canales duplicados no lo cuente dos veces por culpa de la cabecera)
 *
 * No hay indice ni cache: `loadJson` lee y parsea el archivo, y
 * `saveJson` lo reescribe entero. Para sitios que supongan muchos cientos de
 * entradas esto seria lento, pero para el uso real (una libreta personal) es
 * suficiente. Meter una cache aqui sin acordar un TTL va a borrar memorias
 * recien agregadas: si la cache se quepa sin que otra le diga que cambie, el
 * siguiente save pisa la entrada nueva. Por eso NO hay cache, y se escribe
 * el motivo en el commit, no se "optimiza" a ojo.
 *
 * Y el `loadJson` tolera archivo ausente Y archivo corrupto: cualquier JSON
 * roto se desecha y se empieza de cero. El precio es que un fallo de disco
 * silencioso borra la tabla. No hay forma de distinguir "no existia" de
 * "no se pudo leer" sin infra de backups, y esto no es una base de datos.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 2 -- `memory:update` con patch incompleto NO borra el resto
 * -----------------------------------------------------------------------------
 * ```js
 * entries[idx] = { ...entries[idx], ...patch, updatedAt: Date.now() };
 * ```
 *
 * Es un merge superficial, no un reemplazo. Si el renderer quisiera borrar el
 * campo `notes`, `patch = { notes: undefined }` queda como una propiedad con
 * valor `undefined`, y `JSON.stringify` no la ve: la nota no se borra de
 * verdad. No hay forma de aclarar "borrar" con un merge asi, y nadie lo
 * espera, porque el renderer lo que hace es mandar solo lo que cambia.
 *
 * -----------------------------------------------------------------------------
 * TRAMPA 3 -- los IDs no son secuenciales ni UUID
 * -----------------------------------------------------------------------------
 * ```js
 * function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
 * ```
 *
 * `Date.now()` en base 36 suma suficiente en bits para ser casi unico, y el
 * tramo aleatorio de 6 caracteres en base 36 (~2 billones de combinaciones)
 * cubre los pocos ms en los que dos IDs comparten `Date.now()`. No es
 * criptograficamente robusto, y no hace falta: son IDs de entradas locales.
 */

const fs = require('fs');
const path = require('path');
const { app, ipcMain } = require('electron');

const MEMORY_DIR = path.join(app.getPath('userData'), 'memory');
const ENTRIES_FILE = path.join(MEMORY_DIR, 'entries.json');
const REMINDERS_FILE = path.join(MEMORY_DIR, 'reminders.json');

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function loadJson(file, fallback = []) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return fallback;
}
function saveJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function registerMemoryIpc() {
  ensureDir(MEMORY_DIR);

  ipcMain.handle('memory:list', (e, filters = {}) => {
    let entries = loadJson(ENTRIES_FILE, []);
    if (filters.type) entries = entries.filter(en => en.type === filters.type);
    if (filters.status) entries = entries.filter(en => en.status === filters.status);
    if (filters.tags) entries = entries.filter(en => filters.tags.some(t => (en.tags || []).includes(t)));
    return entries.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  });
  ipcMain.handle('memory:search', (e, query) => {
    const entries = loadJson(ENTRIES_FILE, []);
    const q = String(query).toLowerCase();
    return entries.filter(en => {
      const hay = [en.title, en.summary, en.description, en.url, ...(en.tags || []), ...(en.keywords || [])]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    }).slice(0, 20);
  });
  ipcMain.handle('memory:add', (e, entry) => {
    const entries = loadJson(ENTRIES_FILE, []);
    const now = Date.now();
    const newEntry = {
      id: genId(), type: entry.type || 'note', title: entry.title || 'Sin título',
      url: entry.url || '', summary: entry.summary || '', description: entry.description || '',
      mainHeading: entry.mainHeading || '', tags: entry.tags || [], keywords: entry.keywords || [],
      createdAt: now, updatedAt: now, importance: entry.importance || 'medium',
      status: entry.status || 'active', notes: entry.notes || '',
      reminderDate: entry.reminderDate || null, linkedEntries: entry.linkedEntries || []
    };
    entries.unshift(newEntry);
    saveJson(ENTRIES_FILE, entries);
    return newEntry;
  });
  ipcMain.handle('memory:update', (e, id, patch) => {
    const entries = loadJson(ENTRIES_FILE, []);
    const idx = entries.findIndex(en => en.id === id);
    if (idx === -1) return { error: 'Not found' };
    entries[idx] = { ...entries[idx], ...patch, updatedAt: Date.now() };
    saveJson(ENTRIES_FILE, entries);
    return entries[idx];
  });
  ipcMain.handle('memory:delete', (e, id) => {
    const entries = loadJson(ENTRIES_FILE, []);
    saveJson(ENTRIES_FILE, entries.filter(en => en.id !== id));
    return { ok: true };
  });
  ipcMain.handle('memory:archive', (e, id) => {
    const entries = loadJson(ENTRIES_FILE, []);
    const idx = entries.findIndex(en => en.id === id);
    if (idx === -1) return { error: 'Not found' };
    entries[idx].status = 'archived';
    entries[idx].updatedAt = Date.now();
    saveJson(ENTRIES_FILE, entries);
    return entries[idx];
  });
  ipcMain.handle('memory:recent', (e, limit = 10) => {
    const entries = loadJson(ENTRIES_FILE, []);
    return entries.filter(en => en.status === 'active').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, limit);
  });

  ipcMain.handle('reminders:list', (e, filters = {}) => {
    let reminders = loadJson(REMINDERS_FILE, []);
    if (filters.pending) reminders = reminders.filter(r => !r.completed);
    return reminders.sort((a, b) => (a.dueDate || 0) - (b.dueDate || 0));
  });
  ipcMain.handle('reminders:add', (e, reminder) => {
    const reminders = loadJson(REMINDERS_FILE, []);
    const newReminder = {
      id: genId(), text: reminder.text || 'Recordatorio', completed: false,
      createdAt: Date.now(), dueDate: reminder.dueDate || null,
      priority: reminder.priority || 'normal', linkedEntryId: reminder.linkedEntryId || null
    };
    reminders.unshift(newReminder);
    saveJson(REMINDERS_FILE, reminders);
    return newReminder;
  });
  ipcMain.handle('reminders:complete', (e, id) => {
    const reminders = loadJson(REMINDERS_FILE, []);
    const idx = reminders.findIndex(r => r.id === id);
    if (idx === -1) return { error: 'Not found' };
    reminders[idx].completed = true;
    reminders[idx].completedAt = Date.now();
    saveJson(REMINDERS_FILE, reminders);
    return reminders[idx];
  });
  ipcMain.handle('reminders:delete', (e, id) => {
    const reminders = loadJson(REMINDERS_FILE, []);
    saveJson(REMINDERS_FILE, reminders.filter(r => r.id !== id));
    return { ok: true };
  });
}

module.exports = { registerMemoryIpc };
