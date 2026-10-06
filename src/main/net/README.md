# src/main/net/

Todo lo que pasa por la red: resolución DNS, cookies y cabeceras.

```
config ──> doh ──────────────> electron.app
   │
   └──> headers ──> tracker, navigation/domains, permissions, adblocker, runtime
   └──> cookie-guard ──> permissions, config, tracker
   └──> proxy ──> config
```

En este directorio están `doh.js`, `cookie-guard.js`, `headers.js`, `proxy.js` y
`request-guard.js`. Los cuatro módulos del plan 10-12 están aquí, más el
guardian, que se sacó antes de tiempo (ver abajo).

## `doh.js`

Dos cosas que viven juntas por ser el mismo tema:

- **`applyDoH()`** configura el resolver de Chromium con el proveedor elegido.
- **`resolve-doh`** es el IPC que usa el botón de probar del panel para consultar
  una IP de ejemplo y decir si el proveedor responde.

## Hay dos mapas de servidores, y no se unifican

`DOH_SERVERS` es el endpoint `/dns-query` (formato wire RFC 8484): es lo que
entiende `app.configureHostResolver`. El mapa `servers` de dentro de `resolve-doh`
es para consultar por `fetch` y parsear la respuesta.

Los endpoints están **medidos**, no supuestos:

| Proveedor | Endpoint | Resultado real |
| --- | --- | --- |
| cloudflare | `/dns-query` | HTTP 200, JSON ok |
| cloudflare | `/resolve` | **HTTP 404** |
| google | `/resolve` | HTTP 200, JSON ok |
| adguard | `/resolve` | HTTP 200, JSON ok |
| nextdns | `/resolve` | HTTP 200, JSON ok |
| quad9 | — | `null`, marcado `wire-only` |
| mullvad | — | `null`, marcado `wire-only` |

Cloudflare no tiene `/resolve`: content-negocia en `/dns-query` y devuelve JSON
cuando la cabecera dice `Accept: application/dns-json`, que es justo lo que manda
`resolve-doh`. Por eso ese mapa pone Cloudflare en `/dns-query` y no en
`/resolve`. **Ponerlo "para que cuadre con los demás" devuelve un 404.**

Quad9 y Mullvad están en `null` en el mapa JSON porque no sirven DoH en JSON, solo
en wire. El test lo dice con `{ code: 'wire-only' }` en vez de fingir que
funcionan. La app sí los usa para resolver de verdad, por eso están completos en
`DOH_SERVERS`.

`test/net-doh.test.js` fija estas invariantes sobre el fuente: si alguien "ordena"
los mapas, el test se entera aunque la app siga arrancando.

## `app.configureHostResolver` es global, no por sesión

Tres sitios de la app lo llaman y los tres compiten por el **mismo** ajuste:

1. `setupPerchancePanel()` → `secureDnsMode: 'off'`
2. el bloque de Perchance dentro de `whenReady` → `secureDnsMode: 'off'`
3. `applyDoH()` → `'secure'` / `'automatic'`, o `'off'` si está apagado

`applyDoH()` se ejecuta **al final** de `whenReady`, así que **gana**. Con DoH
activado, el resolver seguro global que el comentario de Perchance dice querer
evitar le vuelve a ser aplicado encima. Preexistente, anotado y no corregido:
arreglarlo es otro commit, con su prueba.

Cuando `dohEnabled` está apagado, `applyDoH()` cae en
`app.configureHostResolver({ secureDnsMode: 'off' })`, que es lo que ya querían los
otros dos. Por eso el conflicto sólo se ve con DoH encendido.

## El reintento de `resolve-doh` comparte el mismo reloj

Son dos intentos, pero **uno solo de 8 s en total**: el `setTimeout` se crea una
vez antes del bucle, y el `clearTimeout` está en el `finally` de los dos. El
segundo intento no tiene presupuesto propio.

Sólo reintenta ante 408 / 429 / ≥500, y el `attempt === 1` del `break` impide que
el bucle siga. Un 404 sale sin reintentar, que es lo correcto.

## `cleanbrowsing` no existe en ningún mapa

`CFG_DOH_SERVERS` (validación, en `config/index.js`) acepta `'cleanbrowsing'`, pero
el `<select>` del renderer no lo ofrece y este archivo no tiene su URL.

Si llegara a colarse en `cfg.json`, `DOH_SERVERS[CFG.dohServer]` sería `undefined`
y `applyDoH` caería en Cloudflare **sin avisar**. El mismo
`|| servers.cloudflare` de `resolve-doh` haría lo propio. El `<select>` del
renderer es la lista real de proveedores; `CFG_DOH_SERVERS` está más generoso que
la realidad.

## El IPC se registra al importar el módulo

`resolve-doh` se registra al hacer `require()`, no dentro de `app.whenReady()`.
Si nadie requiere `doh.js`, ese canal no existe.

---

# `cookie-guard.js`

La política de cookies aplicada a lo que una página se pone **con
`document.cookie`**. Cubre el hueco que deja `onHeadersReceived`.

## Por qué CDP y no un override en el preload

`onHeadersReceived` sólo ve las cookies que viajan en el header `Set-Cookie`. Las
que un sitio se pone desde su propio JS (`document.cookie = "..."`) nunca
generan una respuesta de red, así que la política no se entera.

Un `Object.defineProperty(document, 'cookie', ...)` hecho desde `preload.js`
**no sirve**: con `contextIsolation:true` —como está configurada esta app— el
`document` que ve el preload es un wrapper de un mundo aislado, distinto del que
ve el script de la página. El override quedaría invisible para ella.

Lo que sí entra en el mundo principal antes de que corra nada propio es
`Page.addScriptToEvaluateOnNewDocument`, la misma técnica que usan
Puppeteer y Playwright.

## Los cuatro registros débiles

| Registro | De qué sirve |
| --- | --- |
| `cookieGuardIds` | `wc` → identifier del script CDP registrado |
| `cookieGuardOwned` | `wc` → el debugger lo adjuntó **este** módulo |
| `cookieGuardLifecycleInstalled` | `wc` → ya tiene los listeners de limpieza |
| `cookieGuardTasks` | `wc` → promise del update en curso |

Todos `WeakMap`/`WeakSet`, no `Map`/`Set`: un `Map` retendría los `webContents`
destruidos para siempre.

## `cookieGuardOwned` es lo que impide romper Perchance

Perchance también usa CDP sobre sus webviews (`wc.debugger.attach` en
`setupPerchanceNetwork`). Si este módulo hiciera `detach()` a ciegas, le
desconectaría el debugger al panel.

Por eso `detachCookieGuard()` sólo desconecta si `owned`, y `attachCookieGuard()`
sólo marca `cookieGuardOwned` cuando el `attach` lo hizo él mismo.

## El filtro de `refreshCookieGuards` es un parámetro, no un import

Sólo llevan cookie guard los webviews de la sesión principal y de las aisladas.
Ni los de WebChat (5 dominios fijos, sin bloqueo) ni los del panel de Perchance.

Ese filtro es `isMainBrowsingSession(wc) || isExtraSessionWebContents(wc)`, que
es de `sessions/partitions.js` —el paso 13— y **todavía vive en `main.js`**. Por
eso `refreshCookieGuards(esAplicable)` lo recibe en vez de importarlo: importarlo
aquí crearía un ciclo, porque `main.js` declara esas funciones después del
`require`.

`main.js` pasa `esWebviewProtegido`, un helper de tres líneas junto a los
predicados de sesión. Los 4 call sites lo pasan; sin él se inyectaría el script en
páginas que antes no lo tenían.

## Cambiar la política no toca las cookies ya escritas

El override CDP se queda en el mundo de la página **actual**. Cambiar `CFG` no lo
modifica ahí, así que `registerCookieGuardScript()` quita el script anterior con
`Page.removeScriptToEvaluateOnNewDocument` y pone el nuevo, que aplica a la
*siguiente* navegación.

Las cookies que la página ya escribió en esta carga no se tocan. Para eso está
`applyCookiePolicy()`: al cambiar a `session`, recorre el jar de `persist:mc` y
borra las de sesión (`c.session === false`) que no estén en un dominio de auth ni
con política `allow`.

## `cookieRemovalUrl` vive aquí pero se usa desde 8 sitios

Construye la URL que exige `cookies.remove()`: `https://` si la cookie es secure
(salvo que diga otra cosa), `http://` si no, siempre con su path.

El default de `secure` es `true`, y `cookie?.secure !== false` hace que un
`undefined` cuente como seguro. Es a propósito: si no se sabe, se asume la opción
restrictiva.

Se exporta desde aquí por ser lo más cercano a su único uso, pero **8 llamadas
siguen en `main.js`**, casi todas en el IPC de sesiones (`clear-cookies`,
`get-site-cookies`, `add-cookie-rule`…) que es del paso 14. Cuando ese paso mueva
el IPC, el helper puede mudarse a `sessions/` sin cambiar ninguna llamada.

## Rutas: tres niveles para salir de `src/main/`

Desde `src/main/net/` la raíz del repo está **tres** niveles arriba:

```js
require('../config')                  // src/main/config
require('../permissions/adapters')    // src/main/permissions/adapters
require('../navigation/domains')      // src/main/navigation/domains
require('../../../lib/permissions')   // <-- lib/permissions (raiz del repo)
```

Con dos niveles, `../../lib/permissions` apunta a `src/lib/permissions` y el
`require` revienta al arrancar. `test/net-cookie-guard.test.js` fija la ruta
correcta.

La regla estaba escrita y aun así se incumplió: al extraer `sessions/extra.js`,
el `require` del adblocker quedó con dos niveles en lugar de tres, y como
`modules/adblocker/` está en la raíz del repo eso apuntaba a
`src/modules/adblocker`. El `require` estaba dentro de un `try/catch` cuyo único
efecto es `console.error`, así que la sesión extra se quedó **sin adblocker**, sin
error visible y con `boot-smoke.js` en verde.

Por eso `test/sessions-setups.test.js` recorre ahora todos los `require()`
relativos de los módulos extraídos y comprueba que el archivo exista, con la
extensión resuelta como la resuelve Node. La comprobación no depende de que el
fallo se propague, que es justo lo que el `catch` impedía.

## Invariantes fijados por test

`test/net-cookie-guard.test.js` lee el fuente (el módulo hace
`require('electron')`, así que no se puede importar en un test de node plano) y
comprueba, entre otras cosas:

- que los 4 registros sigan siendo débiles;
- que el `detach()` siga gateado por `cookieGuardOwned`;
- que `installCookieGuardLifecycle` se auto-rote antes de poner listeners;
- que los updates en vuelo se encadenen (`previous.catch().then(run)`) y no se
  solapen peleándose por el mismo identifier de CDP;
- que el snapshot de `CFG` siga congelado con `JSON.stringify`, para que el
  closure del script no se quede desactualizado;
- que los 4 call sites de `refreshCookieGuards` pasen el predicado;
- que `document.cookie` siga siendo fail-open.
---

# `headers.js`

Los tres interceptores de red que cuelgan de una sesión, movidos tal cual desde
`whenReady`. Se registran con `installHeaderInterceptors(sess, deps)`.

| Interceptor | Qué hace |
| --- | --- |
| `webRequest.onBeforeSendHeaders` | Referer, `Accept-Language`, aislamiento de cookies, UA de Perchance y Client Hints de WhatsApp. Emite `streams:hls-captured` al ver un `.m3u8`. |
| `webRequest.onHeadersReceived` | `Set-Cookie` según política y `Access-Control-Allow-Origin: *` para HLS. |
| `cookies.on('changed')` | Borra la cookie de JS que el anterior no vio, y notifica a la ventana con `cookie-intercepted`. |

## Por qué esto no cubre el `document.cookie` del sitio

`onHeadersReceived` sólo ve cookies que viajan en `Set-Cookie`. Las que un sitio
se pone desde su propio JS nunca generan respuesta de red, así que se escapan.
El tercer interceptor es la red de seguridad: borra la cookie en cuanto Chromium
la confirma, para que la política se sostenga. El bloqueo real (que no exista ni
un instante) lo hace `cookie-guard.js` entrando al mundo principal por CDP.

## Los helpers de streams llegan por parámetro

`findHlsPlayerEntry`, `findStreamEntryReferer` y el flag
`streamHlsCaptureEnabled` son de `streams/capture.js`, el **paso 21**, que aún no
existe. Por eso entran en `deps` en vez de importarse.

Cuando llegue el paso 21, `deps` pasará a salir del módulo y este parámetro
desaparece. Hasta entonces `main.js` es el dueño de esos helpers.

Dos detalles que importan:

- **El flag se lee por getter** (`isStreamHlsCaptureEnabled()`). Si el módulo lo
  capturara por valor al registrarse, quedaría congelado en `false` y la captura
  HLS no ocurriría nunca.
- **`consumeStreamEntryReferer` mezcla lookup y borrado.** `main.js` hacía
  `findStreamEntryReferer(d)` y acto seguido `streamEntryReferers.delete(key)`.
  El borrado es parte del **consumo** — un referer de entrada se gasta en el
  primer request que lo usa — así que los dos van detrás de una sola función.
  Separados, un segundo request del mismo token reutilizaría el referer.

`main.js` los pasa al registrar:

```js
installHeaderInterceptors(sess, {
  isStreamHlsCaptureEnabled: () => streamHlsCaptureEnabled,
  consumeStreamEntryReferer,
  findHlsPlayerEntry,
});
```

Si `deps` llega incompleto, la función **lanza** en vez de fallar en el primer
request con un `TypeError` dentro de un callback de red.

## El orden de las reglas de referer no es libre

En `onBeforeSendHeaders` el `Referer` se toca tres veces y **gana el último**:

1. `CFG.refererPolicy` (`no-referrer` / `origin`)
2. el referer del stream guardado por entrada, si no expiró
3. el referer del player HLS, si la petición es media y no `mainFrame`

El bloque 3 está indentado con 4 espacios de más en el original. No es un error
de copiado: se respeta tal cual y no se reformatea.

## Las excepciones cortan antes de filtrar

Perchance (por host) y los dominios de auth (`isAuthDomain` /
`isAuthRedirectFlow`) hacen `return` temprano con las cabeceras intactas. Por eso
la partición de Perchance **no** recibe `Accept-Language` ni el aislamiento de
cookies: es justo lo que permite que Cloudflare/Turnstile funcione.

Si alguien mueve esas comprobaciones hacia abajo del filtrado, Perchance empieza
a recibir cabeceras ajenas y Turnstile vuelve a romperse. El test comprueba el
orden.

## `onHeadersReceived` tiene dos salidas

El `try` devuelve `responseHeaders`; si algo revienta, el `catch` cae en `cb({})`,
que es **dejar pasar la respuesta tal cual**. Un fallo de parseo no bloquea la
red. Que ese `catch` llegara a ser `cb({ cancel: true })` sería un cambio de
comportamiento muy serio, y el test lo prohíbe explícitamente.

## Queda un `onBeforeSendHeaders` en `main.js`

El de la sesión de WhatsApp (`waSess`), que alinea los Client Hints con
`UA_WHATSAPP` para evitar el error de "navegador no compatible". Se queda ahí a
propósito: cuelga de la sesión de WhatsApp, que es del **paso 13**. Cuando esa
sesión se mueva, pasará a llamar a algo de este módulo.

Duplica el bloque `setHdr('sec-ch-ua', ...)` del interceptor principal. Es
candidato obvio a deduplicar, pero no en esta fase.

---

# `proxy.js`

La configuracion de proxy y su aplicacion a las sesiones.

| Funcion | Que hace |
| --- | --- |
| `proxyRulesFromCfg()` | `{ proxyRules }` desde `CFG`, o `null` si el proxy esta apagado. |
| `applyProxyFromCfg(sess, tag)` | Aplica esa regla a una sesion, sin esperar. |
| `setProxy(settings, partitions)` | Cuerpo del IPC `proxy:set`: valida, aplica a las tres particiones y persiste. |

## El bug que se fue con el modulo

`setProxy()` estaba escrito **cuatro veces**, identico, cambiando solo la sesion
y la etiqueta del log:

```js
// antes, en 4 sitios (principal, webchat, whatsapp, aislada)
if (CFG.proxyEnabled && CFG.proxyHost) {
  X.setProxy({ proxyRules: `${CFG.proxyType || 'socks5'}://${CFG.proxyHost}:${CFG.proxyPort || 1080}` })
    .catch(e => console.error('[PROXY][...', e.message));
}
```

Es una funcion con dos parametros replicada cuatro veces. El dia que cambien los
defaults (el `socks5`, el `1080`) o la forma de la regla, hay que acordarse de
las cuatro, y basta con olvidar una para que una sesion siga saliendo a
internet sin proxy. Ahora hay un solo sitio, y el test comprueba que
`main.js` no vuelva a escribir una regla a mano.

`applyProxyFromCfg()` no espera a `setProxy()`. Sigue siendo fire-and-forget
con `.catch()`, que es como estaba: durante el arranque de una sesion no se puede
bloquear el `app.whenReady()` esperando a que el proxy responda.

## Al apagar se manda `mode: 'direct'`, no `proxyRules: ''`

```js
const destino = proxyEnabled ? { proxyRules } : { mode: 'direct' };
```

Una cadena vacia no es "sin proxy" para Chromium; se queda esperando una
conexion que no va a llegar. En el original el ternario estaba duplicado tres
veces en la misma expresion, una por particion; aqui se calcula una vez y se
reutiliza.

## Las particiones reciben el error de forma distinta

```js
await session.fromPartition('persist:mc').setProxy(destino);                              // falla hacia el renderer
await session.fromPartition(partitions.webchat).setProxy(destino).catch(() => {});        // falla en silencio
await session.fromPartition(partitions.whatsapp).setProxy(destino).catch(() => {});       // falla en silencio
```

No es un descuido y no debe unificarse. Si el proxy de la sesion principal
falla, el usuario tiene que enterarse: por eso el handler devuelve
`{ ok: false, error }`. Si falla el de un panel, la app sigue funcionando sin el
y no merece una alerta.

## Validacion

`proxyEnabled && (tipo no valido || sin host || puerto no entero || puerto fuera
de 1..65535)` devuelve `{ ok: false }` **antes de tocar ninguna sesion**, y
`proxyType` se normaliza a minusculas. Con el proxy apagado la validacion no se
aplica: eso permite apagar y limpiar host/port en la misma llamada, que es
justo lo que hace el toggle del panel.

## Los nombres de particion llegan por parametro

`WEBCHAT_PARTITION` y `WHATSAPP_PARTITION` son de `sessions/partitions.js`, el
paso 13. `setProxy()` los recibe en `partitions`:

```js
ipcMain.handle('proxy:set', (_e, settings = {}) => Proxy.setProxy(settings, {
  webchat: WEBCHAT_PARTITION,
  whatsapp: WHATSAPP_PARTITION,
}));
```

Tercera vez que se usa el patron de inyeccion (tras `esWebviewProtegido` en el
cookie guard y `deps` en headers). Los pasos 13 y 21 tienen que acordarse de
borrar sus firmas cuando sus modulos lleguen.

## Nota: `boot-smoke.js` ya no solo mira que la ventana cargue

Un fallo de esta fase salio justo por ahi, asi que queda escrito.

El smoke comprobaba que `renderer.html` apareciera en el puerto de depuracion.
Eso lo cumple el proceso principal **antes** de registrar sesiones,
interceptores y proxy, que ocurren despues dentro de `app.whenReady()`. Un
`ReferenceError` en esa segunda mitad deja una ventana operativa sobre una app
muerta: sin cookies, sin cabeceras, sin proxy. Sale como
`UnhandledPromiseRejectionWarning`, que no mata el proceso, asi que el smoke
daba **verde**.

Ese fue el caso con `Headers.installHeaderInterceptors`: la llamada se quedo sin
prefijo en `main.js`, `node --check` la acepto (una referencia libre no es un
error de sintaxis) y los tests de `net/headers` pasaban porque solo comprueban
que el modulo tenga los interceptores, no que `main.js` lo llame.

Dos arreglos:

- `test/net-headers.test.js` comprueba ahora que la llamada este cualificada y
  que los tres `deps` lleguen.
- `tools/boot-smoke.js` falla si en el log aparece `UnhandledPromiseRejection`,
  `ReferenceError`, `TypeError`, `SyntaxError` o `MODULE_NOT_FOUND`. Un `throw`
  de una promesa ya manejada con `catch` no aparece, asi que los
  `.catch(() => {})` legitimos no dan falso positivo.

Comprobado reintroduciendo el bug a proposito: el smoke pasa a exit 1 y lo nombra.
Un verde que no puede volver a ser verde por lo mismo no vale como verde.

---

# `request-guard.js`

El guardián de cada petición. Decide si una request se cancela, se redirige, se
permite o se deja pasar. No es una regla más del adblock: es **la** función que
consulta el adblock, y es lo que hace que una sesión extra se comporte como la
principal.

Se invoca así: `RequestGuard.createRequestGuard()` devuelve un closure
`(details) => decision`, y se le pasa al adblock como `requestGuard`. El closure
lee `CFG` en **cada** invocación, no al crearse, así que no hay que
re-registrarlo cuando el usuario cambia una regla.

## El orden de la cascada es el comportamiento

No es un `if / else if` de casos equivalentes. Cada capa puede ganarle a la
siguiente, y eso es exactamente lo que la hace funcionar:

| # | Capa | Decide |
| --- | --- | --- |
| 1 | Reglas por recurso (`resourceRules`) | `allow` / `cancel` |
| 2 | Allowlists de adblock | `allow` |
| 3 | Reglas site-scoped (con `rule.site`) | `cancel`, **siempre** |
| 4 | Reglas globales (sin `rule.site`) | `cancel`, **salvo dominios auth** |
| 5 | `httpsOnly` | `redirectURL` |
| 6 | `site:allow` del documento | `null` |
| 7 | Documento de Google | `allow` (salvo hosts de anuncios) |
| 8 | Dominio auth | `null` |
| 9 | Permisos de contenido (img/js/audio) | `cancel` |

Se resume en una frase: **los bloqueos ganan, los permisos de contenido no
aplican en Google ni en la cadena OAuth.**

- Las capas 1–5 cortan **antes** de la 9. Una regla de bloqueo del usuario tiene
  que ganarle a un permiso de contenido, porque el bloqueo es la decisión más
  específica.
- Las capas 7 y 8 cortan **también antes** de la 9, y por eso las reglas de
  permisos de contenido de la página no se evalúan en Google ni en un login. En
  Google los recursos de terceros se permiten todos y solo se bloquean los hosts
  de anuncios conocidos; y la cadena OAuth (Google, x.ai, Grok) carga scripts
  alternando entre dominios, así que ahí los permisos de contenido cortarían el
  login.

Lo de las site-scoped frente a las globales también es un contraste a propósito:
las site-scoped aplican **siempre**, las globales no en dominios auth. Una regla
que el usuario puso para un sitio vale también en su página de login.

## Por qué se comparan las URLs sin query string

Muchos sitios —sobre todo los que sirven recursos desde varios subdominios o
CDN— regeneran sus scripts con un parámetro de *cache-busting* distinto en cada
carga. Comparar por URL exacta hacía que una regla «Permitir» guardada una vez
dejara de aplicar en la siguiente carga de la **misma** página, y se veía como si
el permiso no se diera o volviera a bloquearse. Por eso `resourceRules` pasa
siempre por `stripUrlQuery()`.

## El `catch {}` cae a `null`, no a `cancel`

```js
} catch {}
return null;
```

Todo el cuerpo va dentro de un `try` y el fallo devuelve `null`, es decir,
**dejar pasar**. Es lo correcto: este closure corre dentro de un handler de red
de Chromium, donde un `throw` se traduce en una petición colgada. El peor
fallo posible aquí no es bloquear de más, es no bloquear o no cargar.

## `httpsOnly` no toca los hosts locales

`localhost`, `127.0.0.1` y `[::1]` se saltan la redirección a HTTPS. Sin esa
excepción no se podría desarrollar contra un servidor local. También limpia el
puerto 80 explícito al pasar a HTTPS, si no la redirección dejaría un `:80`
colgando.

## Por qué se movió antes que `sessions/`

Porque es lo que las une. `setupExtraSession` necesita el guardián, y si se
hubiera movido primero, `sessions/extra.js` habría tenido que recibirlo por
parámetro: otra inyección temporal que pagar después. Sacando primero la pieza
compartida, el módulo de la sesión extra nace sin inyecciones.
