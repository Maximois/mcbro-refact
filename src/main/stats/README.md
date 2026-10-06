# src/main/stats/

Contadores del navegador: qué se pidió, qué se bloqueó, y las métricas de CPU/RAM
del proceso. Salió de `main.js` en la fase 1.5 sin cambiar su comportamiento.

```
config ──> tracker <── media-detect
   │           │              │
   └───────────┴──────────────┴──> runtime
               │
               └──> navigation/domains
               └──> modules/adblocker/main
               └──> process-metrics (sólo comparte runtime)
```

`media-detect` → `tracker` es la única dirección entre los dos. `tracker` no sabe
nada de `media-detect`, y por eso `reset-stats` puede vaciar el catálogo de medios
sin que el filtro tenga que enterarse del IPC.

## Archivos

| Archivo | Qué es dueño de |
|---|---|
| `tracker.js` | `STATS`, `MEDIA_URLS`, `blockedHostsByTab`, la clasificación de requests y sus contadores. Registra `get-stats`, `reset-stats`, `get-media` y `get-blocked-hosts`. |
| `media-detect.js` | `checkMedia()` y las tres regex de detección. Registra ningún IPC. |
| `process-metrics.js` | El muestreador de CPU/RAM y los IPC `get-processes` y `get-sysinfo`. |

## INVARIANTE — `STATS` se reasigna, igual que `CFG`

`reset-stats` y `sessions:clear-data` hacen `STATS = { ...ceros... }`: **reasignan**,
no mutan.

Por eso fuera del módulo **no** se importa `STATS` directamente:

```js
const { STATS } = require('./tracker');   // MAL: queda congelado en el primer
const t = require('./tracker');           //      objeto y sigue contando ahí
t.getStats().detectedAds++;               // y no en el nuevo.
```

Usa `getStats()` (devuelve el objeto vivo) o los accesores: `zeroStats()`,
`addCookiesBlocked()`, `bumpDetectedMedia()`, `clearBlockedHosts()`.

Es el mismo problema que `CFG` (ver `docs/RESTRUCTURACION.md` §2.1) y que
`bookmarksStore.items` / `historyStore.items`. Mismo patrón, misma trampa.

### Los dos "reset" no son el mismo reset

- `resetStats()` — lo usa `reset-stats`. Pone `STATS` a cero **y vacia `MEDIA_URLS`**.
- `zeroStats()` — lo usan `sessions:clear-data` y `history:clear`. Pone `STATS` a
  cero **pero conserva el catálogo de medios**.

Limpiar la sesión no borra lo que se detectó; resetear las estadísticas sí. No
unificarlos.

### `MEDIA_URLS` se muta in situ

A diferencia de los arrays de `src/main/data/`, aquí se hace `push` / `splice` /
`length = 0`: nunca se reasigna. Por eso `getMediaUrls()` puede devolver la
referencia sin riesgo. Tope de 500 entradas.

`blockedHostsByTab` tiene dos topes sueltos: 500 hosts por pestaña y 200
pestañas rastreadas a la vez. El segundo borra la más antigua **por orden de
insección del Map**, no por uso.

## Trampas

### `detected*` y `blocked*` no son la misma cifra

`detected*` cuenta lo que el motor de adblock detectó y bloqueó. `blocked*` cuenta
el total de bloqueos de esa categoría, venga de donde venga.

Antes se condicionaba `detected*` a que el clasificador **no** coincidiera con el
tipo forzado, o sea se contaban las *discrepancias* en vez de las detecciones, y
un bloqueo bien clasificado no sumaba nada. Se dejó tal cual al mover; ver
`recordBlockedRequest()`.

### `{ ...STATS, uptime }` está escrito 6 veces

Repetido literal en `recordBlockedRequest`, `scheduleStatsUpdate`,
`recordObservedRequest`, `get-stats` y en los dos `emit` de `checkMedia`. Se dejó
así. Si algún día se extrae a `statsSnapshot()`, que sea en un commit con su propia
justificación, no de paso.

### El IPC se registra al importar el módulo

Los handlers se registran al hacer `require()`, no dentro de `app.whenReady()`,
igual que los de `permissions/`. Si nadie requiere `tracker.js`, `get-stats` no
existe.

### No registrar dos veces el mismo canal

**Esto ya rompió el arranque dos veces durante la extracción.** Electron lanza si
dos `ipcMain.handle` registran el mismo canal:

- `get-blocked-hosts` venía ya dentro del bloque copiado, justo debajo de
  `trackBlockedHost`, y se añadió otra vez en la sección de IPC de este archivo.
- `get-media` venía dentro del bloque de métricas, por lo que acabó también en
  `process-metrics.js`, donde además `MEDIA_URLS` no existe.

`test/ipc-channels.test.js` vigila las dos cosas: que no haya canales repetidos y
que cada canal de stats esté en el módulo que es su dueño.

### `startProcessMetricsSampler()` se llama dos veces. No es un bug

Una vez en `whenReady` y otra en `app.on('activate')`, que es lo que corre cuando en
macOS se cierran todas las ventanas y luego se abre una nueva: la ventana se recrea
con `createWindow()` y su sampler se había parado en `window-all-closed`. El
`if (processMetricsTimer) return;` del arranque lo hace idempotente.

**No borrar la segunda llamada:** sin ella el sampler no vuelve tras reabrir en macOS.

### Las unidades de memoria

`metric.memory.workingSetSize` viene en **kilobytes**. El fallback divide por 1024
(KB → MB). Dividir por 1048576 es la conversión correcta de bytes a MB, pero aquí
mostraba ~1000× menos RAM. En Windows, `tasklist.exe` ya entrega MB y se usa ese
valor sin dividir.

### Por qué hay un solo muestreador

`app.getAppMetrics()` promedia el uso de CPU desde la última vez que *cualquier*
código del proceso principal la llamó, y esa llamada reinicia la ventana de
medición para todos los procesos a la vez (lo documenta Electron).

Antes había 3 timers independientes en el renderer (barra de estado cada 3 s,
sidebar cada 2 s, ajustes cada 2 s) llamando a esto sin coordinarse: cada uno le
cortaba la ventana de medición al anterior, dando porcentajes de CPU que saltaban
sin sentido. Ahora hay un muestreador con cadencia fija y todo el mundo lee el
mismo snapshot cacheado.

El comentario *"única llamada a `app.getAppMetrics()` de toda la app"*, dentro de
`sampleProcessMetrics()`, es **load-bearing**. Si alguien más la hace, esto se rompe.

## Lo que NO se corrigió (bugs preexistentes, documentados a propósito)

### `STREAM_SCAN_SCRIPT` genera JS inválido

`main.js` inyecta este script en la página con `executeJavaScript`. Dentro de una
plantilla literal, `\d` se consume y queda `d`, y `\/\/` queda `//`. Resultado,
una vez evaluada la plantilla:

```js
/^https?://(x.com|twitter.com)/[^/]+/status/d+/video//i   // SyntaxError
```

Está en el original desde `b8e0704` (verificado), así que la extracción no lo
tocó — `isMedia` es byte a byte idéntico a la base. Rompe el escaneo de streams en
silencio, probablemente porque la llamada va envuelta en `try/catch`.

Lo mismo pasó con las tres regex de media de esa plantilla (`MEDIA_RE`, `SKIP_EXT`),
que usan barras dobles a propósito. `STREAM_SCAN_SCRIPT` es la única copia del
patrón que viaja al proceso de la página: **no puede compartir la variable con
`media-detect.js`**, de ahí que el mismo regex esté escrito dos veces.

Arreglarlo es un commit aparte, con su propia prueba.