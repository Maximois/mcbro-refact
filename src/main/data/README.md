# `src/main/data`

Persistencia de los dos datos que el navegador guarda como archivo plano:
**marcadores** (`bookmarks.json`) e **historial** (`history.json`).

Extraído de `main.js` en el commit "Extraer persistencia de marcadores e
historial". Movimiento puro: no se cambió lógica.

## Responsabilidad

- Definir la ruta de cada archivo en `userData`.
- Cargar al arrancar el módulo y guardar cuando el IPC lo pida.
- Exponer el array vivo para que los handlers lo muten.

## Qué NO debe hacer

- **No registra IPC.** Los handlers (`bookmarks:*`, `history:*`) siguen en
  `main.js` por ahora y se moverán a `src/main/ipc/` más adelante.
- **No normaliza URLs, no deduplica y no busca favicons.** Eso vive en el
  renderer.

## El detalle que importa: `store.items`, no `items`

Los dos arrays **se reasignan en caliente**, no solo se mutan:

| Operación | Reasignación |
| --- | --- |
| `bookmarks:remove` | `BOOKMARKS = BOOKMARKS.filter(...)` |
| `history:clear` | `HISTORY = []` |
| `history:add` al pasar el tope | `HISTORY = HISTORY.slice(-2000)` |
| `clear-all` / `clear-data` con `settings.history` | `HISTORY = []` |

CommonJS **no propaga la reasignación de un `export let`**. Y
`const { items } = require('./history')` capturaría el array del momento del
require: después de un `history:clear` ese importador seguiría viendo —y
persistiendo— el historial viejo. Es el modo de fallo silencioso más caro que
hay en esta carpeta: no da error, da resurrectores de datos, que es
exactamente el síntoma que ya se documentó en el pasado
(`docs/GUIA-PARA-COLABORADORES.md` §5.4, "datos que volvían").

Por eso el estado vive en un objeto contenedor y se reasigna por propiedad:

```js
const { store } = require('./src/main/data/history');

store.items = [];        // correcto: todos lo ven
store.items.push(entry); // correcto: muta en sitio
const copia = store.items; copia.length = 0;  // NUNCA — solo vacias la copia
```

**Regla para cualquier importador:** acceso siempre por `store.items`, y
escritura siempre `store.items = ...`. Nunca destructures `items`.

## Trampas

### La ruta se calcula AL CARGARSE, y eso ata las manos al orden de main.js

`BOOKMARKS_PATH` e `HISTORY_PATH` se calculan en el cuerpo del modulo:

```js
const HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');
```

Es decir: en el `require`, no cuando se usa. Por eso `main.js` tiene que haber
llamado a `app.setPath('userData', ...)` ANTES de requerirlos, y por eso el
`setPath` esta en las lineas 27-28, antes de cualquier require de proyecto.

Cuando se extrajeron estos modulos se dejaron despues del `setPath` y la app
resolvio a la carpeta por defecto durante semanas: abria con el historial vacio y
sin marcadores, sin fallar nunca. `config/index.js` tenia el mismo problema.

Lo que lo fija ahora:

- `test/data-paths.test.js` comprueba el orden en el fuente.
- `tools/boot-smoke.js` comprueba las rutas en ejecucion, con la linea `[DATA]`
  que imprime `main.js`.

Si alguna vez hay que calcular la ruta mas tarde (por ejemplo para que el test
pueda requerir el modulo sin Electron), hay que quitar a la vez las dos
comprobaciones. Si se queda una y se cae la otra, el bug vuelve sin avisar.

### El tope de 2000 esta escrito en tres sitios

`HISTORY_LIMIT` se aplica al cargar (`stored.slice(-LIMIT)`), al guardar
(`store.items.slice(-LIMIT)`) y al añadir
(`if (items.length > LIMIT) items = items.slice(-LIMIT)`). Son tres
redundancias que hoy se cuadran. Si se cambia el tope hay que cambiar los tres,
o se recorta en un punto y se re-expande en otro al siguiente guardado.

En `bookmarks.js` **no hay tope**: la lista crece sin límite. No es una
omisión inyectada, es como está; si algún día el usuario reporta lentitud con
miles de marcadores, ahí está la explicación.

### La deduplicación del historial solo mira la última entrada

`history:add` compara contra `HISTORY[HISTORY.length - 1]` y descarta si la URL
coincide. No busca en toda la lista: navegar A → B → A guarda **dos** entradas
de A. Además la comparación es de URL **exacta**, sin normalizar (sin quitar
parámetros ni fragmento), así que `articulo?utm_source=x` y `articulo` cuentan
como visitas distintas. El truncado por `title` a 500 caracteres es lo único que
se sanea.

### `load()` no valida la forma del dato

`bookmarks.js` asigna lo que haya en el archivo a `store.items` sin comprobar
que sea un array (`history.js` sí lo comprueba con `Array.isArray`). Un
`bookmarks.json` corrupto o escrito a mano deja `store.items` como lo que sea, y
`BOOKMARKS.unshift(...)` de `bookmarks:add` lanza dentro del handler. Además
`load()` corre **fuera** de `try/catch` al final del módulo... no, está
**dentro**: el `try` cubre el `JSON.parse` y la asignación. El riesgo real es
el siguiente arranque, no este: el error se traga con `console.error` y la app
sigue con el array inválido en memoria.

### Se escribe en cada operación, sin cola

`save()` es `writeFileSync`, sin debounce. `bookmarks:reorder` llama a `save()`
por cada reordenación. Con una lista grande, reordenar arrastrando escribe el
archivo entero en cada paso del ratón. No cambiar a asíncrono sin revisar el
`app.on('window-all-closed')`, que también fuerza un guardado final.