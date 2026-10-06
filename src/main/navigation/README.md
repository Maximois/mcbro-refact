# src/main/navigation/ — navegación y dominio

Todo lo que decide *a dónde puede saltar* una `webContents`, y el catálogo de
dominios que no se tocan. Sin estado propio salvo `explicit-nav.js`.

```
domains.js        datos puros: AUTH_DOMAINS, isAuthDomain, UAs, baseNavigationDomain
explicit-nav.js   estado: qué navegaciones inició el usuario
transitions.js    veredicto: ¿se permite este salto?
      ↑                  ↑
   (nada)          domains + permissions/adapters
                         + modules/adblocker/main (isVideoHost)
```

`guard.js` (paso 26) vivirá también aquí, pero es otra cosa: decide sobre
*requests* de red, no sobre navegaciones.

## `domains.js` — puro, y testeado

Sin estado, sin Electron, sin CFG. Es el único módulo de `src/main/` que se
puede testear en Node sin Electrón, y por eso tiene `test/navigation-domains.test.js`.

| Export | Qué es |
|---|---|
| `AUTH_DOMAINS` | lista de exenciones (~100 entradas) |
| `isAuthDomain` | predicado: exacto o sufijo **con punto** |
| `isAuthRedirectFlow` | basta con que uno de los dos hosts sea de auth |
| `isAuthPopupUrl` | extrae el hostname de una URL y lo consulta |
| `UA_WHATSAPP` | UA Chrome 140 fijo (lo acepta WhatsApp Web) |
| `PCH_CHROME_MAJOR`, `PERCHANCE_UA` | UA de Perchance, derivada del motor real |
| `MULTI_LABEL_PUBLIC_SUFFIXES`, `baseNavigationDomain` | reduce `a.b.com.mx` → `b.com.mx` |

### Las cuatro trampas

1. **`AUTH_DOMAINS` no es solo "hosts de autenticación".** Incluye sitios de
   contenido completos (youtube, github, x, google, chatgpt) porque necesitan
   excepciones en permisos/navegación. Reducirla para que el adblock aplique en
   ellos se evaluó y se rechazó: rompe la navegación.

2. **La lista se pasa como `allowedDomains` al adblocker**, y ahí hace
   `return callback({ cancel: false })` *antes* de evaluar sus propias reglas.
   O sea: un host de esta lista tiene el adblock completamente desactivado, no
   solo la parte de autenticación.

3. **`isAuthDomain` no usa `endsWith` sin punto.** `normalized.endsWith(domain)`
   daría `true` para `evil-google.com` contra `google.com`. Por eso compara
   exacto o `endsWith('.' + domain)`. Hay dos tests que blinda esto.

4. **`MULTI_LABEL_PUBLIC_SUFFIXES` no es una Public Suffix List.** Son 12
   sufijos compuestos a mano. Si hace falta más cobertura, el sitio correcto es
   la PSL, no ampliar el Set.

### Sobre las UAs

`UA_WHATSAPP` es un Chrome 140 fijo a propósito: es lo que WhatsApp Web acepta.

`PERCHANCE_UA` **no** es fijo: declara la versión del motor real
(`process.versions.chrome`). Declarar un Chrome mayor que el motor hace que la
web sirva features que el motor no soporta, con fallos silenciosos. Fuera de
Electron `process.versions.chrome` no existe y entra el fallback `'124'` — por
eso el módulo es testeable, y por eso el test comprueba el fallback en vez de un
número fijo.

## `explicit-nav.js` — la máquina de estados

Un `Map` de `wcId → { timer }`. Cuatro operaciones:

| Función | Cuándo |
|---|---|
| `markExplicitNavigation(wcId)` | el usuario navigational |
| `keepExplicitNavigationAlive(wcId)` | renueva el margen de 2,5 s |
| `hasExplicitNavigation(wcId)` | consulta |
| `clearExplicitNavigation(wcId)` | limpia ya |

Mientras una `webContents` está en este estado, las reglas anti-redirección no
le cortan la cadena: solo se aplican a auto-redirecciones iniciadas por la página.

### La trampa de `did-navigate`

`did-navigate` se emite cuando la navegación del frame principal se **confirma**,
o sea tras la cadena de redirecciones. Por eso conviene **renovar** el margen en
vez de cortarlo: deja pasar la cadena completa y vuelve a bloquear las
auto-redirecciones posteriores (anuncios) durante el resto de la carga.

Además `did-navigate` puede dispararse en un salto **intermedio** de la cadena en
algunas versiones de Chromium. Limpiar ahí cortaría la protección a mitad de una
cadena legítima muy común (`login.x.com → api.x.com → app.x.com`), y el siguiente
salto de *esa misma* navegación quedaría bloqueado como si fuera ajeno.

`did-fail-load` sí limpia de inmediato: ahí no hay cadena que proteger.

## `transitions.js` — el veredicto

```js
allowNavigationTransition(sourceUrl, targetUrl)
  ├─ ¿el destino es un host de medios o un host de vídeo?  → permite
  ├─ ¿es el mismo sitio?                                    → permite
  ├─ ¿es un sitio de auth o tiene site:allow?               → permite
  └─ cualquier otro salto                                   → bloquea
```

Dos cosas que no hay que "arreglar":

- **El `catch` devuelve `true`.** Si la URL no se puede parsear, se **permite**
  el salto. Es deliberado: un fallo de parseo no debe convertirse en una página
  rota ni en un bucle de navegación bloqueada. Endurecerlo a `false` afecta a
  los 4 call sites.

- **`explicitMediaHosts` se declara dentro de la función**, y se reconstruye en
  cada llamada. Son 24 entradas y el predicado corre en cada `will-redirect`.
  Se movió tal cual para no cambiar el rendimiento observable en una ruta muy
  caliente. Subirlo a nivel de módulo es un commit con su propia justificación.

El orden importa: el adblocker decide *primero* (`isAggressiveAdNavigation`,
`isExplicitlyBlocked`) y solo después se consulta este módulo.

## Lo que NO se movió

`isPerchanceHost` e `isPerchanceRuntimeHost` siguen en `main.js`. Son predicados
del panel de Perchance, no de navegación en general, y viajan con
`perchance/panel.js` (paso 27). El segundo es **código muerto**: devuelve `false`
siempre, a propósito, y su comentario explica por qué filtrar el panel por
dominio rompe Cloudflare/Turnstile.