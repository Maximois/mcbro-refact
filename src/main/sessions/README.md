# `src/main/sessions/`

Identidad de las sesiones: qué partición es cada cosa, qué predicado responde
"¿este `webContents` es de la sesión principal?" y qué canales las limpian.

| Archivo | Qué hay |
| --- | --- |
| `partitions.js` | Los nombres de partición y los predicados de pertenencia. |
| `extra.js` | Sesión aislada con almacenamiento propio. **Sí** lleva reglas globales. |
| `webchat.js` | Chats de IA. Allow-all de permisos, sin reglas de request. |
| `whatsapp.js` | WhatsApp Web: permisos de notifications y Client Hints de Chrome. |
| `ipc.js` | `sessions:*` y `clear-*`. Ver "La limpieza es global" más abajo. |

`setup.js` no aparece en la tabla porque no existe, y no va a existir. La tabla
de "reglas globales / descargas / UA" más abajo explica por qué un módulo
común habría fingido un modelo que no está.

## `ipc.js`: por qué export/import se quedaron fuera

Los canales `export-session` e `import-session` también son de sesión, pero
siguen en `bootstrap.js`, no aquí. Necesitan `DATA_DIR`, y el paso 28 dejó ese
bloque (y `DATA_DIR`) dentro de `bootstrap.js`: el módulo dueño existe y es el
arranque del proceso, así que export/import no tienen que moverse. Hacerlo
obligaría a exportar ese dato y a que la ruta de datos viviera en dos sitios,
que es justo lo que rompió el paso 1 (ver `docs/RESTRUCTURACION.md` 2.5).

## La limpieza es global, y por eso parece un bug

Ninguno de los handlers de `ipc.js` usa `event.sender.session`. El botón
"limpiar cookies" del panel WebChat tiene que borrar **las de WebChat**, no las
de la pestaña desde la que se pulsó.

El síntoma de romper esto es malo: no lanza nada, no sale ningún error, el
`boot-smoke` sigue en verde. Solo borra las cookies de otro sitio. Por eso hay
un test que prohíbe `sender.session` en el módulo entero, y no un test por
handler.

Lo mismo con `mainSession()`: es `session.fromPartition('persist:mc')` y **no**
`session.defaultSession`. El usuario tiene varias sesiones aisladas que nunca
comparten cookies; `defaultSession` solo corresponde a las ventanas sin
`partition` propio, así que usarla vaciaría la principal y dejaría intactas las
demás. El literal se escribe a mano aquí y en `main.js` a propósito: unificarlo
es un commit propio (punto 5.15 del plan) que no se mezcla con una extracción.

## Por qué `partitions.js` se escribió primero

Porque los tres setups dependían de cosas locales de `main.js`
(`registerNativeDownloadHandler` y `createRequestGuard`), y mientras esas no
tuvieran módulo, `extra.js` las habría recibido por parámetro. `partitions.js`
solo depende de `electron.session` y de `CFG`, así que se podía escribir sin
inyectar nada.

## Lo que desbloquea: dos inyecciones con fecha de caducidad

| Módulo | Antes | Ahora |
| --- | --- | --- |
| `net/cookie-guard.js` | `refreshCookieGuards(esAplicable)` | `refreshCookieGuards()` |
| `net/proxy.js` | `setProxy(settings, { webchat, whatsapp })` | `setProxy(settings)` |

La primera vez que se hicieron, la inyección parecía la solución obvia: el
módulo todavía no existía, y hacer `require` de algo inexistente revienta al
arrancar. Pero una inyección sin fecha de caducidad se convierte en deuda:
nadie se atreve a borrarla. Así que se anotó desde el día uno que era temporal,
con la referencia al paso que la resolvía, y este commit la cierra.

**Criterio para lo que queda:** si un módulo necesita algo de un módulo que
todavía no existe, la inyección lleva un comentario que diga que es temporal y
el número de paso que la resuelve. Si no hay paso que la resuelva, no es una
inyección: es un error de orden.

## El `require` del adblocker va en un `try`, y por eso necesita un test

```js
try {
  const m = require('../../../modules/adblocker/main');   // TRES niveles
} catch (e) {
  console.error('[ADBLOCK][session]', e.message);
}
```

Ese `try` no es opcional: si `modules/adblocker` no estuviera, la sesión extra
no arrancaría y con ella todas las sesiones guardadas. Pero tiene un coste que
no se ve: **el `catch` se traga el fallo**.

Ocurrió. La ruta se escribió con dos niveles (`../../modules/`) en lugar de
tres, `modules/` está en la raíz del repo y el archivo vive en
`src/main/sessions/`. Resultado: la sesión extra se quedaba **sin adblocker**,
sin un error visible, y `tools/boot-smoke.js` daba verde igual, porque un fallo
que se traga el `catch` no hace fallar nada.

Por eso `test/sessions-setups.test.js` no comprueba que no haya error, sino algo
más fuerte: que **todo `require()` relativo de los módulos nuevos apunte a
un archivo que existe**. Es un test que se puede engañar menos que el arranque,
porque no depende de que el fallo llegue a propagarse.

## Los predicados devuelven `false`, nunca lanzan

```js
function isMainBrowsingSession(wc) {
  try { return wc?.session === session.fromPartition('persist:mc'); } catch { return false; }
}
```

El `try` no es paranoia. `session.fromPartition()` puede lanzar con una
partición inválida o durante el apagado, y estos predicados corren dentro de
handlers de permisos, de `webRequest` y de `app.on('web-contents-created')`,
donde un `throw` se come el evento entero y no deja rastro.

`false` es la respuesta conservadora en los dos casos:

- `isMainBrowsingSession` → no es la principal, no se le da trato especial.
- `esWebviewProtegido` → no se le instala el cookie guard. Aquí un `throw` sería
  además el peor de los fallos posibles: rompería la política de cookies de
  todas las sesiones sin que nadie se entere.

## `'persist:mc'` sigue escrito a mano, a propósito

La partición principal aparece literal en `main.js` (ventana, descargas,
cookies, permisos) y también dentro de `partitions.js`. Se podría exportar como
`MAIN_PARTITION`, pero **no se hizo**: son más de diez referencias, y tocarlas
todas en el mismo commit que mueve el módulo mezcla dos cosas.

Cuando se unifique, que sea su propio commit, con su test de paridad de strings.
Lo que este módulo sí garantiza es que **las comparaciones de sesión usan
siempre la misma función**, no una expresión distinta por sitio.

## Cómo se importa: namespace, con dos excepciones

Los módulos de función se cargan con namespace y se llaman cualificados, igual
que `main.js`:

```js
const Proxy = require('../net/proxy');
const Sessions = require('./partitions');
Sessions.WEBCHAT_PARTITION
Proxy.applyProxyFromCfg(wchSess, '[webchat]')
```

No es una cuestión de gusto. Un destructuring plano
(`const { applyProxyFromCfg } = require(...)`) esconde de dónde viene cada
símbolo, y el prefijo además convierte un `undefined` silencioso en un
`TypeError` con nombre: sin prefijo, importar mal produce `undefined` y el
fallo aparece al arrancar; con prefijo, en la línea de la llamada.

Las dos excepciones son `config` y `runtime`, y están justificadas:

- **`config`**: `loadCfg()` corre *dentro* de `config/index.js` al requerirlo, así
  que `CFG` ya viene fusionado con `cfg.json` cuando termina el `require`.
  Destructurarlo es seguro. Ver el punto 2.1 del plan (el require original
   estaba en `main.js:12-17`).
- **`runtime`**: `mainWin` se asigna tarde, así que se accede por
  `getMainWin()`; lo que sí se destructura son las funciones, que no se
  reasignan. `ACTIONS` es un objeto que se muta, y la mutación se ve igual a
  través de la referencia.

`electron` también va destructurado, porque no es código nuestro.

`ipc.js` sigue la convención con una consecuencia que conviene ver: el historial
se toca como `HistoryStore.store.items` y `HistoryStore.save()`, no
desestructurado. El store se reasigna al guardar, así que un `store` capturado
en el `require` quedaría viejo justo en `clear-data` y `clear-all`, que son los
dos sitios donde importa.

`test/sessions-setups.test.js` comprueba la convención en los módulos nuevos, así
que no depende de que alguien la recuerde al escribir el siguiente.

## Nota sobre los tests de ausencia

En este repo hay tres test que buscan "esto no aparece", y los tres han fallado
a la primera porque el nombre buscado estaba en el JSDoc del propio módulo, que
explica precisamente por qué la cosa sigue así:

- `fromPartition` en `net/headers.test.js`
- `WEBCHAT_PARTITION` en `net-proxy.test.js`
- `MAIN_PARTITION` en `sessions-partitions.test.js`

La convención queda fijada: **las aserciones de ausencia van contra `codigo`
(el módulo desde el primer `*/`), nunca contra el archivo entero.** Un JSDoc
explica, y explicar es lo contrario de estar ausente.

## Nota: `sessions/setup.js` no va a existir como tal

El plan original pedía `sessions/partitions.js` **y** `sessions/setup.js`. La
segunda mitad se ha deshecho en favor de un módulo por tipo de sesión
(`extra.js`, `webchat.js`, `whatsapp.js`), y el motivo está en lo que hacen, no
en cuánto pesan:

| | reglas globales | descargas | UA / Client Hints |
| --- | --- | --- | --- |
| principal | sí | sí | no |
| extra | **sí**, paridad total | sí | no |
| WebChat | no, allow-all | no | no |
| WhatsApp | no | no | **sí** |

Una sesión extra es la principal con otro almacenamiento. WebChat y WhatsApp son
**excepciones**, no variantes: no comparten casi nada con la principal ni entre
sí. Un `setup.js` con tres funciones intercambiables habría fingido un modelo
común que no existe.

## Criterio que se aplicó al partirlo

Mover cada setup exige que **todas** sus dependencias tengan dueño. Por eso el
orden fue:

1. `net/request-guard.js` — la lógica de reglas globales que comparten main y
   extra. Sin esto, `extra.js` la habría recibido por parámetro.
2. `downloads/native.js` — `registerNativeDownloadHandler` con su
   `nativeDlRegistry` y su `pendingNativeRetryId`. Sin esto, `extra.js` lo
   habría recibido por parámetro.
3. `extra.js`, `webchat.js`, `whatsapp.js` — y entonces ya no hay nada que
   inyectar.

Cada paso se comprobó con lo mismo: ningún call site quedó sin cualificar, la
suite siguió en verde y `tools/boot-smoke.js` arrancó la ventana anfitriona.

Los call sites de proxy y de descargas nativas quedaron ahora repartidos entre
`main.js` y los módulos, así que los tests que los contaban (contando solo en
`main.js`) se ajustaron para sumar las fuentes: dos llamadas de
`registerNativeDownloadHandler` y cuatro de `applyProxyFromCfg`. El test cuenta
en todas las fuentes a propósito, para que un quinto call site en el sitio
equivocado se vea en el recuento y no en producción.
