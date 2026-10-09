# Editor de documentos (PDF, DOCX, TXT, Markdown)

Módulo independiente para abrir, editar y reexportar documentos dentro de MC
Browser. PDF y DOCX no se editan página a página: se convierten a un modelo
canónico de bloques, se edita eso y se vuelve a exportar.

## Qué abre

| Formato | Lectura | Guardado en el sitio | Exportación |
|---|---|---|---|
| PDF | texto y estructura por geometría | no (se guarda como DOCX/TXT/PDF nuevo) | PDF, DOCX, TXT, MD |
| DOCX | OOXML completo: runs, tablas, listas, imágenes, metadatos | sí | PDF, DOCX, TXT, MD |
| TXT | texto plano | sí | PDF, DOCX, TXT, MD |
| Markdown | estructura por marcas | sí | PDF, DOCX, TXT, MD |

Un PDF no se puede "guardar en el sitio" porque escribir sobre el original
destruiría el archivo sin forma de recuperar la maquetación: el editor fuerza
"Guardar como" y genera un archivo nuevo.

## Cómo se usa

El editor es una **pestaña del navegador** (`mc://doc`), no una ventana
superpuesta: la barra de direcciones, las pestañas y la barra lateral siguen
visibles y en su lugar normal.

- Botón de documento en la barra lateral izquierda, o **Ctrl+Shift+D**, abre la
  pestaña (y la enfoca si ya estaba abierta, sin duplicarla).
- **Ctrl+S** guarda, **Ctrl+O** abre, **Esc** cierra la pestaña.
- **Ctrl+Z** deshace, **Ctrl+Y** o **Ctrl+Shift+Z** rehace, y **Ctrl+F** busca/reemplaza.
- El botón `×` de la pestaña y **Ctrl+W** la cierran como cualquier otra.
- Clic en un bloque y Enter crea el bloque siguiente.
- Backspace al principio de un bloque lo fusiona con el anterior.
- La cinta superior da formato al bloque seleccionado, cambia su orden o lo elimina.
- Deshacer incluye cambios del usuario y parches de la IA (hasta 100 pasos).
- Pestaña **Páginas** muestra el PDF original renderizado (hasta 60 páginas);
  **Contenido** muestra el texto editable.
- Si el usuario abre un `.pdf`/`.docx`/`.txt`/`.md` haciendo doble clic (o con
  "Abrir con"), el editor aparece solo en esa pestaña.

## Arquitectura

```
core/          puro, sin Electron ni DOM. Testeable con node --test.
  model.js       modelo canónico, hash, outline, texto plano, Markdown
  patch.js       parches atómicos con expectedHash
  pdf-text.js    extracción PDF por geometría de pdf.js
  docx-read.js   DOCX -> bloques
  docx-write.js  bloques -> OOXML
  zip.js         lector/escritor ZIP (métodos 0 y 8, CompressionStream)
  xml.js         parser XML tolerante a namespaces
  html.js        bloques -> HTML para preview y para printToPDF
  runs.js        formato en línea: álgebra de tramos (aplicar, partir, unir)
  dom-runs.js    lee un nodo del DOM y devuelve sus tramos (sin globals: se prueba con jsdom)
  text-io.js     TXT/Markdown -> bloques y viceversa
main.js        dueño del archivo: lecturas, escrituras, diálogos, backups,
               recientes, sandbox y export a PDF (printToPDF)
worker.js      extracción PDF/DOCX en un worker_threads
renderer.js    pestaña mc://doc: UI, edición de bloques y render de páginas
vendor/        pdfjs-dist 3.11.174 legacy (Apache-2.0)
```

El **main** es dueño del documento. El renderer y la IA mandan los mismos
parches sobre el mismo hash: no hay dos caminos que puedan pisarse.

La pestaña se apoya en tres enganches en `src/renderer.html`: el panel
`#panel-doc` con su `#doc-host`, y dos ramas que reconhecen `mc://doc`
(`showWebview()` y `loadUrl()`), igual que `mc://newtab` y `mc://lab`.

## Cómo se prueba

```
npm test                                  # nucleo (node --test)
node tools/doc-editor-smoke.js            # main con stub de Electron
node tools/doc-editor-worker.js           # worker con archivos reales
npx electron tools/doc-editor-tab-smoke.js --pdf "C:\ruta\a\algo.pdf"
```

El último abre la UI real y el preload real dentro de Electron y comprueba que
el editor aparece como pestaña (y no como modal), que TXT/DOCX/MD se abren, que
una edición llega a main por `doc:edit`, que el PDF se pinta con pdf.js y que
`printToPDF` genera un PDF válido.

## Reglas de la IA

La IA edita con parches atómicos, nunca reescribiendo el documento:

```doc:read
```

Trae el texto y el **hash** actual. Después:

````
```doc:patch
{ "expectedHash": "<hash del doc:read>", "ops": [
  { "op": "replace", "find": "texto exacto", "replace": "texto nuevo" },
  { "op": "insert", "after": "ancla", "block": { "type": "paragraph", "text": "..." } },
  { "op": "style", "find": "texto", "bold": true, "color": "#c00000" },
  { "op": "setTitle", "title": "..." }
] }
```
````

`style` aplica formato SOLO al texto encontrado y respeta el que ya tenía el
párrafo (no lo aplana). Propiedades: `bold`, `italic`, `underline`, `strike`
(true/false; `false` quita la propiedad en ese tramo, incluso en un título que
es negrita por estilo), `color` y `highlight` (`#rrggbb`), `font` (nombre de
familia, p. ej. `"Georgia"`) y `size` (puntos).

Si el parche vuelve con error de hash obsoleto, el documento cambió: hay que
volver a `doc:read`. Si falla una operación, se descarta el parche entero.

## Formato en línea

El formato dentro de un párrafo vive en `runs` (`{ text, bold, italic,
underline, strike, color, highlight, font, size }`). Tres piezas, todas puras
y con tests:

- `core/runs.js`: álgebra de tramos (aplicar formato a un rango, partir, unir,
  alternar, compactar). La usan los parches de la IA y el renderer.
- `core/dom-runs.js`: lee un nodo del DOM y devuelve sus tramos. Interpreta el
  marcado (`b`, `i`, `u`, `s` y el `style` en línea que genera `execCommand`),
  no el estilo calculado, así que un título en negrita por CSS no se confunde
  con negrita de tramo.
- `core/model.js`: `normalizeRun` valida cada propiedad (color `#hex`, fuente
  solo letras/números/espacios) y descarta los `false` redundantes.

Mientras se escribe, **el DOM es la verdad**: el formato se aplica con
`execCommand` sobre la selección real y, al confirmar el bloque, se lee con
`dom-runs`. Antes los tramos se reproyectaban por posición y un cambio de
largo borraba TODO el formato del párrafo; Enter y Backspace tampoco lo
conservaban. Ahora Enter parte el párrafo con el formato de cada mitad y
Backspace al inicio lo une con el anterior.

Un `false` explícito significa "este tramo NO lleva esa propiedad aunque el
bloque la traiga por defecto". En DOCX se escribe `w:val="0"`.

Límites actuales: el formato en línea solo existe en párrafos, títulos y citas
(las listas y las celdas de tabla siguen siendo texto plano con formato de
bloque). La fuente `Calibri` no se guarda en los tramos porque es la que el
escritor DOCX pone por defecto.

## Tablas e imágenes

UI (barra de formato, grupo *Insertar*):
- **▦ Tabla**: selector de tamaño (hasta 8×6; el modelo admite 100 filas × 20 columnas). Se inserta tras el bloque seleccionado, o al final.
- Con una tabla seleccionada aparece la barra de objeto: `+ Fila ↑/↓`, `− Fila`, `+ Col ←/→`, `− Col`, `Encabezado`. Las filas/columnas son relativas a la **celda con foco**; lo escrito y sin confirmar se guarda antes de operar.
- **🖼 Imagen**: selector de archivo, pegar desde el portapapeles o arrastrar un archivo al documento. PNG/JPG/GIF/WebP/SVG/BMP, máx. 8 MB; se reduce para caber en el ancho de página. Con la imagen seleccionada: asa en la esquina (conserva proporción), ancho en px, atajos 25/50/75/100 % y texto alternativo.

Núcleo puro: `core/tables.js` (`create`, `addRow`, `deleteRow`, `addCol`, `deleteCol`, `setHeader`, `setCell`, `resizeImage`, `fitWidth`, `setAlt`). Devuelven bloques nuevos o `null`.

Operaciones de parche para la IA:
```json
{ "op":"table", "id":"b5", "action":"addRow|deleteRow|addCol|deleteCol", "index":1, "where":"before|after" }
{ "op":"table", "id":"b5", "action":"setHeader", "value":true }
{ "op":"table", "id":"b5", "action":"setCell", "row":0, "col":1, "text":"..." }
{ "op":"image", "id":"b8", "width":320, "alt":"descripcion" }   // el otro lado sale de la proporción
```
Notas: `header:false` ahora se guarda explícito (antes un `false` se perdía y la primera fila volvía a ser encabezado). Al guardar como DOCX y reabrir, la primera fila se vuelve a leer como encabezado: es una limitación conocida de docx-read. Se corrigió además que `core/html.js` emitía las dimensiones de imagen sin `style=""`, por lo que el tamaño no llegaba al PDF/HTML.

## Página, párrafo y enlaces

UI: **📄 Página** (orientación, papel A4/Carta/Legal/A5, márgenes normal/estrecho/ancho, encabezado, pie y número de página), **Interlineado**, sangría ⇤¶ / ¶⇥, **🔗 Enlace** (sobre el texto seleccionado; vacío = quitar; solo http, https y mailto) y **zoom** 50–200 %. La hoja del editor dibuja márgenes por lado, encabezado, pie y número.

Núcleo puro: `core/pagesetup.js` (`setOrientation`, `setPaper`, `setMargins`, `setHeaderFooter`, `apply`). Parche para la IA:
```json
{ "op":"page", "orientation":"landscape", "paper":"LETTER", "margin":"narrow" | 56, "marginTop":40,
  "header":"texto", "footer":"texto", "pageNumbers":"left|center|right|none" }
{ "op":"style", "find":"texto", "lineHeight":1.5, "indent":1, "link":"https://..." }   // link:false lo quita
```
Exportación: el DOCX escribe y lee márgenes por lado, orientación, encabezado/pie con campo PAGE, interlineado y enlaces (relaciones externas). El PDF ahora respeta el `@page` del documento (antes forzaba A4 con márgenes fijos) y pide encabezado/pie/numeración a Chromium (`core/html.js: pdfHeaderFooter`). **Verificar a mano en la app**: el PDF con encabezado y pie, porque `printToPDF` no se puede ejercitar en los tests.

Diálogos: no se usan `confirm/prompt/alert` nativos (en Electron/Windows dejaban la página sin foco al cerrarse); hay un diálogo propio (`modal`), y borrar un bloque ofrece *Deshacer* en vez de preguntar.

## Seguridad

- Solo se tocan archivos concedidos: los que el usuario eligió con un diálogo,
  los que abrió el sistema operativo con la app, o los del sandbox.
- Nada se sobrescribe sin dejar copia en `userData/doc-editor/backups/`.
- La escritura es atómica (temporal + rename).
- Las imágenes del modelo solo se aceptan como `data:`.
- Límites: 100 MB por archivo, 2000 páginas, 5000 bloques, 200 operaciones
  por parche.

## Limitaciones

- La extracción de PDF es heurística. No hay OCR: un PDF escaneado como
  imagen sale vacío, y el editor lo avisa. Las tablas en PDF no se detectan
  como tablas (salen como líneas de texto).
- No se conservan los estilos de página del PDF original: al exportar se
  reconstruye con CSS de impresión A4.
- La escritura a PDF usa `printToPDF`, así que el resultado se parece al modelo,
  no al archivo original.

## Herramientas de prueba

```
node --test test/document-editor.test.js   # núcleo, parches, DOCX, PDF
node --test test/document-inline-format.test.js     # formato en línea (tramos, DOCX, lector del DOM)
node --test test/document-editor-renderer.test.js   # renderer real en jsdom (Enter, Backspace, formato)
node tools/doc-editor-smoke.js             # main con stub de Electron
node tools/doc-editor-worker.js            # worker real de extracción
node tools/docx-smoke.js                   # round-trip DOCX
node tools/pdf-smoke.js <archivo.pdf>      # extracción PDF real
```

`doc-editor-smoke.js` intercepta `require('electron')` con un stub, así que
corre fuera de la app. La exportación a PDF necesita una ventana real y solo
se prueba a mano dentro de Electron.