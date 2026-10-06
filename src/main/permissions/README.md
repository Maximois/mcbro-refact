# src/main/permissions/ — permisos por sitio

Puente entre Electron y `lib/permissions.js`. Aquí no hay política: la política
es pura y está testeada en `lib/permissions.js` + `test/permissions.test.js`.
Estos cuatro archivos aportan solo el pegamento que necesita Electron y `CFG`.

```
lib/permissions.js   (puro, testeado, recibe cfg como parámetro)
        ↑
        │  lo llama con el CFG vivo
   adapters.js        (atadura: "esta regla, contra la configuración actual")
        ↑        ↑
  entries.js      notifications.js     (escriben / preguntan)
        ↑        ↑        ↑
              handlers.js               (decide por sesión + IPC)
```

La dependencia va en una sola dirección. Si algún día hace falta algo de
`handlers.js` dentro de `entries.js`, es que falta un nivel, no que haya que
meter un `require` circular.

## Archivos

| Archivo | Responsabilidad | Estado propio |
|---|---|---|
| `adapters.js` | `Permissions.x(..., CFG)` | ninguno |
| `entries.js` | escribe `CFG.permissions` / `CFG.permissionOrigins` | ninguno |
| `notifications.js` | el diálogo de permisos de notificaciones | `pendingNotificationPermissions` |
| `handlers.js` | `setupSessionPermissionHandlers(sess)` + IPC | ninguno |

### `adapters.js`

Funciones de una línea. Reciben `cfg` como parámetro para poder testearse en
Node sin Electron; los adapters son los que pasan el `CFG` real. Todas las
llamadas desde `main.js` pasan por aquí, así que este archivo es también el
punto único donde se puede colgar instrumentación o validación de la política.

`normalizeGlobalBlockPattern` es **código muerto**: ni este wrapper ni su
equivalente en el `main.js` original (5162 líneas) tenían callers. Se conserva
para que la extracción fuera puro; su borrado queda para la fase de limpieza.

### `entries.js`

Graba lo que se le pide; **no decide**. Acepta cualquier `value` sin validar.
Quien decide si algo se concede es `lib/permissions.js` a través de
`adapters.js`. Confundir estas dos capas es el error grave aquí: escribir una
regla no la concede.

Vive en un módulo aparte porque `notifications.js` necesita persistir la
decisión del diálogo, y `handlers.js` necesita lanzar el diálogo. Juntas en un
archivo, habría ciclo.

### `notifications.js`

Único permiso que abre diálogo al usuario. El resto se resuelve contra la
configuración sin preguntar.

Ciclo de vida de una petición:

```
setPermissionRequestHandler('notifications')
  └─ requestNotificationsPermission()
       ├─ ya hay regla previa (allow o deny)  -> return false, decide la config
       ├─ sin ventana / destruida             -> callback(false), return true
       └─ requestId + timer 45 s
            ├─ send('notification-permission-request', { requestId, domain })
            ├─ el renderer contesta por 'notification-permission-response'
            │    └─ finishNotificationPermissionRequest()
            ├─ timer agotado                   -> callback(false)
            ├─ send() falla                    -> callback(false)
            └─ la pestana que pidio se destruye -> callback(false)
```

Los cuatro caminos de fallo están a propósito. El `setTimeout` y el
`once('destroyed')` no son redundantes: cubren que el usuario no conteste y
que la pestana se cierre. Sin ellos, el callback de Electron queda retenido y
con él el `webContents`.

`persistDecision` solo es `true` cuando el renderer mandó un booleano
explícito (`typeof response.allowed === 'boolean'`). Un mensaje malformado
resuelve `false` sin escribir en la configuración.

### `handlers.js`

`setupSessionPermissionHandlers(sess)` se instala **por sesión**, no global: la
principal en `createWindow()`, la de WebChat y la de WhatsApp. Cada una tiene
políticas distintas (WhatsApp recibe `setPermissionEntry('web.whatsapp.com',
'notifications', 'allow')` explícito al arrancar). Un handler global aplicaría la
política del navegador principal a sitios deliberadamente exentos.

El `setPermissionCheckHandler` es la ruta de solo lectura que Chromium usa para
decidir si un permiso ya concedido sigue válido; comparte `decide()` con el
handler de peticiones para que no puedan divergir.

## Canales IPC

Migrados desde `main.js` sin cambios de nombre ni de contrato:

| Canal | Origen |
|---|---|
| `add-permission` | renderer → main |
| `set-site-permission` | renderer → main |
| `remove-permission` | renderer → main |
| `remove-site-permission` | renderer → main |
| `get-permissions` | renderer → main |
| `get-permission-origins` | renderer → main |
| `notification-permission-request` | main → renderer |
| `notification-permission-response` | renderer → main |

Los dos últimos viven en `notifications.js`, no en `handlers.js`: el segundo es
el que cierra el ciclo del diálogo, no una decisión de permisos.

Ojo: `add-permission`/`remove-permission` y `set-site-permission`/`remove-site-permission`
son **pares de alias**, no funciones distintas. Los cuatro existían antes de
esto y no se han unificado: la unificación es trabajo de otra fase.