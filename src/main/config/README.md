# `src/main/config`

Propietario de la **configuración persistida** de la aplicación (`cfg.json` en
`userData`).

Extraído de `main.js` en el commit "Extraer configuracion a src/main/config".
Movimiento puro: no se cambió lógica.

## Responsabilidad

1. Definir `CFG` con sus valores por defecto.
2. `loadCfg()` / `saveCfg()` — leer y escribir `cfg.json`.
3. Aplicar los defaults que el usuario no configuró:
   `ensureDefaultSiteRules()` (reglas site-scoped de publicidad en YouTube) y
   `ensureDefaultSessionDomains()` (dominios con cookie persistente).
4. Validar lo que el renderer intenta escribir: `sanitizeCfgPatch()` con la
   tabla `CFG_WRITABLE` y las listas de valores admitidos.
5. Producir el snapshot que ve la UI: `cfgSnapshot()`.
6. `resolveSafePath()` / `isPathInside()` — confundir un nombre de archivo con
   una ruta dentro de un directorio, sin poder escapar.

## Qué NO debe hacer

- **No toca sesiones, User-Agent, red ni permisos.** Solo persiste y valida
  datos. Los efectos los aplican los módulos dueños leyendo `CFG`.
- **No registra handlers de IPC.** Los de configuración viven en
  `src/main/ipc/` y se registran a nivel de módulo, para que existan siempre
  (ver la nota de `memory:*` en `docs/RESTRUCTURACION.md` §5.3 sobre handlers
  que se registraran dentro de `whenReady`).

## El invariante que hay que respetar al consumirlo

**`CFG` se reasigna, pero solo una vez, y ocurre dentro de este archivo.**

`loadCfg()` hace `CFG = { ...CFG, ...saved }`: crea un **objeto nuevo**. Es la
única reasignación de `CFG` en toda la aplicación (verificado por conteo de
identificadores sobre el `main.js` original). `loadCfg()` se invoca al final de
este mismo archivo, antes de que cualquier otro módulo lo requiera.

Consecuencia práctica:

```js
// CORRECTO — CFG ya esta cargado cuando este modulo se ejecuta
const { CFG } = require('./config');
CFG.allowlist['ejemplo.com'] = 'allow';   // afecta a todos los que lo importan

// INCORRECTO — CFG seria un objeto congelado que nadie mas ve
const cfg = { ...CFG };
cfg.allowlist['ejemplo.com'] = 'allow';   // solo cambia la copia local
```

**Nunca** se pase `CFG` por copia a un módulo, y **nunca** se capture `CFG` en
un sitio que se evalúe antes de que este archivo termine de cargar.

`saveCfg()` sí es seguro tenerla referenciada y llamarla más tarde: es una
función, lee el `CFG` vigente cuando se invoca.

## Other invariants

- **`gpuAcceleration` no surte efecto en caliente.** La aceleración por hardware
  se decide **antes** de `app.ready` (si no, Electron ya arrancó el proceso GPU
  con otra decisión). Por eso `readGpuAccelerationPref()` sigue en `bootstrap.js` y
  el resultado se inyecta con `setGpuRuntimeActive()`. `cfgSnapshot()` lo usa
  para tellingle a la UI que el cambio exige reiniciar. No mover esa lectura
  dentro de este módulo sin revisar el orden de arranque.
- **`loadCfg()` se llama al final, no desde `bootstrap.js`.** Mantenerlo así: es lo que
  hace segura la destructuración de `CFG` descrita arriba.
- **`saveCfg()` escribe de forma síncrona y sin cola.** Se llama en handlers de
  IPC concurrentes y al cerrar la ventana. No cambiar a asíncrono sin revisar
  el orden de `window-all-closed`.
- **`sanitizeCfgPatch()` es la frontera de seguridad del renderer.** Descarta
  todo campo que no esté en `CFG_WRITABLE` y todo valor fuera de las
  enumeraciones admitidas. Los objetos complejos (`allowlist`, `customRules`,
  `permissions`, `extraSessions`, `aiConfig`, `proxy*`) **no** están en la tabla a
  propósito: se modifican por handlers dedicados que validan su entrada.
- **`rotateUA` no está en `CFG_WRITABLE` a propósito.** El renderer lo manda en
  su patch y hoy se descarta en silencio. La rotación de UA está desactivada
  porque Google OAuth solo funciona con el UA nativo de Electron. Cuando se
  implemente hay que hacer **las dos** cosas: agregarlo a la tabla **y** hacer
  que el UA se aplique de verdad (`rotateIdentity()` sigue siendo un stub).
- **`readUaLabels()` lee `src/renderer.html` parseando el source con un regex**
  para extraer las claves de `UA_LABELS`. Es frágil a propósito: si alguien
  reformatea ese objeto en el renderer, la lista de UA admitidas se vacía en
  silencio y el `<select>` de User-Agent deja de poder guardar valores. Está
  anotado aquí porque es una dependencia inversa (proceso principal → renderer)
  que no se ve al leer el código.

## Trampas

### `isPathInside()` es código muerto

Declarada, **cero llamadas** en toda la aplicación (verificado sobre el
`main.js` original, 5162 líneas). Se conserva para que el commit de extracción
fuera un movimiento puro; su borrado queda para después.

La incertidumbre a futuro es real: por el nombre y el comentario, alguien
asumirá que es la protección de rutas que cubre `resolveSafePath()`. **No lo
es.** Las rutas que el usuario ya guardó (descargas, documentos) se abren sin
pasar por ninguna comprobación de contención. Si alguna vez se necesita
confinar una ruta arbitraria, hay que implementarla y conectarla de verdad.

### `strictDomainIsolationVersion` es una migración silenciosa

`loadCfg()` sube la versión a 2 y **reescribe `CFG` en disco** en mitad de la
carga, sin avisar. Si el archivo está corrupto, el `catch {}` se traga el error
y la app arranca con los defaults, como si fuera la primera vez. No hay copia
de seguridad de `cfg.json`.

### `gpuAcceleration` se normaliza a `false`

`if (CFG.gpuAcceleration !== true) CFG.gpuAcceleration = false;` — cualquier
valor distinto de `true` se convierte en `false`, no se conserva. Si algún día
se admite un tercer estado (por ejemplo `'auto'`), esta línea lo destruye.