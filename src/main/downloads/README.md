# `src/main/downloads/`

Descargas que gestiona la app: las que aparecen en la lista del renderer y se
pueden pausar, reanudar, cancelar y reintentar.

| Archivo | Qué hay |
| --- | --- |
| `native.js` | El handler de `will-download`, el registro de descargas y los cuatro canales IPC. |
| `registry.js` | El registro de las descargas **activas** y los tres canales de pausar / reanudar / cancelar. |
| `fetch.js` | El transporte: cómo se pide un bytes con las cookies de la sesión. |
| `hls.js` | Los siete helpers del manifiesto, la reanudación y el canal `dl-hls`. |
| `file.js` | La descarga de un archivo directo, con `Range` para reanudar, y `dl-file`. |
| `ffmpeg.js` | Buscar FFmpeg, instalarlo si falta, y remux/recodificar a MP4. |

Ojo con los dos registros, que no son lo mismo y se confunden:

- El de `native.js` indexa las descargas que **el navegador** empezó, por sesión.
  Es lo que aparece en la lista del renderer.
- El de `registry.js` indexa las descargas que **la app** está bajando por su
  cuenta (`dl-hls`, `dl-file`), y existe solo para poder pausarlas. No se pinta
  en ninguna lista: se borra en el `finally` de cada bucle.

## Antes y después del paso 15

| Antes (en `main.js`) | Ahora |
| --- | --- |
| `const dlRegistry = new Map()` | `DownloadsRegistry.dlRegistry` |
| `class PauseSignal extends Error {}` | `DownloadsRegistry.PauseSignal` |
| `dlRegister()` | `DownloadsRegistry.dlRegister()` |
| `dlWaitIfPaused()` | `DownloadsRegistry.dlWaitIfPaused()` |
| `getSessionFetch()` | `DownloadsFetch.getSessionFetch()` |
| `chromiumFetch()` | `DownloadsFetch.chromiumFetch()` |
| `mediaRequestHeaders()` | `DownloadsFetch.mediaRequestHeaders()` |
| `ipcMain.handle('dl-pause' \| 'dl-resume' \| 'dl-cancel')` | `DownloadsRegistry.registerDownloadControlIpc()` |

Y lo que se quedó en `main.js`, con su consumidor:

| Se queda | Lo usa |
| --- | --- |
| `ffmpeg-check`, `ffmpeg-install` (canales IPC) | sin paso asignado: son de una línea y MainWindow los llama |
| `open-dl-folder`, `dl:open-file` | sin paso asignado |

**`file.js` y `hls.js` ya no reciben inyecciones.** El paso 17 confirmó que
`file.js` no usa ffmpeg, y el 18 movió el bloque a su propio módulo, así que
`hls.js` lo requiere directo y `registerHlsIpc()` no recibe parámetros. La deuda
del criterio 5.14 quedó cerrada; hay tests que fijan que no vuelva.

## Antes y después del paso 18

| Antes (en `main.js`) | Ahora |
| --- | --- |
| `FFMPEG_DIR` y las once funciones de ffmpeg | `DownloadsFfmpeg.*`, en `ffmpeg.js` |
| `DownloadsHls.registerHlsIpc({ finalizeMediaFile })` | `DownloadsHls.registerHlsIpc()` |
| `ipcMain.handle('ffmpeg-check', ... findFfmpeg() ...)` | `... DownloadsFfmpeg.findFfmpeg() ...` |
| `ipcMain.handle('ffmpeg-install', ... installFfmpegPortable())` | `... DownloadsFfmpeg.installFfmpegPortable()` |

`main.js` pasa de 3051 a 2833 líneas.

## Sin ffprobe, TODO se recodifica

`findFfprobe` no busca ffprobe: mira al lado del ffmpeg que encontró. Si el
usuario tiene ffmpeg en el PATH pero el ffprobe no está a su lado,
`inspectMediaFile` devuelve `null`, `finalizeMediaFile` no ve streams, y cae
directo en `transcodeToMp4`: lentísimo, pierde calidad, y sin avisar de nada.
Con video h264+aac debería haber sido un remux de un segundo.

Y antes de eso, `FFMPEG_DIR` es una flecha a propósito. Cachearla evaluaría
`app.getPath('userData')` al cargar el módulo, y FFmpeg se instalaría en el
perfil equivocado: el mismo bug que se corrigió para las rutas `[DATA]`.

## Antes y después del paso 17

| Antes (en `main.js`) | Ahora |
| --- | --- |
| `ipcMain.handle('dl-file', ...)` | `DownloadsFile.registerFileDownloadIpc()` |
| el cálculo de `detectedExt`, `safeBase`, `finalTarget` | dentro de `file.js` |

Con esto los dos bucles de descarga (`dl-hls` y `dl-file`) han salido de
`main.js`. Lo que queda de descargas ahí son `open-dl-folder` y `dl:open-file`,
que no tienen paso asignado en el plan.

## Reanudar en `file.js` es volver a pedir, no seguir escribiendo

El estado de reanudación es el propio `.part` en disco: el offset es su tamaño.
Pausar **no** deja el stream abierto, lanza `PauseSignal` dentro del reader y el
`while` exterior vuelve a pedir con `Range: bytes=<offset>-`.

Si el servidor **ignora** el Range y contesta 200 en vez de 206, el código lo
detecta y reinicia desde cero. Sin esa comprobación se concatenarían el `.part`
viejo con la respuesta entera y saldría un archivo del tamaño de la suma, sin
ningún error de red. Y el `output.close()` va **antes** del truncado: en Windows
un `WriteStream` abierto bloquea el fichero y el `writeFileSync` siguiente falla
con `EPERM`.

## `detectedExt`: raro a propósito, y con test que lo fija

Antes del paso 17 esto ya era el código, y nadie lo había tocado. Se documenta
porque es lo primero que va a "arreglar" alguien, y **arreglarlo cambia los
nombres de archivo que ve el usuario**.

El primer patrón cubre `png|jpe?g|gif|webp|avif|bmp|svg` y devuelve `.png`, así
que las tres ramas siguientes (`jpg`, `gif`, `webp`) son **inalcanzables**:

| URL | Se guarda como | Bytes |
| --- | --- | --- |
| `foto.jpg`, `foto.gif`, `foto.webp`, `x.avif`, `x.svg`, `x.bmp` | `.png` | los originales |
| `cancion.wav`, `cancion.flac`, `cancion.ogg` | `.mp3` | los originales |
| `clip.mkv`, `clip.mov`, `clip.avi` | `.mp4` | los originales |
| `archivo.zip` | `.bin` | los originales |

Agrupa por familia y usa la extensión canónica de esa familia. Que la tercera
rama existiera precisamente para evitar el JPEG llamado `.png` sugiere que la
primera se toco y las dejo sin efecto, pero no hay forma de saberlo y no se toca
aquí.

`test/downloads-file.test.js` fija el comportamiento actual, con el nombre del
test diciendo que es raro a propósito. Si alguien lo arregla, el test falla y le
dice que va a cambiar nombres de archivo.

## Antes y después del paso 16

| Antes (en `main.js`) | Ahora |
| --- | --- |
| `resolveUrl()`, `downloadSegment()` | `DownloadsHls` las encapsula; ya no se exportan |
| `pickBestHlsVariant()`, `parseHlsSegmentUrls()` | ídem |
| `hlsSegmentIv()`, `decryptAes128Segment()`, `loadHlsEncryption()` | ídem |
| `writeHlsChunk()`, `flushHlsOutput()` | ídem |
| `ipcMain.handle('dl-hls', ...)` | `DownloadsHls.registerHlsIpc({ finalizeMediaFile })` |
| `require('./lib/hls-resume')` en `main.js` | se va con su único consumidor |

`finalizeMediaFile` llega **por parámetro**, no importado. Importarla sería
circular (main.js requiere `hls.js`, y `hls.js` requeriría main.js). Es la
inyección temporal del criterio 5.14 del plan, y la resuelve el paso 18.
`downloads/file.js` hará lo mismo en el 17.

`FFMPEG_DIR` se quedó en `main.js` a propósito: está justo debajo de los helpers
de HLS y era el candidato obvio para sair por error. Hay un test que lo fija.

## Las trampas de HLS, que fallan sin error

Las seis están en la cabecera de `hls.js`. Las dos que más cuestan:

- **El IV.** Cuando el manifiesto no trae `IV=0x...`, se deriva del número de
  secuencia en big-endian dentro de 16 bytes de cero, en el offset 8. Si se
  escribe little-endian, o en el offset 0, `decipher` **no falla**: devuelve
  bytes, el archivo se guarda y el único síntoma es que el vídeo va a saltos.
- **La reanudación solo existe para VOD.** Un directo no tiene `#EXT-X-ENDLIST` y
  sus segmentos se desplazan solos, así que reanudar por índice produce un
  archivo con segmentos de dos momentos distintos. Y el `fingerprint` del
  manifiesto es la segunda puerta: si el servidor rotó la playlist, el estado se
  descarta.

Y una que parece un bug y es lo contrario: **un segmento que falla cancela la
descarga entera**, en vez de saltarse. Un `.mp4` con un agujero se abre y no
sabes si le falta un trozo o si está mal. Se prefiere que no haya archivo, y el
`.part.ts` se queda para que el usuario pueda mirarlo.

## Lo que no se puede testear todavía

Los siete helpers del manifiesto son puros y se podrían testear de verdad: la
elección de variante, el cálculo del IV, el parseo de segmentos. Pero `hls.js`
hace `require('electron')` al cargarse, así que ningún test de node plano lo
puede importar y todos leen el fuente.

La solución sería partir los puros en `hls-parse.js`, sin electron. No se hizo
porque el plan fija la estructura destino y añadir un archivo ahí sería
desviarse de ella. Es el paso natural si alguien quiere probar la aritmética del
IV en vez de leerla.

## Dos funciones, no una

## Lo que no se toca al mover

- **`dl-pause` solo aborta en `type === 'file'`.** En HLS abortar el controller
  tiraría los segmentos ya bajados del lote; el bucle HLS espera en el límite y
  reanuda sin perderlos. Si se quita ese `if`, pausar una descarga HLS pierde
  progreso y no lanza ningún error.
- **El `entry.controller.signal` se lee en cada petición**, nunca se cachea en
  una variable al principio del bucle. `dl-resume` crea un `AbortController`
  nuevo porque el anterior queda abortado para siempre: reutilizarlo hace que la
  descarga reanudada no continúe, y tampoco da error.
- **`PauseSignal` se captura con `instanceof` y `continue`.** No es un fallo: es
  una pausa. Si un `catch` genérico lo tratara como error, el usuario vería un
  aviso de fallo de algo que él mismo acaba de provocar, y la descarga se
  marcaría como fallida en vez de pausada.

Las tres tienen test en `test/downloads-control.test.js`, y los tests se
verificaron **mutando el código a propósito**: quitando el `type === 'file'`,
reutilizando el controller viejo, y moviendo un handler a `event.sender.session`.

## Las cookies: por qué no basta con `fetch`

El proceso main no ve el `cookieStore` de Electron, así que un `fetch` de Node
descargaría sin sesión y el usuario vería un 401 sin explicación. `fetch.js`
prefiere `session.fetch()` (el de Chromium) y solo cae al `fetch` de Node
montando las cookies a mano, con dos ramas: si `cookies.get` falla, reintenta sin
cookies en vez de rendirse.

`sessionFetch` se resuelve **una vez, al cargar el módulo**. Es lo único del
módulo que depende del entorno y no del código, y por eso los tests solo pueden
mirar el fuente.

## Dos funciones, no una

```js
registerNativeDownloadHandler(sess)  // por sesion
registerNativeDownloadIpc()          // una vez, en main
```

La separación no es estetica. El handler se registra **por sesion** porque
`will-download` pertenece a la sesion que produce la descarga, y hay dos que lo
necesitan: la principal y la aislada de cada sesion extra. El IPC se registra
**una sola vez** porque los canales son globales a la aplicacion: registrarlo dos
veces hace que `ipcMain.handle` lance en el arranque.

Mezclarlos en una sola función habría producido una de dos cosas: o el IPC
registrado N veces (con el arranque roto), o el handler de la sesion principal
instalado tambien en las extras (con una descarga aislada apareciendo en la lista
de la ventana principal).

## El estado es privado a proposito

`nativeDlRegistry` y `pendingNativeRetryId` no se exportan. No son un detalle de
implementacion: son la diferencia entre que dos sesiones puedan pisarse y que no.
El registro se indexa por sesion, y el reintento pendiente es una sola ranura
global porque `dl-native-retry` es un boton del renderer que no sabe de sesiones;
es el handler el que decide a cual pertenece la descarga que reintenta.

`test/downloads-native.test.js` comprueba las tres cosas que se podrian romper al
mover codigo sin querer: que el handler se registra en las dos sesiones y solo en
esas dos, que los cuatro canales se registran exactamente una vez, y que el
estado no se exporta.

## Lo que no se toca al mover

- **El filtro de Perchance** decide mirando la URL de la **pagina**, no la del
  archivo. Es lo que hace que una descarga desde Perchance se ignore aunque la
  URL de la descarga apunte a otro sitio. Si se cambia a mirar la URL de la
  descarga, el filtro se desactiva sin que ningun test se queje.
- **La poda del registro** ordena por `completedAt` y corta las mas viejas una
  vez que hay mas de 200 completadas. La condicion es sobre descargas
  completadas, no sobre el tamaño del mapa: un mapa con 250 descargas en curso no
  se poda, y podarlo habria perdido descargas que el renderer todavia esta
  mostrando.