# Plan de reestructuración: `main.js` y `src/renderer.html`

**Estado: plan aprobado para ejecutar. Referencia de medidas: 2026-10-02, rama `main`, commit base `cfa49b5`.**

Este documento es el contrato de la reestructuración. Define qué se mueve, en qué orden, qué
NO se toca, y qué rarezas del código actual se han detectado por el camino. Las trampas
encontradas viven aquí y en el `README.md` de cada módulo nuevo; los bugs **no se corrigen**
durante el movimiento (ver "Regla de oro"), quedan documentados para una fase posterior.

---

## 0. Mediciones reales (por qué este plan)

Las cifras que circulaban inicialmente estaban mal. Verificadas sobre el archivo:

| Archivo | Líneas | Notas |
| --- | --- | --- |
| `main.js` | **5162** | 193 declaraciones de nivel superior, 102 canales IPC, 2 listeners de `web-contents-created` |
| `src/renderer.html` | **8371** | ~6000 de JS inline en 3 bloques `<script>` + HTML/CSS de la UI anfitriona |
| `modules/ai-assistant/renderer.js` | ~3600 | ya es un módulo |
| `modules/document-editor/renderer.js` | ~1300 | ya es un módulo |
| `lib/permissions.js` | ~185 | ya es una librería testeada |

`main.js` es el punto crítico: es entrypoint de `package.json`, concentra ciclo de vida,
ventana, sesiones, políticas de red, permisos, descargas, IPC y orquestación de módulos.

## 1. Regla de oro

**Mover en crudo. No cambiar lógica.** Cada commit:

1. copia el bloque tal cual al módulo nuevo (sin reescribir, sin "limpiar", sin renombrar);
2. ajusta únicamente lo que exige el movimiento: `require`, `module.exports`, y el nombre de
   la ruta;
3. ejecuta `node --check` sobre cada archivo nuevo y `npm test`;
4. anota en el `README.md` del módulo cualquier rareza hallada.

Los bugs se documentan, no se arreglan. Arreglarlos mezclados con el movimiento haría
irrevisible el diff, que es la única red de seguridad de esta fase.

Excepción permitida: **el código muerto que se detecte se documenta, no se borra**, para que
el borrado sea un commit posterior y reversible por separado.

## 2. Restricciones de diseño que condicionan todo

Estos cuatro hechos del código actual determinan cómo se pueden partir los módulos:

### 2.1 `CFG` se reasigna, pero solo una vez

`main.js:1449` hace `CFG = { ...CFG, ...saved }` — crea un **objeto nuevo**. Es la única
reasignación de todo el archivo (verificado). Ocurre dentro de `loadCfg()`, que se invoca en
`main.js:1469`, es decir **durante la carga del propio módulo de configuración**, antes de
`app.whenReady()`.

Consecuencia para el diseño: si `src/main/config/index.js` ejecuta `loadCfg()` al final de su
cuerpo, cuando cualquier otro módulo haga `require('../config')` la referencia ya es la buena.
**Destructurar `CFG` una vez al inicio de cada módulo es seguro.** Es la técnica que se usará.

Lo que **no** es seguro, y por eso queda prohibido en `src/main/README.md`:

```js
const { CFG } = require('./config');   // OK: CFG ya está cargado al require
const { emit } = require('./runtime'); // MAL: emit se asigna en whenReady, sería undefined
```

### 2.2 `mainWin` se asigna una vez, tarde

`mainWin = new BrowserWindow(...)` en `main.js:428`, dentro de `createWindow()`. Cualquier
módulo que lo destructuren al require se quedaría con `null` para siempre.

**Regla: los módulos reciben `getMainWin()` (una función), nunca `mainWin`.** No es una
convención nueva: es exactamente el patrón que el proyecto ya usa para sus módulos existentes
(`m.setup({ cfg: CFG, getMainWin: () => mainWin })` en `main.js:5108` y `5129`).

### 2.3 `ACTIONS` se muta, y su orden importa

```js
const ACTIONS = { adblockToggle: null, emit: null };  // main.js:1131
ACTIONS.emit = (ch, ...args) => {...};                 // main.js:4829 (whenReady)
ACTIONS.adblockToggle = ret.toggleBlocking;            // main.js:5144 (cuando adblocker carga)
```

`ACTIONS` es un objeto mutable que se pasa **por referencia**. Se puede destructurar el objeto,
**nunca sus propiedades**. Además `emit` se define en `whenReady` pero `adblockToggle` justo
después de que el módulo adblocker cargue: si un handler de `web-contents-created` (registrado
antes de `whenReady`) intentara leer `ACTIONS.emit`, lo encontraría `null`. Es una fragilidad
latente que se documenta, no se toca.

### 2.4 `sess` significa tres cosas distintas

| Línea | Forma | Ámbito |
| --- | --- | --- |
| `main.js:2899` | `const sess = () => session.fromPartition('persist:mc')` | módulo (función) |
| `main.js:425` | `const sess = session.fromPartition('persist:mc')` | local de `createWindow` |
| `main.js:4818` | `const sess = session.fromPartition('persist:mc')` | local de `whenReady` |

Al extraer, la función de módulo y la sesión de `whenReady` van a archivos distintos. En el
módulo se renombrará a `mainSession()` **solo en el punto de definición y en sus 35 usos**, sin
cambiar semántica; queda anotado como cambio cosmético para que el diff siga siendo legible.

### 2.5 `app.setPath('userData')` debe seguir siendo lo primero

**Esta regla se incumplio y rompio la app.** El plan lo decia y el arreglo que
proponia (`src/main/bootstrap.js` como primer require) es el paso 28, que aun no
existe: asi que nadie lo aplico y nadie lo noto.

Como queda hoy, `main.js` fija la carpeta de datos en las lineas 27-28, justo
despues de los builtins y **antes del primer require de proyecto**:

```
3-7    require de electron, path, fs, child_process, crypto
27-28  DATA_DIR + app.setPath('userData', ...)
31+    require('./modules/...'), require('./src/main/config'), data/bookmarks, data/history...
```

El orden importa porque `config`, `data/bookmarks` y `data/history` calculan su
ruta **al cargarse**:

```js
const CFG_PATH = path.join(app.getPath('userData'), 'cfg.json');
```

Con el orden viejo, esos tres se requerian en las lineas 40-46 y el `setPath` no
llegaba hasta la 76: leian `userData` antes de que nadie lo cambiara y
resolvian a la carpeta POR DEFECTO. En el baseline (`b8e0704`) no pasaba, porque
`CFG_PATH` se calculaba en `main.js:1420`, muy por debajo del `setPath` de la 32.
Lo introdujo el paso 1 (`470ee0b`, extraer configuracion).

**Que se perdia, medido en disco:**

| archivo | carpeta por defecto | `mc-browser-v2-dev` (la correcta) |
| --- | --- | --- |
| `cfg.json` | 2.300 B, casi todo por defecto | 3.869 B, 2 sesiones, DoH, allowlist de 21 dominios |
| `history.json` | 346 B | 35.973 B |
| `bookmarks.json` | no existia | 326 B |

La app no fallaba: arrancaba, abria la ventana y muestras la configuracion
vacia. El unico rastro era un `history.json` de 346 bytes que la propia app
habia creado en la carpeta equivocada durante las pruebas de humo.

**Dos comprobaciones, porque una sola no basta:**

- `test/data-paths.test.js` mira el ORDEN del fuente: el `setPath` tiene que ir
  antes del primer `require('./`. Verificado con `git stash`: el test dice
  "setPath en la linea 76 y el primer require de proyecto en la 8".
- `tools/boot-smoke.js` mira en EJECUCION. `main.js` imprime una linea `[DATA]`
  con `userData` y las tres rutas ya resueltas, y el smoke falla si alguna no cae
  dentro de la carpeta de la build. Verificado emulando el bug: el smoke nombra
  las tres rutas fuera de sitio y sale con codigo 1.

El test de fuente es el que evita la regresión; el del smoke es el que confirma
que la app real abre donde debe. Un test que solo mira codigo no dice si la app
funciona, y un smoke que solo arranca no dice si lee bien.

### 2.6 Cada commit dice cómo estaba antes y cómo queda

Petición del usuario, y la razón es que una extracción se rompe de formas que
el smoke no ve: si algo falla dentro de tres meses, `git log` es lo primero que
se mira, y sin el antes no hay forma de saber qué se movió.

Un commit de extracción lleva **cinco cosas**, en este orden:

1. **Qué salió de `main.js`, con las líneas exactas.** `3618 -> 3494`, no
   "se extrajo el bloque".
2. **Qué NO salió, y por qué.** Es la parte que más importa: lo que parece
   que parece que debería salir y se queda tiene una razón, y esa razón se
   escribe mientras es fresca.
3. **El antes y el después, en una tabla o una lista corta.** Función, módulo,
   canal. Sin esto no se puede comparar un `git show` con lo que se lee ahora.
4. **Qué invariantes se fijaron con test**, y que se verificó que muerden
   mutando el código a propósito.
5. **Los números**: tests, pass, fail, skipped, y el smoke.

Con eso, un bug futuro se responde mirando dos commits: el del antes y el del
después.

## 3. Estructura destino

```
main.js                       entrypoint delgado: fija userData, arranca bootstrap
src/main/
  README.md                   índice, mapa de responsabilidades, invariantes y trampas
  bootstrap.js                ciclo de vida, GPU, protocolos de SO, argv, whenReady
  runtime.js                  contexto compartido (documenta las reglas 2.1-2.4)
  config/index.js             CFG, loadCfg, saveCfg, CFG_WRITABLE, sanitizeCfgPatch, resolveSafePath
  data/bookmarks.js           BOOKMARKS_PATH, BOOKMARKS, load/save
  data/history.js             HISTORY_PATH, HISTORY, load/save
  permissions/adapters.js     wrappers que atan lib/permissions a CFG
  permissions/notifications.js  diálogo de permisos de notificaciones
  permissions/handlers.js     setupSessionPermissionHandlers + IPC de permisos
  navigation/domains.js       AUTH_DOMAINS, isAuthDomain, baseNavigationDomain, UA
  navigation/explicit-nav.js  máquina de estados de userNavWebContents
  navigation/transitions.js   allowNavigationTransition y predicados de salto
  net/request-guard.js       createRequestGuard (onBeforeRequest), reglas globales de request
  net/doh.js                  DOH_SERVERS, applyDoH, resolve-doh
  net/cookie-guard.js         cookie guard vía CDP
  net/headers.js              onBeforeSendHeaders / onHeadersReceived / cookies.on('changed')
  net/proxy.js                proxy:set
  sessions/partitions.js      WEBCHAT/WHATSAPP/extra + predicados de sesión
  sessions/extra.js          setupExtraSession (paridad total con la principal)
  sessions/webchat.js        setupWebchatSession (allow-all, sin reglas de request)
  sessions/whatsapp.js        setupWhatsappSession (notifications + Client Hints)
  sessions/ipc.js             sessions:*, clear-*, paleta de colores
                           (export/import se quedan en main.js: necesitan DATA_DIR)
  stats/tracker.js            STATS, classifyRequest, record*, blockedHostsByTab
  stats/media-detect.js       checkMedia
  stats/process-metrics.js    muestreador de CPU/RAM
  downloads/registry.js       dlRegistry, PauseSignal, pause/resume/cancel
  downloads/fetch.js          sessionFetch, chromiumFetch, cabeceras de medios
  downloads/hls.js             manifiesto, variantes, segmentos, AES-128, reanudacion
  downloads/file.js           dl-file
  downloads/native.js         will-download, blob/data, dl-native-*, abrir archivos (hecho)
  downloads/ffmpeg.js         búsqueda, instalación portable, remux/transcode
  tools/ytdlp.js              ytdlp-* + export de cookies Netscape
  streams/capture.js          referers de HLS, STREAM_SCAN_SCRIPT, streams:*
  memory/store.js             memory:* y reminders:* sobre JSON
  perchance/panel.js          setupPerchancePanel + perchance:* (contrato congelado)
  ipc/window.js               win-*, webview:destroy, nav-intent, open-external
  external.js                 argv -> URL / documento
  modules-loader.js           registro de AI, WA, doc-editor y adblocker + fallbacks
src/renderer/                 (Fase 2, aún no existe)
```

Cada carpeta lleva su `README.md` con: responsabilidad, qué exporta, qué **no** debe hacer,
y las trampas del código que movió.

### 3.1 `package.json` hay que tocarlo

`build.files` hoy lista `main.js`, `lib/**/*`, `perchance/**/*`, `src/**/*`… `src/**/*` ya
cubre `src/main/`, pero **antes de que Electron arranque desde el repo de desarrollo no hace
falta nada**: `main.js` sigue siendo el entrypoint y usa rutas relativas. Labuild de
instalador ya incluye `src/**/*`, así que los módulos nuevos entran solos. **Se verifica en la
fase de empaquetado, no antes** (`npm run dist` requiere autorización expresa).

## 4. Orden de extracción

Orden **hoja-primero**: cada módulo se extrae cuando sus dependencias ya son módulos. Así
cada commit es un cambio mecánico verificable.

| # | Módulo | Depende de | Commit |
| --- | --- | --- | --- |
| 0 | baseline | — | `Checkpoint: WIP previo a la reestructuración` |
| 1 | `config/index.js` | — | `Extraer configuracion a src/main/config` |
| 2 | `data/bookmarks.js`, `data/history.js` | — | `Extraer persistencia de marcadores e historial` |
| 3 | `permissions/adapters.js` | config | `Extraer adaptadores de permisos ligados a CFG` |
| 4 | `permissions/notifications.js` | config | `Extraer dialogo de permisos de notificaciones` |
| 5 | `navigation/domains.js` | adblocker(main) | `Extraer catalogo de dominios y excepciones` |
| 6 | `navigation/explicit-nav.js` | — | `Extraer estado de navegacion explicita` |
| 7 | `navigation/transitions.js` | 5, 6, adblocker | `Extraer reglas de transicion de navegacion` |
| 8 | `stats/*` | config | `Extraer estadisticas y muestreo de procesos` |
| 9 | `net/doh.js` | config | `Extraer DoH` |
| 10 | `net/cookie-guard.js` | 3, config | `Extraer cookie guard por CDP` |
| 11 | `net/headers.js` | 5, 7, 10, config | `Extraer interception de cabeceras de red` |
| 12 | `net/proxy.js` | config | `Extraer configuracion de proxy` |
| 13 | `sessions/partitions.js` | config, 10 | `Extraer particiones de sesion y sus predicados` |
| 13b | `net/request-guard.js` | 3, 5, 7, 8 | `Sacar request-guard antes que sessions` |
| 13c | `downloads/native.js` | 13b | `Extraer descargas nativas` |
| 13d | `sessions/extra.js`, `webchat.js`, `whatsapp.js` | 13, 13b, 13c | `Extraer el setup de cada sesion aislada` |
| 14 | `sessions/ipc.js` | 2, 13 | `Extraer IPC de sesiones y limpieza de datos` | HEcho |
| 14b | `sessions/ipc.js` (export/import) | 14, 28 | `Mover export/import cuando DATA_DIR tenga modulo dueno` | Pendiente |
| 15 | `downloads/registry.js`, `downloads/fetch.js` | config | `Extraer registro y transporte de descargas` | Hecho |
| 16 | `downloads/hls.js` | 15, lib/hls-resume | `Extraer descarga HLS` | Hecho |
| 17 | `downloads/file.js` | 15 | `Extraer descarga de archivo directo` | Hecho |
| 18 | `downloads/ffmpeg.js` | — | `Extraer FFmpeg portable` | Hecho |
| 19 | `tools/ytdlp.js` | config, 2 | `Extraer yt-dlp` | Hecho |
| 20 | `streams/capture.js` | config | `Extraer captura HLS de streams` | Hecho |
| 21 | `memory/store.js` | — | `Extraer memoria y recordatorios` | Hecho |
| 22 | `windows/context-menu.js` | — | `Extraer menu contextual` | Hecho |
| 23 | `windows/create.js` | 4, config | `Extraer creacion de ventana` | Hecho |
| 24 | `windows/webcontents.js` | 6, 7, 8, 9, 13, 20, 22 | `Extraer listeners de web-contents-created` | Hecho |
| 25 | `perchance/panel.js` | 5, 13 | `Extraer panel de Perchance` | Hecho |
| 26 | `ipc/window.js`, `external.js` | 6 | `Extraer IPC de ventana y argv` | Hecho |
| 27 | `modules-loader.js` | todo | `Extraer registro de modulos` | Hecho |
| 28 | `bootstrap.js` + `main.js` | todo | `Convertir main.js en entrypoint delgado` |
| 29 | docs | — | `Documentar src/main y actualizar la guia` |

### 4.1 Verificación por commit

```bash
node --check src/main/<archivo>.js     # sintaxis de cada archivo nuevo
npm test                               # suite completa (node --test)
git diff --stat                        # el diff debe ser soloAdds/Delete, no mezcla
```

Cada commit debe dejar `main.js` en un estado **arrancable**. Si un commit intermediate no
arranca, se deshace (`git reset --hard HEAD~1`) y se rehace el corte de otra manera.

## 5. Trampas y bugs hallados durante el análisis

Documentadas aquí. **No se corrigen en esta fase.** Cada una lleva el módulo donde vive para
poder localizarla después.

### 5.1 Código muerto (3 casos confirmados)

| Símbolo | Ubicación actual | Nota |
| --- | --- | --- |
| `isPerchanceRuntimeHost` | `main.js:512` | Declarada, **cero llamadas**. Su gemela `isPerchanceHost` sí se usa (4 sitios). Sospecha: quedó de una versión anterior del panel. |
| `isPathInside` | `main.js:1726` | Declarada, **cero llamadas**. Con `resolveSafePath` ya cubre el caso para el que parecía existir. Su comentario dice "confina una ruta arbitraria a baseDir", pero nunca se usó. |
| `normalizeGlobalBlockPattern` | `main.js:160` | Wrapper de `Permissions.normalizeGlobalBlockPattern` (que sí existe y se exporta). **Cero llamadas al wrapper**; el código que lo necesita ya llama a `lib/permissions` directamente. |

Verificado por conteo de identificadores sobre el archivo completo, no por lectura visual.

### 5.2 Doble listener de `web-contents-created`

`app.on('web-contents-created', ...)` se registra **dos veces**:

- `main.js:3921` — el handler grande: `will-redirect`, fullscreen, `did-stop-loading`, popups.
- `main.js:4716` — diagnóstico `MC_PCH_DIAG` + `updateCookieGuard` para webviews.

Electron admite multiples listeners, así que **no es un bug hoy**. Pero es una trampa: el orden
de ejecución es el de registro, y quien agregue un tercer listener tiene que saber que el
guardia de cookies corre *después* del handler grande. Al extraer, ambos van a
`windows/webcontents.js` y se documenta el orden.

### 5.3 Los handlers de `memory:*` y `reminders:*` viven dentro de `whenReady`

`main.js:4998-5103` (11 canales IPC) está **anidado dentro del `.then()` de `app.whenReady()`**,
a diferencia de los otros 91 canales que se registran a nivel de módulo. Consecuencias:

- no se registran si `gotTheLock` es falso (`main.js:4742` hace `return` temprano);
- dependen de 4 helpers locales (`ensureDir`, `loadJson`, `saveJson`, `genId`) que no salen del
  bloque;
- mezclan persistencia de datos con arranque de aplicación.

Es la extracción más fácil y más limpia de la lista (no dependen de casi nada). Al moverlas
fuera, **estos canales empiezan a registrarse también en el segundo proceso**, que es el
comportamiento correcto, pero es un cambio observable y queda anotado en el README del módulo.

### 5.4 `startProcessMetricsSampler()` se llama dos veces

- `main.js:4827`, dentro de `whenReady`.
- `main.js:5153`, dentro de `app.on('activate')` cuando no queda ninguna ventana.

El `activate` cubre recrear la ventana en macOS. Pero en el camino de `whenReady` solo se llama
una vez, y en `app.on('window-all-closed')` (`main.js:5159`) se llama `stopProcessMetricsSampler()`.
Si en macOS se cierra la última ventana y luego se reactivan las Exploradoras, el temporizador
se detiene y se reinicia. Correcto. Se documenta para que nadie lo lea como duplicación.

### 5.5 `ACTIONS.emit` no existe antes de `whenReady`

`ACTIONS.emit` se asigna en `main.js:4829`, dentro de `whenReady`. Los listeners de
`web-contents-created` se registran en `main.js:3921` y `4716`, **antes**. Cualquiera de esos
listeners que intente emitir un evento al renderer antes de `whenReady` fallaría en silencio
por el `try {} catch {}` de `emit`. Hoy ninguno lo hace. Queda como invariante en
`src/main/README.md`.

### 5.6 `resolveCtxCssPoint` y el DIP/CSS de Electron

`main.js:3762` documenta que las coordenadas del menú contextual de Electron llegan en **DIP**
mientras `elementFromPoint()` usa **píxeles CSS**. El módulo resuelve con la posición exacta
capturada por un listener `contextmenu` inyectado en la página, y cae a una escala empírica
(ancho de ventana DIP / viewport CSS) si esa captura no existe. El fallback empírico es
frágil ante cambios de zoom del SO; queda anotado, no se toca.

### 5.7 La partición de Perchance tiene documento congelado

`docs/PERCHANCE-ARCHITECTURE.md` declara congelado el panel de Perchance. El bloque
`main.js:496-949` (UA de Perchance + `setupPerchancePanel` + 2 canales IPC) se mueve a
`src/main/perchance/panel.js` **sin cambiar una línea de lógica ni de contrato**, y su README
remite al documento congelado. Cualquier cambio de comportamiento requiere autorización
expresa del usuario.

### 5.8 `os` y `execFile` importados pero de uso mínimo

`main.js:6` importa `os` (9 usos) y `main.js:7` importa `spawn, execFile, execFileSync`
(`execFileSync` se usa en el registro de protocolos; los otros dos, en descargas y yt-dlp). Al
repartir los módulos, cada uno importa solo lo que usa. Es un cambio cosmético
inevitable del movimiento, no una limpieza: si un módulo deja de usar algo, se **anota**.

### 5.9 La tabla del paso 10 subestimaba sus dependencias

La fila 10 decía `net/cookie-guard.js | 3, config`. Al extraerlo resultó que
también necesita **`navigation/domains`** (el `isAuthDomain` de `applyCookiePolicy`)
y, sobre todo, `isMainBrowsingSession` / `isExtraSessionWebContents`, que son del
**paso 13** (`sessions/partitions.js`).

Importarlos habría creado un ciclo: `main.js` declara esas funciones *después* del
`require` de `cookie-guard.js`. La solución fue invertir la dependencia —
`refreshCookieGuards(esAplicable)` recibe el filtro, y `main.js` le pasa un helper
de tres líneas (`esWebviewProtegido`) que ya cubre exactamente la misma condición.

La fila queda anotada así: `10 | net/cookie-guard.js | 3, 5, config (+13 por
inyección) | Extraer cookie guard por CDP`. El paso 13 debe comprobar que ese helper
deje de existir cuando mueva los predicados; si sobrevive, es que quedó un filtro
duplicado.

### 5.10 Las rutas que salen de `src/main/` llevan tres niveles

Desde `src/main/net/`, `../config` y `../navigation/domains` están a uno, pero
`lib/permissions` está en la raíz del repo: `../../../lib/permissions`. Con dos
niveles el require resuelve a `src/lib/permissions` y revienta al arrancar, sin
que `node --check` lo note (no valida los requires).

Lo detecta `tools`-style con un chequeo de rutas relativas que resuelve también
`.js` e `index.js`; `test/net-cookie-guard.test.js` fija la ruta buena.

### 5.11 La tabla del paso 11 también subestimaba sus dependencias

La fila 11 decía `net/headers.js | 5, 7, 10, config`. En realidad el bloque
depende de **`streams/capture.js`** (el paso 21): `findHlsPlayerEntry`,
`findStreamEntryReferer`, `streamEntryReferers` y `streamHlsCaptureEnabled`.

Se resolvió como en el paso 10, por inversión de dependencia:
`installHeaderInterceptors(sess, deps)` recibe los tres helpers. Los pasos 10 y 11
comparten el mismo patrón, así que el paso 21 debe acordarse de que **`deps`
desaparece**, igual que hizo el 13 con `esWebviewProtegido`.

Dos detalles que no son negociables mientras `deps` exista:

- El flag se pasa como **getter** (`() => streamHlsCaptureEnabled`). Pasado por
  valor se congelaría en `false` al registrar los listeners y la captura HLS no
  ocurriría nunca.
- `findStreamEntryReferer` + `streamEntryReferers.delete(...)` se fusionaron en
  `consumeStreamEntryReferer()`. El borrado es parte del consumo; separado, un
  segundo request del mismo token reutilizaría el referer.

La fila queda: `11 | net/headers.js | 5, 7, 10, config (+21 por inyección)`.

Además, `isPerchanceHost` se movió a `navigation/domains.js` en su propio commit
(`804a537`), porque sin eso headers tendría que importar de un módulo que no
existía. `isPerchanceRuntimeHost`, su gemela muerta, se quedó en `main.js`.

### 5.12 El paso 12 llegó con un bug de fábrica

La fila decía `net/proxy.js | config`, y es cierto: solo usa `CFG` y `saveCfg`.
Lo que la tabla no decía es que el bloque traía **cuatro copias de la misma
llamada a `setProxy()`**, una por sesión, idénticas salvo el destino y la
etiqueta del log. Extracción mecánica las habría movido tal cual, y
`main.js` habría perdido 6 líneas de código repetido sin ganar nada.

Eso viola una regla de este plan: lo que se mueve es código, pero cada
duplicación que aparece en la zona movida se colapsa **en su propio commit**,
como se hizo con `isPerchanceHost`. La razón es que la duplicación ya existía y
por tanto no es un cambio de comportamiento, mientras que dejarla en el módulo
nuevo la convierte en deuda que nadie va a leer de nuevo.

Quedó en `applyProxyFromCfg(sess, tag)`. La validación no se tocó.

Un detalle que **no** se unificó: la sesión principal espera `setProxy()` sin
`.catch()` para que el error llegue al renderer por el IPC, y los paneles
llevan `.catch(() => {})` para que un fallo suyo no tumbe la app. Es
intencionado.

## 5.13 El smoke mintió una vez, y por eso ahora lee el log

Hay un aviso que aplica a **todos** los pasos que quedan, no solo a este.

`tools/boot-smoke.js` comprobaba que `renderer.html` apareciera en el puerto de
depuración. Ese requisito lo cumple el proceso principal **antes** de registrar
sesiones, interceptores y proxy, que van después dentro de `app.whenReady()`.
Un error en esa segunda mitad deja una ventana perfectamente operativa sobre una
app muerta.

Y como el error sale por `app.whenReady().then(...)` sin `catch`, es un
`UnhandledPromiseRejectionWarning`: **no mata el proceso**. El smoke daba verde.

Fue exactamente lo que pasó con la llamada a los interceptores de cabeceras: se
quedó sin el prefijo del módulo. `node --check` la aceptó, porque una referencia
libre no es un error de sintaxis, y los tests del módulo pasaban porque solo
comprobaban que *el módulo* tuviera los interceptores, no que `main.js` lo
llamara. Tres verificaciones en verde con la app rota.

Reglas que salen de ahí, para el resto del plan:

1. **Toda función que viene de un módulo se llama con su prefijo.** Un
   `const Headers = require(...)` sin usar es tan sospechoso como un `require`
   sin usar. Si un import no aparece qualificado en ningún sitio, es que falta
   el prefijo en la llamada.
2. **Cada test de extracción comprueba las dos puntas**: que el módulo tenga lo
   que se le movió *y* que `main.js` lo llame. Moverse sin conectar es la mitad
   del trabajo.
3. **`node --check` no valida referencias libres.** Solo sintaxis.

Y el arreglo de fondo, en `tools/boot-smoke.js`: ahora falla si en el log sale
`UnhandledPromiseRejection`, `ReferenceError`, `TypeError`, `SyntaxError` o
`MODULE_NOT_FOUND`. Los `.catch(() => {})` que ya tenía el código no dan falso
positivo, porque un `throw` de una promesa manejada no se imprime.

Comprobado reintroduciendo el bug a propósito: el smoke pasa a `exit 1` y nombra
la línea. Un verde que no puede volver a ser verde por lo mismo no vale como
verde.

### 5.14 Las inyecciones temporales ya se pueden cobrar

Los pasos 10 y 12 recibían cosas por parámetro: era una deuda con fecha de
caducidad anotada. `sessions/partitions.js` (paso 13) la paga:

| Módulo | Antes | Ahora |
| --- | --- | --- |
| `net/cookie-guard.js` | `refreshCookieGuards(esAplicable)` | `refreshCookieGuards()` |
| `net/proxy.js` | `setProxy(settings, { webchat, whatsapp })` | `setProxy(settings)` |

Queda una sola: `Headers.installHeaderInterceptors(sess, deps)`, pendiente del
paso 21.

**Criterio para lo que queda:** si un módulo necesita algo de un módulo que
todavía no existe, la inyección lleva comentario de temporal y el número de paso
que la resuelve. Si no hay paso que la resuelva, no es una inyección: es un error
de orden.

### 5.15 Dos cosas que parecían Bugs y no lo eran

`'persist:mc'` se dejó escrito a mano. Se puede unificar en `MAIN_PARTITION`,
pero son más de diez referencias y meterse con eso en el commit que mueve el
módulo mezcla dos cambios. Queda para su propio commit, con su test de paridad.

El `if (CFG.proxyEnabled && CFG.proxyHost)` que envolvía a `applyProxyFromCfg()`
se quitó. Ese sí era redundante de verdad: el helper ya sale por su cuenta sin
proxy. Cuatro copias de una condición que ya se evaluaba dentro.

### 5.16 Un helper de extracción borró un `ipcMain.handle` entero

Durante el paso 13 el script que quita código de `main.js` se equivocó de
semántica: el helper que uso para las constantes y los predicados **borra** el
bloque (los reemplaza por cadena vacía), y lo reutilicé para `proxy:set`, donde
lo que hacía falta era **sustituirlo** por la versión sin particiones. El
resultado fue que `ipcMain.handle('proxy:set', ...)` desapareció de `main.js`.

Lo detectó el test de proxy, no el review. El canal había bajado de 88 a 87 y
`node --check` no dice nada.

Dos reglas que salen de ahí, igual que en 5.13:

1. **Un bloque que se mueve y se cablea no es un bloque que se borra.** Si
   cambia de forma, la operación es sustituir, y conviene que sea explícita en
   el script.
2. **El conteo de canales IPC va en cada commit**, no solo al final de la
   fase. Es la única verificación barata que detecta un handler perdido.

### 5.17 Las aserciones de ausencia van contra el código

Tres tests de este repo buscan "esto no aparece" y los tres fallaron la primera
vez, porque el nombre buscado estaba en el JSDoc del propio módulo, que explica
justamente por qué la cosa sigue así:

- `fromPartition` en `net/headers.test.js`
- `WEBCHAT_PARTITION` en `net-proxy.test.js`
- `MAIN_PARTITION` en `sessions-partitions.test.js`

La convención queda fijada: **las aserciones de ausencia se hacen contra
`codigo`**, el módulo desde el primer `*/`, nunca contra el archivo entero. Un
JSDoc explica, y explicar es lo contrario de estar ausente. Cuando un módulo
tiene buena documentación esto no es un detalle: va a pasar otra vez.

## 5.18 `sessions/setup.js` no va a existir

El plan pedía `sessions/partitions.js` **y** `sessions/setup.js`. La segunda
mitad se deshizo en un módulo por tipo de sesión. El motivo está en lo que hacen
las sesiones, que es una asimetría y no un peso:

| | reglas globales | descargas | UA / Client Hints |
| --- | --- | --- | --- |
| principal | sí | sí | no |
| extra | **sí**, paridad total | sí | no |
| WebChat | no, allow-all | no | no |
| WhatsApp | no | no | **sí** |

Una sesión extra es la principal con otro almacenamiento. WebChat y WhatsApp son
**excepciones**, no variantes: no comparten casi nada con la principal ni entre
sí. Un `setup.js` con tres funciones intercambiables habría fingido un modelo
común que no existe, y además habría inviting a "unificar" lo que no se puede.

### El criterio para partir un bloque

Mover un setup exige que **todas** sus dependencias tengan dueño. Si alguna queda
en `main.js`, hay dos caminos: inyectarla, o moverla primero. El orden elegido
fue mover primero, y por qué:

- `net/request-guard.js` es la lógica de reglas globales que comparten main y
  extra. Si se hubiera movido `setupExtraSession` antes, `sessions/extra.js` la
  habría recibido por parámetro: otra inyección temporal.
- `downloads/native.js` es `registerNativeDownloadHandler` **con su
  `nativeDlRegistry` y su `pendingNativeRetryId`**. El registro es estado que
  pertenece a la función; separarlos obligaría a inyectar el `Map` entero.

Con esas dos piezas en su sitio, `extra.js`, `webchat.js` y `whatsapp.js` nacen
sin ninguna inyección.

### Lo que rompió el orden hoja-primero

Los tres setups se escribieron primero con `imports` inventados: `Proxy`,
`RequestGuard`, `PermissionsHandlers`, `Sessions` como objetos, y
`require('../media/detect')` para el detector de medios. Todo eso pasó
`node --check` —porque un `require` de una ruta que no existe, o una
propiedad de `undefined`, solo fallan al resolver— y lo cazó
`tools/boot-smoke.js`:

```
Cannot find module '../media/detect'
Cannot read properties of undefined (reading 'WEBCHAT_PARTITION')
Cannot read properties of undefined (reading 'applyProxyFromCfg')
```

Es el mismo fallo que motivó el módulo `Proxy` en `net-headers.test.js`: un
import mal escrito no es un error de sintaxis, es un error de arranque. Por eso
`test/sessions-setups.test.js` comprueba ahora el texto de los imports, y no solo
que los símbolos estén en el archivo.

### El fallo que ningún test vio venir

Uno de esos imports iba **dentro de un `try/catch`**:

```js
try {
  const m = require('../../../modules/adblocker/main');
} catch (e) { console.error('[ADBLOCK][session]', e.message); }
```

Se escribió con dos niveles en vez de tres, y `modules/adblocker/` vive en la
raíz del repo, no en `src/`. El `catch` no relanzó: la sesión extra se quedó
**sin adblocker**, sin error visible, y `boot-smoke.js` dio verde.

El `try` es correcto y no se quita: si el módulo de ads no estuviera, la sesión
extra no debe impedir que arranquen las demás. Lo que faltaba era un test que no
dependa de que el fallo se propague. `test/sessions-setups.test.js` recorre ahora
todos los `require()` relativos de los cuatro módulos nuevos y comprueba que el
archivo existe, con la extensión resuelta como la resuelve Node.

Se comprobó reintroduciendo el bug a propósito: el test cae y nombra el módulo y
la ruta. Un verde que no puede volver a ser verde por lo mismo no vale como
verde.

### La convención de imports, resuelta antes de seguir

Los módulos extraídos se escribieron con destructuring plano
(`const { applyProxyFromCfg } = require('../net/proxy')`), que es lo que se hace
por defecto al escribir un módulo. El problema es que `main.js` va con namespace
(`Proxy.applyProxyFromCfg`) y el prefijo no es decorativo: convierte un
`undefined` silencioso en un `TypeError` con nombre, que es como se detecta un
import mal escrito.

Convertidos los cuatro, la regla queda:

- **Módulos de función**: namespace, llamadas cualificadas.
- **`config` y `runtime`**: destructuring, y está justificado. `loadCfg()` corre
  dentro de `config/index.js` al requerirlo, así que `CFG` ya viene fusionado;
  y `mainWin` se asigna tarde, así que se accede por `getMainWin()`. Esto ya
  estaba escrito en `main.js:12-17`, pero el destructuring se conserva porque
  tiene su razón.
- **`electron`**: destructuring, porque no es código nuestro.

Fijado con test, porque una convención que depende de que alguien la recuerde al
escribir el quinto módulo no es una convención.

### Un test que salió mucho más fácil de escribir de lo previsto

El plan era comprobar el comportamiento de las tres sesiones. Lo que salió fue
un test que se pasó a comprobar **el código fuente**, línea por línea: que el
orden sea permisos → proxy → adblocker → descargas, que `emit` siga vacío a
propósito, que el interceptor de WhatsApp no se colara en `net/headers.js`.

Es feo y es correcto. Estas funciones no se pueden importar en un test sin
arrancar Electron, así que no hay forma de observarlas: el código fuente es lo
único que queda. Lo que evita es que el "no tocar comportamiento" sea una
promesa; si alguien cambia el orden de las cuatro llamadas de `extra.js` creyendo
que es indiferente, el test lo dice.

El mismo criterio que los tests que cuentan call sites. `net-proxy.test.js` y
`net-request-guard.test.js` ya no cuentan solo en `main.js`, porque las llamadas
se repartieron entre `main.js` y los módulos nuevos. Contar en todas las fuentes
no es aflojar el test: es lo contrario, porque un quinto call site de
`applyProxyFromCfg` en el sitio equivocado se ve en el recuento y no en
producción.

### Lo que detectó el test y no la revisión

El orden de la cascada de `request-guard` se documentó al revés la primera vez:
se afirmó que los bypass de Google y de auth iban **después** de los permisos de
contenido. Están **antes**. El test de orden lo detectó en la primera ejecución,
porque compara índices de posición, no presencia de símbolos.

La frase correcta, que es la que el test protege: **los bloqueos ganan, los
permisos de contenido no aplican en Google ni en la cadena OAuth.**

Vale la pena dejarlo escrito porque es la clase de error que no se ve leyendo:
las dos versiones del código son igual de legibles, y solo una es la que hay.
Un test de "está el código" la habría dejado pasar; uno de orden, no.

## 6. Lo que NO se toca

- **Lógica.** Ninguna reescritura, ninguna "mejora" de algoritmo. Si algo está mal, se anota.
- **Contrato de Perchance** (`docs/PERCHANCE-ARCHITECTURE.md`, congelado).
- **Retirada de ideas** de `docs/IDEAS-FUTURAS.md` (la de adjuntar contexto al WebChat sigue
  retirada; no se restaura nada).
- **`lib/permissions.js` y `lib/navigation-guard.js`.** Ya son librerías testeadas con
  `test/permissions.test.js`. Solo se les añade lo que la extracción demuestre que falta.
- **Los módulos de `modules/`.** No se reorganizan en esta fase; `main.js` pasa a ser su
  consumidor, no su dueño.
- **Empaquetado.** Nada de `npm run dist` ni instalador sin autorización (regla 6 de
  `GUIA-PARA-COLABORADORES.md`).
- **Datos del usuario.** Ni una prueba borra particiones o `userData`.

## 7. Fase 2: `src/renderer.html`

**Estado: plan en redacción. No se ejecuta ningún commit hasta aprobación expresa del usuario.**

### 7.0 Regla de oro de la Fase 2 — va antes que cualquier diseño

Pedida por el usuario el 2026-10-06, y no es una preferencia: es la lección de la ronda
anterior, en la que se tocaron funciones sin que nadie pidiera moverlas, se perdieron
funciones y hubo que restaurarlas. Para esta fase el contrato es:

1. **Mover en crudo.** El bloque se copia carácter por carácter al archivo nuevo. Cero
   cambios de lógica, de nombres, de orden, de comentarios, de formato, de strings.
2. **Lo raro se documenta**, aquí y en el `README.md` del archivo nuevo. No se arregla,
   no se "mejora", no se renombra, no se borra código muerto dentro del commit del
   movimiento. La §1 entera aplica a esta fase.
3. **Si un bloque no se puede mover sin tocarlo, se para y se consulta.** No se
   improvisa la adaptación: se documenta el bloque, se suspende y se decide con el
   usuario qué hacer con él.
4. **Los contenidos van intocables**: prompts de IA, `LAB_TEMPLATES`, strings de UI,
   textos de confirmación, canales `mc.*`, nombres de `window.*`. Cambiar un string
   también es cambiar comportamiento.
5. **La extracción es por rango con script, no a mano.** Retipear 6000 líneas es la
   forma más segura de que algo cambie sin que se note en la revisión.

Lo anterior no sustituye a las reglas de verificación, las complementa: un movimiento
crudo se puede comprobar, un "cambio pequeño" disfrazado de movimiento no siempre.

### 7.1 Mediciones reales

Verificadas sobre el archivo (2026-10-06):

| Zona | Rango | Líneas |
| --- | --- | --- |
| `<style>` | L8–1333 | 1326 |
| HTML de la UI anfitriona | L1334–2343 | 1010 |
| **bloque `<script>` inline** | **L2344–8353** | **6010** |
| `<script src>` de `modules/*` | L8356–8369 | 14 |

Línea base medida con regex sobre el archivo (2026-10-06); es lo que debe seguir siendo
cierto en **cada** commit de la Fase 2:

| Cantidad | Valor |
| --- | --- |
| `function` + `async function` de nivel superior | **217** + **63** = **280** |
| `const` / `let` de nivel superior | 20 / 29 (49 en total) |
| IIFE | 4 (L2419, L2759, L2774, L7351) |
| `document.addEventListener('DOMContentLoaded')` | 2 (L3277, L4377) |
| Asignaciones `window.*` | 14 sobre 13 nombres distintos (6 en columna 0, 7 dentro de funciones/envoltorios, 1 dentro de un string) |
| Líneas con `mc.*` / canales `mc.on` | 169 / 29; 91 nombres `mc.*` distintos |
| Atributos inline del HTML | 210 (161 `onclick`, 35 `onchange`, 10 `onkeydown`, 4 `oninput`) |
| Handlers invocados desde `on*="..."` | 108 en el markup (los 108 definidos dentro del bloque) y **147** en total, contando los de los templates de JS |

### 7.2 Restricciones que condicionan todo (los hechos, no las preferencias)

> Los números de línea de este apartado son del archivo original: con cada paso
> bajan y algunos bloques ya viven en `src/renderer/*` (§7.4). Para cortar,
> siempre se localiza por contenido en el archivo vivo.

1. **Scripts clásicos, no ES modules.** `modules/*/renderer.js` (las últimas
   etiquetas del archivo) y los 210 atributos inline esperan globales. Además `state` es
   un `const` de nivel superior: en un módulo ES no sería `window.state` y dejaría de
   existir para quien lo necesite.
2. **Los `const`/`let` de nivel superior comparten entorno léxico global entre archivos
   clásicos.** Re declarar un nombre en dos archivos es `SyntaxError` al evaluar. Hoja a
   vigilar: `state`, `Sessions`, `LAB_TEMPLATES`, `seenMedia`, `_bookmarks`, `dlActive`,
   `mediaLogEl`, y los `const AI/PanelResize/WebChat/WhatsAppChat/StreamEnhancer` de los
   módulos ya externalizados.
3. **Orden de evaluación con contrato.** `hookPermissionsRefresh()` (L8352) envuelve
   `window.switchTab` y `window.loadUrl` en el momento de evaluarse: exige que ya
   existan. `stream-enhancer` parchea `window.addMediaItem/renderStreams/addStreamItem/
   scanStreams` en `DOMContentLoaded`, y `ai-assistant` llama a `AI.init()` al evaluar:
   todos los archivos extraídos van **antes** de los `<script src>` de `modules/*`.
4. **Hay código que se ejecuta al cargar**, no solo declara: IIFE de L2419/2759/2774
   (localStorage + DOM), `loadPanelBg()` en L2467–2470, `mc.setHlsCapture()` en L5850,
   el listener `keydown` de L7103, el IIFE `init()` de L7351–7589 (arranca webview,
   ~20 `mc.on`, `setInterval(tickClock)`), y dos `DOMContentLoaded` (L3277, L4377) que
   **no se ejecutan** si su archivo carga después de dispararse el evento.
5. **`'use strict'` es una sola directiva para 6010 líneas**: cada archivo nuevo necesita
   la suya.
6. **Templates con `<\/script>` escapado**: solo L6003, L6062, L6099 (bloque streams) y
   `LAB_TEMPLATES` L3627/3630/3631. Mientras sigan inline es obligatorio no romperlos.
7. **Sin `document.currentScript`, sin `document.write`, sin `<!--`** en el archivo:
   verificado, así que no hay trampas de parser del lado del HTML.
8. **`mc` no tiene guard en el inline** (p. ej. `mc.setHlsCapture()` sin comprobar).
   Mover el código no cambia eso; se documenta, se añade guard después.

### 7.3 Mapa del bloque inline (31 bloques contiguos)

> Rangos del archivo **original** (anteriores al paso 1). Sirven para saber qué
> contiene cada bloque; para cortar, siempre números del archivo vivo.

| # | Rango | Líneas | Bloque | Núcleo |
| --- | --- | --- | --- | --- |
| 01 | L2344–2400 | 57 | core-state | `state` (L2372), `ENGINES`, `UA_LABELS`, `DEFAULT_SHORTCUTS` |
| 02 | L2401–2427 | 27 | helpers | `$`, `setText`, `toggleSidebar`, IIFE de restauración |
| 03 | L2428–2587 | 160 | fondos | fondo de paneles, auto-contraste, init L2467–2470 |
| 04 | L2588–2788 | 201 | bookmarks | `_bookmarks`, CRUD, estrella, drag&drop |
| 05 | L2789–3248 | 460 | sessions | `const Sessions`, `window.Sessions` (L3247) |
| 06 | L3249–3283 | 35 | chat-edge | `toggleChatPanel` (fallback de 4 módulos) |
| 07 | L3284–3570 | 287 | panel-routing | `showPanel`, `openReader`, escena de fallo |
| 08 | L3571–3621 | 51 | navigation | `handleUrl`, `loadUrl` |
| 09 | L3622–4378 | 757 | lab | `LAB_TEMPLATES`, tabs/undo, consola, init DOMContentLoaded |
| 10 | L4379–4493 | 115 | history-nav | `addHistory/renderHistory`, `goBack/goForward/reloadPage/goHome` |
| 11 | L4494–4523 | 30 | url-filters | `AD_HOSTS_QUICK`, `isAdUrl`, `baseDomain` |
| 12 | L4524–4750 | 227 | webview-events | `selectionPreloadPath`, `bindWebviewToTab` |
| 13 | L4751–4845 | 95 | tabs | `addTab` (L4756), `switchTab` (L4797), `closeTab` |
| 14 | L4846–4899 | 54 | reload | `hardReloadTab`, `reloadTab` |
| 15 | L4900–4954 | 55 | newtab-ui | `setEngine`, escalas de UI |
| 16 | L4955–4976 | 22 | sidebar-log | `addSidebarLog` — **126 refs, 18 bloques + 4 módulos** |
| 17 | L4977–5112 | 136 | cosmetic-reqlog | `addReqLog`, `escapeHtml` (L5099, 58 refs) |
| 18 | L5113–5144 | 32 | stats | `refreshStats`, `resetStats` |
| 19 | L5145–5279 | 135 | protections | `updateProtections`, identidad/DoH/proxy |
| 20 | L5280–5459 | 180 | extractor | panel de recursos, `extractPageResources` |
| 21 | L5460–5552 | 93 | privacy-blocks | `setPrivacyLevel`, bloques custom, cookies |
| 22 | L5553–5593 | 41 | media | `seenMedia`, `addMediaItem` (parcheado por stream-enhancer) |
| 23 | L5594–6304 | 711 | streams | Stream Hunter, `openStreamResource` con templates, yt-dlp |
| 24 | L6305–6977 | 673 | downloads | persistencia, `bindDownloadEvents`, `dlMedia` |
| 25 | L6978–7049 | 72 | doh-clear | `testDoH`, `clear*`, export/import de sesión |
| 26 | L7050–7101 | 52 | synccfg | `syncCfgToUI`, `tickClock` |
| 27 | L7102–7174 | 73 | keyboard | listener global `keydown` (único) |
| 28 | L7175–7350 | 176 | shortcuts | fondos de página + accesos directos editables |
| 29 | L7351–7589 | 239 | init | IIFE `init()` — boot completo |
| 30 | L7591–7640 | 50 | lab-fs | `window.lab.fs` |
| 31 | L7642–8353 | 712 | permissions | panel Permisos, `hookPermissionsRefresh` (L8328–8352) |

### 7.4 Estructura destino y orden de extracción (hoja-primero, 10 pasos)

```
src/renderer/
  core/state.js      utils/dom.js      utils/url.js        ui/backgrounds.js
  ui/shortcuts.js    ui/logs.js        bookmarks.js        history.js
  lab.js             streams.js        downloads.js        settings.js
  sessions.js        permissions.js    app.js              (README.md por archivo con sus rarezas)
```

> Los rangos de la tabla salieron del archivo original y hay que re-verificarlos
> contra el archivo vivo antes de cada corte: en la primera ejecución dos venían
> con el final cortado (mitad de función) y el bloque 02 no estaba asignado a
> ningún paso. Por eso los pasos ya hechos llevan aquí los rangos exactos que se
> usaron, y tras cada paso los números de lo que queda bajan: se localiza por
> contenido, no por memoria. Rarezas encontradas al recortar (solo documentadas):
> el bloque 03 está sesenta líneas antes de lo que decía el mapa, el bloque 28
> contenía en realidad dos secciones (FONDO PERSONALIZABLE + ACCESOS DIRECTOS)
> y la cabecera `// INIT` quedaba ~170 líneas por encima del `init()` al que
> etiqueta: al sacar esas dos secciones la cabecera quedó pegada a `init()` sin
> tocar una sola línea de código.

| Paso | Archivo | Rango origen | Por qué es hoja |
| --- | --- | --- | --- |
| 1 | ✅ `core/state.js` | L2350–2399 (código L2351–2399; `L2345 'use strict';` y la cabecera L2346–2349 se quedan en el HTML) | raíz obligatoria; 24 de 31 bloques consumen `state` |
| 2 | ✅ `utils/dom.js` + `utils/url.js` | dom: **L2351–2377** (helpers del bloque 02, que el plan inicial no asignaba), **L2665–2707**, **L5049–5050**, **L6638–6655**; url: **L4444–4473** | hoja pura, cero referencias salientes |
| 3 | ✅ `ui/backgrounds.js` + `ui/shortcuts.js` | fondo de paneles (bloque 03) + "FONDO PERSONALIZABLE" (bloque 28) → `backgrounds.js`; "ACCESOS DIRECTOS EDITABLES" (bloque 28) → `shortcuts.js` | hojas DOM/localStorage; el bloque 28 se partió en dos archivos |
| 4 | `ui/logs.js` | L4955–4976, L5077–5111, L5538–5551 | `addSidebarLog` lo llama casi todo: salir pronto |
| 5 | `bookmarks.js` + `history.js` | L2588–2714, L4379–4463 | semihojas: dependen de `loadUrl` solo en callbacks |
| 6 | `lab.js` | L3622–4378, L7591–7640 | isla casi cerrada (757+50 líneas) |
| 7 | `streams.js` + `downloads.js` | L5553–6977 | acotados; exponen `window.*` → antes de los `<script src>` de `modules/*` |
| 8 | `settings.js` | L4977–5279, L5460–5552, L6978–7101 | configuración; consume pasos 2 y 4 |
| 9 | `sessions.js` + `permissions.js` | L2789–3248, L7642–8351 | permissions después de settings; **cortar antes de L8352** |
| 10 | `app.js` | L3249–3621, L4524–4954, L7102–7174, L7351–7589, **L8352** | hub acoplado + `init()` + `hookPermissionsRefresh()` al final |

Orden en el HTML resultante: `core → utils → ui → bookmarks → history → lab → streams →
downloads → settings → sessions → permissions → app` **y después** L8356–8369 sin tocar.

Detalles de mecánica, iguales en todos los pasos:

- Cada `<script src>` nuevo se inserta **justo antes** del `<script>` inline (L2344) y
  apunta a `./renderer/...`, porque `renderer.html` vive en `src/`.
- El único añadido dentro de cada archivo nuevo es su propio `'use strict';` (§7.2.5).
  Todo lo demás se copia carácter a carácter.
- El rango se corta con `tools/extract-renderer-block.js`, nunca a mano; después se
  comprueba que el cuerpo del archivo nuevo es idéntico al rango original.

### 7.5 Verificación por commit (además de la de §4.1)

| Check | Qué detecta |
| --- | --- |
| **Inventario de símbolos** (`test/renderer-symbols.test.js`, fixture generada ANTES del paso 1): las 280 funciones + 49 `const`/`let` de nivel superior + los 13 `window.*` + los 147 handlers `on*` + los globales que `modules/*` consume del renderer (`state` en ~53 líneas, `addSidebarLog` ~24, `addTab` ~17, `switchTab` ~14, `escapeHtml` ~14, `loadUrl` ~9) | una función perdida, un `window.*` que dejó de exponerse o un global del que los módulos se quedan sin dueño |
| **Conteo de líneas**: las líneas borradas de `renderer.html` deben ser iguales a las añadidas en los archivos nuevos | un "movimiento" que en realidad editó |
| **`git diff` sin mezcla**: solo Add/Delete de rangos enteros, nada de líneas modificadas en el medio | lógica tocada dentro de un bloque |
| **Reconstrucción byte a byte**: el HTML actual debe salir de restar los rangos y añadir las etiquetas al blob anterior (`git show`), y el cuerpo del archivo nuevo debe ser exactamente esos rangos | cualquier edición dentro de un bloque "movido" |
| **Chequeo de orden**: `window.switchTab`/`loadUrl` antes de `hookPermissionsRefresh`; `window.addMediaItem/renderStreams/addStreamItem/scanStreams` antes de los `<script src>` de `modules/*` | contratos de evaluación rotos (§7.2.3) |
| **`node --check`** en cada archivo nuevo | sintaxis; y recuérdese que **no valida referencias libres** |
| **`tools/renderer-globals-smoke.js <globales>`** | que el `<script src>` nuevo se descarga y **se evalúa** en la página: un fichero que no llega no lo detecta ni `node --check` ni el inventario |
| **`npm test` + `tools/boot-smoke.js` + `tools/doc-editor-smoke.js`** | arranque real, errores no capturados en el log |

### 7.6 Qué NO se toca en la Fase 2

- **La lógica, en ningún commit.** Ver §7.0.
- **El orden de los `<script src>` de `modules/*`** (últimas etiquetas del archivo):
  no se reordenan, no se renombran, no se pasan a ES modules.
- **El HTML y el CSS** de la UI anfitriona: esta fase mueve JS inline, nada más. Sacar
  CSS a archivos aparte sería otro plan, con su propia aprobación.
- **Los prompts y templates** (bloque 09, `LAB_TEMPLATES`, los del bloque 23).
- **`docs/PERCHANCE-ARCHITECTURE.md`** (contrato congelado) y las ideas retiradas de
  `docs/IDEAS-FUTURAS.md`.
- **Empaquetado** (`npm run dist`) sin autorización expresa.

## 8. Cómo se sabe que terminó

1. `main.js` queda por debajo de 150 líneas y solo orquesta.
2. `npm test` verde, mismos conteos de tests que la baseline.
3. `node --check` limpio en todos los archivos de `src/main/`.
4. La app arranca y se comportan igual: pestañas, navegación, permisos, cookies, descargas,
   sesión aislada, WebChat, WhatsApp, Perchance, IA, documentos.
5. Cada carpeta de `src/main/` tiene `README.md`.
6. `docs/GUIA-PARA-COLABORADORES.md` §3 (mapa de código) refleja la estructura nueva.
7. La sección 5 de este documento queda como registro histórico de lo que se encontró, con la
   referencia al archivo nuevo de cada trampa.