'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const leer = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const MAIN = leer('main.js');
const NATIVE = leer('src', 'main', 'downloads', 'native.js');
const EXTRA = leer('src', 'main', 'sessions', 'extra.js');
const WEBCHAT = leer('src', 'main', 'sessions', 'webchat.js');
const WHATSAPP = leer('src', 'main', 'sessions', 'whatsapp.js');
const IPC = leer('src', 'main', 'sessions', 'ipc.js');
const MODULOS = { extra: EXTRA, webchat: WEBCHAT, whatsapp: WHATSAPP };
// Claves relativas a src/main/, que es desde donde se resuelve cada require.
const RUTAS = {
  'downloads/native.js': NATIVE,
  'sessions/extra.js': EXTRA,
  'sessions/webchat.js': WEBCHAT,
  'sessions/whatsapp.js': WHATSAPP,
  'sessions/ipc.js': IPC,
};

// Los tres modulos tienen JSDoc que nombra los simbolos que los demas deben
// seguir sin usar, asi que las ausencias se buscan tras el primer */.
const codigo = (s) => s.slice(s.indexOf('*/') + 2);
const CUERPO = Object.fromEntries(Object.entries(MODULOS).map(([k, v]) => [k, codigo(v)]));

describe('sessions/* — las tres sesiones son tres politicas distintas', () => {
  // Esta es la asercion que resume el paso 13. El usuario distingue las sesiones
  // por si llevan reglas globales, y eso no es un detalle: es lo que hace que
  // una sesion sea utilizable. Si los tres modulos reciben las mismas reglas,
  // la distincion desaparece aunque el codigo sea "correcto".
  test('solo Extra lleva reglas globales de request', () => {
    assert.match(CUERPO.extra, /modules\/adblocker\/main/);
    assert.match(CUERPO.extra, /createRequestGuard\(\)/);

    assert.doesNotMatch(CUERPO.webchat, /modules\/adblocker\/main/);
    assert.doesNotMatch(CUERPO.webchat, /createRequestGuard/);

    assert.doesNotMatch(CUERPO.whatsapp, /modules\/adblocker\/main/);
    assert.doesNotMatch(CUERPO.whatsapp, /createRequestGuard/);
  });

  test('WebChat y WhatsApp no heredan permisos granulares; Extra si', () => {
    // Extra hereda los del navegador principal.
    assert.match(CUERPO.extra, /setupSessionPermissionHandlers\(sess\)/);
    // WhatsApp los usa, pero solo para la entrada de notifications de arriba.
    assert.match(CUERPO.whatsapp, /setupSessionPermissionHandlers\(waSess\)/);
    // WebChat los sustituye por allow-all: no los llama.
    assert.doesNotMatch(CUERPO.webchat, /setupSessionPermissionHandlers/);
    assert.match(CUERPO.webchat, /setPermissionRequestHandler\(\(_webContents, _permission, callback\) => callback\(true\)\)/);
    assert.match(CUERPO.webchat, /setPermissionCheckHandler\(\(\) => true\)/);
  });

  test('el allow-all de WebChat necesita los DOS handlers', () => {
    // Con solo el request handler, una pagina sigue PODIENDO permisos aunque se
    // le negara la peticion. El check handler es lo que cierra el hueco.
    assert.match(CUERPO.webchat, /setPermissionRequestHandler/);
    assert.match(CUERPO.webchat, /setPermissionCheckHandler/);
  });

  test('las tres conservan el proxy, con su etiqueta', () => {
    // El proxy lo configuro el usuario para TODA la app. Saltarselo en un
    // panel visible seria una sorpresa, y por eso es la unica regla comun.
    assert.match(CUERPO.extra, /applyProxyFromCfg\(sess, '\[session\]'\)/);
    assert.match(CUERPO.webchat, /applyProxyFromCfg\(wchSess, '\[webchat\]'\)/);
    assert.match(CUERPO.whatsapp, /applyProxyFromCfg\(waSess, '\[whatsapp\]'\)/);
    for (const [k, c] of Object.entries(CUERPO)) {
      assert.doesNotMatch(c, /CFG\.proxyEnabled && CFG\.proxyHost/, `${k} no debe reimplementar el guard`);
    }
  });

  test('cada modulo usa la particion que le toca', () => {
    assert.match(CUERPO.webchat, /session\.fromPartition\(Sessions\.WEBCHAT_PARTITION\)/);
    assert.match(CUERPO.whatsapp, /session\.fromPartition\(Sessions\.WHATSAPP_PARTITION\)/);
    // Extra recibe la sesion ya construida: la particion la elige quien la crea.
    assert.doesNotMatch(CUERPO.extra, /session\.fromPartition/);
    assert.match(CUERPO.extra, /function setupExtraSession\(sess\)/);
  });
});

describe('sessions/extra.js — paridad con la sesion principal', () => {
  // El comentario del modulo decia que antes iban en null. Este test es el que
  // impide que vuelvan a irse: una sesion extra sin Stream Hunter ni stats
  // pareceria funcionar hasta que el usuario sierra la pestana.
  test('las cuatro callbacks del adblocker siguen conectadas', () => {
    assert.match(CUERPO.extra, /mediaCallback: MediaDetect\.checkMedia/);
    assert.match(CUERPO.extra, /blockCallback: StatsTracker\.recordBlockedRequest/);
    assert.match(CUERPO.extra, /requestCallback: StatsTracker\.recordObservedRequest/);
    assert.match(CUERPO.extra, /requestGuard: RequestGuard\.createRequestGuard\(\)/);
  });

  test('el guardian se crea por sesion, no se comparte entre sesiones', () => {
    // Si se creara una vez a nivel de modulo y se pasara, el estado interno del
    // guardian (si lo tuviera) se cruzaria entre sesiones.
    assert.match(CUERPO.extra, /createRequestGuard\(\)/);
    assert.doesNotMatch(codigo(EXTRA), /^const \w*guard\w* = createRequestGuard/m);
  });

  test('emit esta vacio a proposito: la sesion extra no habla con el renderer', () => {
    assert.match(CUERPO.extra, /emit: \(\) => \{\}/);
  });

  // Los modulos de funcion se importan con namespace, como en main.js. No es
  // estetica: un destructuring plano esconde de donde viene cada simbolo, y en
  // un archivo que se reordena cada cierto tiempo eso es justo lo que hace
  // falta leer. La excepcion son config y runtime, y estan documentadas:
  // loadCfg() corre dentro de config/index.js al requerirlo, y mainWin se
  // asigna tarde (se accede por getMainWin()).
  test('los modulos de funcion se importan con namespace, no a pelo', () => {
    const FUNCION = ['permissions/handlers', 'permissions/adapters', 'permissions/entries',
      'net/proxy', 'net/request-guard', 'net/cookie-guard', 'stats/tracker',
      'stats/media-detect', 'navigation/domains', 'downloads/native', './partitions'];
    for (const [rel, fuente] of Object.entries(RUTAS)) {
      const dir = path.join('src', 'main', path.dirname(rel));
      for (const req of FUNCION) {
        const linea = new RegExp(`^const \\{[^}]*\\} = require\\('\\.\\.?/?[^']*${req.replace(/[/.]/g, '\\$&')}'\\);`, 'm');
        assert.doesNotMatch(fuente, linea, `${rel} destructuring en vez de namespace: ${req}`);
      }
      // Y el electron se destructuring si, porque no es codigo nuestro.
      assert.doesNotMatch(fuente, /^const \w+ = require\('electron'\);$/m, `${rel} importa electron con namespace`);
    }
  });

  test('el fallo del adblocker no tumba la sesion', () => {
    assert.match(CUERPO.extra, /catch \(e\) \{\s*console\.error\('\[ADBLOCK\]\[session\]'/);
  });

  test('captura descargas nativas, como la principal', () => {
    assert.match(CUERPO.extra, /registerNativeDownloadHandler\(sess\);/);
  });

  test('el orden es permisos -> proxy -> adblocker -> descargas', () => {
    // El proxy tiene que estar puesto antes de que el adblocker registre sus
    // handlers de webRequest sobre la misma sesion.
    const iPerm = CUERPO.extra.indexOf('setupSessionPermissionHandlers(sess)');
    const iProxy = CUERPO.extra.indexOf("applyProxyFromCfg(sess, '[session]')");
    const iAd = CUERPO.extra.indexOf('modules/adblocker/main');
    const iDl = CUERPO.extra.indexOf('registerNativeDownloadHandler(sess)');
    assert.ok(iPerm < iProxy, 'permisos antes que proxy');
    assert.ok(iProxy < iAd, 'proxy antes que adblocker');
    assert.ok(iAd < iDl, 'adblocker antes que descargas');
  });
});

describe('sessions/whatsapp.js — el Client Hints que se hace pasar por Chrome', () => {
  test('la entrada de notifications se escribe ANTES de aplicar los permisos', () => {
    // Al reves, el handler leeria la tabla antes de que exista la entrada y
    // resolveria la peticion con la regla anterior (o por defecto).
    const iCheck = WHATSAPP.indexOf("PermissionsAdapters.getPermissionRuleForHost('web.whatsapp.com', 'notifications')");
    const iSet = WHATSAPP.indexOf("PermissionsEntries.setPermissionEntry('web.whatsapp.com', 'notifications', 'allow')");
    const iApply = WHATSAPP.indexOf('setupSessionPermissionHandlers(waSess)');
    assert.ok(iCheck < iSet, 'primero mira si ya hay regla');
    assert.ok(iSet < iApply, 'despues escribe, despues aplica');
  });

  test('solo se escribe si NO hay ya una regla del usuario', () => {
    // Si el usuario puso 'deny' a proposito, esta linea lo pisaria.
    assert.match(CUERPO.whatsapp, /if \(!PermissionsAdapters\.getPermissionRuleForHost\('web\.whatsapp\.com', 'notifications'\)\)/);
  });

  test('setHdr borra el header viejo antes de escribir el nuevo', () => {
    // Electron manda los headers que ya trae Chromium, con otra
    // capitalizacion. Sin el borrado, se irian los dos.
    const iDelete = CUERPO.whatsapp.indexOf('delete headers[k]');
    const iAssign = CUERPO.whatsapp.indexOf('headers[name] = value');
    assert.ok(iDelete < iAssign, 'borrar antes de asignar');
    assert.match(CUERPO.whatsapp, /if \(k\.toLowerCase\(\) === name\.toLowerCase\(\)\) delete headers\[k\];/);
  });

  test('los cuatro Client Hints van juntos y el patron es de Chrome, no de Chromium', () => {
    for (const h of ['sec-ch-ua', 'sec-ch-ua-full-version', 'sec-ch-ua-platform', 'sec-ch-ua-mobile']) {
      assert.match(CUERPO.whatsapp, new RegExp(`setHdr\\('${h}'`), h);
    }
    // includes y no regex: el "?" de Not=A?Brand en un regex significa
    // "A opcionalmente seguido de Brand", que no es lo que dice el header.
    assert.ok(
      CUERPO.whatsapp.includes(
        '\'sec-ch-ua\', \'"Chromium";v="140", "Google Chrome";v="140", "Not=A?Brand";v="99"\''
      ),
      'el patron de Chrome 140 completo, no solo una version'
    );
  });

  test('el filtro mira el host REQUESTED, no el de la pagina', () => {
    // A diferencia de downloads/native.js: aqui se filtran los hosts de
    // WhatsApp, para no pisar las cabeceras de los CDN que sirve la pagina.
    assert.match(CUERPO.whatsapp, /new URL\(d\.url\)\.hostname\.toLowerCase\(\)/);
    assert.match(CUERPO.whatsapp, /host === 'web\.whatsapp\.com'/);
    assert.match(CUERPO.whatsapp, /host\.endsWith\('\.whatsapp\.net'\)/);
  });

  test('las URLs del interceptor son solo de WhatsApp', () => {
    assert.match(
      CUERPO.whatsapp,
      /urls: \['https:\/\/web\.whatsapp\.com\/\*', 'https:\/\/\*\.whatsapp\.com\/\*', 'https:\/\/\*\.whatsapp\.net\/\*'\]/
    );
  });

  test('una URL que no es http sale sin tocar', () => {
    // Con includes y no con regex: el texto tiene tres barras seguidas
    // (una escapada, otra escapada y la que cierra el literal) y un regex
    // aqui hay que escaping cada una. includes no se equivoca.
    assert.ok(
      CUERPO.whatsapp.includes(
        "if (!/^https?:\\/\\//i.test(d.url || '')) return cb({ requestHeaders: d.requestHeaders });"
      )
    );
  });

  test('el interceptor no se colaron en net/headers.js', () => {
    // Este cuelga de waSess: pertenece a su sesion. net/headers.js tiene su
    // propia regla de WhatsApp (para la sesion principal) y no debe haber
    //lady picked up este interceptor de waSess.
    const headers = leer('src', 'main', 'net', 'headers.js');
    assert.doesNotMatch(headers, /waSess/);
    assert.equal((MAIN.match(/\.webRequest\.onBeforeSendHeaders/g) || []).length, 0, 'ya no queda ninguno en main.js');
  });
});

describe('sessions/* — el cableado en main.js', () => {
  test('las definiciones se fueron de main.js', () => {
    for (const nombre of ['setupExtraSession', 'setupWebchatSession', 'setupWhatsappSession']) {
      assert.doesNotMatch(MAIN, new RegExp(`function ${nombre}\\(`), `${nombre} sigue definida`);
    }
  });

  test('las tres se llaman con prefijo', () => {
    assert.match(MAIN, /const SessionsExtra = require\('\.\/src\/main\/sessions\/extra'\);/);
    assert.match(MAIN, /const SessionsWebchat = require\('\.\/src\/main\/sessions\/webchat'\);/);
    assert.match(MAIN, /const SessionsWhatsapp = require\('\.\/src\/main\/sessions\/whatsapp'\);/);
    for (const [ns, fn] of [['SessionsExtra', 'setupExtraSession'], ['SessionsWebchat', 'setupWebchatSession'], ['SessionsWhatsapp', 'setupWhatsappSession']]) {
      assert.doesNotMatch(MAIN, new RegExp(`(?<![.\\w])${fn}\\(`), `${fn} sin prefijo`);
      assert.ok(MAIN.includes(`${ns}.${fn}()`), `${ns}.${fn}() no se llama`);
    }
  });

  test('Extra se llama al crear la sesion y al arrancar, y WebChat/WhatsApp una vez', () => {
    // sessions:create engancha la nueva y vive en sessions/ipc.js desde el
    // paso 14; el arranque engancha las guardadas y sigue en main.js.
    const crear = IPC.match(/SessionsExtra\.setupExtraSession\(session\.fromPartition\(Sessions\.extraSessionPartition\(id\)\)\)/g) || [];
    const arranque = MAIN.match(/SessionsExtra\.setupExtraSession\(session\.fromPartition\(Sessions\.extraSessionPartition\(s\.id\)\)\)/g) || [];
    assert.equal(crear.length, 1, 'sessions:create');
    assert.equal(arranque.length, 1, 'bucle de arranque');
    assert.equal((MAIN.match(/SessionsWebchat\.setupWebchatSession\(\)/g) || []).length, 1);
    assert.equal((MAIN.match(/SessionsWhatsapp\.setupWhatsappSession\(\)/g) || []).length, 1);
  });

  test('las sesiones se crean con su particion, no con un literal suelto', () => {
    // Un literal aquí seria una quinta sesion que nadie encuentra al buscarla.
    assert.doesNotMatch(MAIN, /session\.fromPartition\('persist:mc-whatsapp'\)/);
    assert.doesNotMatch(MAIN, /session\.fromPartition\('persist:mc-webchat'\)/);
  });
});

// Este test existe por un bug real de ESTA extracción: el require del
// adblocker en extra.js apuntaba a '../../modules/adblocker/main' cuando
// modules/ vive en la raíz del repo y el archivo esta en src/main/sessions/.
// Hacia falta un nivel más.
//
// Lo grave no es la ruta: es que el require está dentro de un try/catch cuyo
// unico efecto es console.error. La sesion extra se quedaba sin adblocker, sin
// error visible y con el boot-smoke en verde, porque un fallo que se traga el
// catch no falla nada.
//
// Por eso no se comprueba "que no haya error", sino algo mas fuerte: que cada
// require relativo del modulo apunte a un archivo que existe.
describe('los modulos nuevos no tienen requires que no existen', () => {
  for (const [rel, fuente] of Object.entries(RUTAS)) {
    test(rel, () => {
      const dir = path.join('src', 'main', path.dirname(rel));
      const pedidos = [...fuente.matchAll(/require\('(\.[^']+)'\)/g)].map((m) => m[1]);
      assert.ok(pedidos.length > 0, `${rel} no tiene requires que comprobar`);
      for (const req of pedidos) {
        const abs = path.resolve(dir, req);
        const existe = ['', '.js', '/index.js'].some((sufijo) => fs.existsSync(abs + sufijo));
        assert.ok(existe, `${rel} hace require('${req}') y no hay ningun archivo ahi`);
      }
    });
  }
});

// -----------------------------------------------------------------------------
// sessions/ipc.js -- los canales de sesion (paso 14)
// -----------------------------------------------------------------------------
// Lo que protege este bloque es una sola cosa: que los handlers de limpieza
// sigan siendo operacion GLOBAL. El boton "limpiar cookies" del panel WebChat
// tiene que borrar las de WebChat, no las de la pestana desde la que se pulso.
// Si uno de ellos pasa a usar `event.sender.session`, el bug no lanza error:
// solo borra las cookies de otro sitio, y el smoke sigue en verde.
describe('sessions/ipc.js -- los handlers de limpieza son operacion global', () => {
  // El JSDoc del modulo NOMBRA las dos trampas, asi que las ausencias se
  // buscan en el codigo, no en el texto. Igual que en los modulos de arriba.
  const cuerpo = codigo(IPC);

  test('no usa event.sender.session en ningun canal', () => {
    assert.doesNotMatch(cuerpo, /sender\.session/, 'un handler paso a usar la sesion de quien pulso');
  });

  test('no usa session.defaultSession para la sesion principal', () => {
    // defaultSession solo corresponde a las ventanas sin partition propio:
    // usarla vaciaria la principal Y dejaria intactas las aisladas.
    assert.doesNotMatch(cuerpo, /defaultSession/);
    assert.match(cuerpo, /session\.fromPartition\('persist:mc'\)/);
  });

  test('las particiones de sesion salen de Sessions, no de un literal suelto', () => {
    assert.doesNotMatch(cuerpo, /fromPartition\('persist:mc-(webchat|whatsapp)'\)/);
    assert.match(cuerpo, /session\.fromPartition\(Sessions\.extraSessionPartition\(id\)\)/);
    assert.match(cuerpo, /session\.fromPartition\(Sessions\.WEBCHAT_PARTITION\)/);
  });
});

describe('sessions/ipc.js -- el registro', () => {
  test('main.js lo requiere y lo registra', () => {
    assert.match(MAIN, /const SessionsIpc = require\('\.\/src\/main\/sessions\/ipc'\);/);
    assert.match(MAIN, /SessionsIpc\.registerSessionsIpc\(\);/);
  });

  test('los 11 canales se fueron de main.js', () => {
    const canales = [
      'clear-cookies', 'clear-cache', 'sessions:list', 'sessions:create',
      'sessions:rename', 'sessions:set-color', 'sessions:delete',
      'sessions:clear-data', 'clear-webchat-data', 'clear-data', 'clear-all',
    ];
    for (const canal of canales) {
      assert.ok(IPC.includes(`ipcMain.handle('${canal}'`), `${canal} no esta en sessions/ipc.js`);
      assert.doesNotMatch(MAIN, new RegExp(`ipcMain\\.handle\\('${canal}'`), `${canal} sigue en main.js`);
    }
  });

  test('la paleta no se duplica: vive en el modulo y no queda en main.js', () => {
    assert.match(IPC, /module\.exports = \{ registerSessionsIpc, SESSION_COLOR_PALETTE \};/);
    assert.doesNotMatch(MAIN, /SESSION_COLOR_PALETTE/);
  });
});

describe('sessions/ipc.js -- la limpieza borra lo que dice que borrar', () => {
  test('clear-data y clear-all vacian el historial con HistoryStore', () => {
    // Namespace, no destructuring: el store se REASIGNA al guardar, asi que un
    // `const { store } = require(...)` capturado al inicio quedaria viejo.
    assert.equal((IPC.match(/HistoryStore\.store\.items = \[\]/g) || []).length, 2);
    assert.equal((IPC.match(/HistoryStore\.save\(\)/g) || []).length, 2);
    assert.doesNotMatch(IPC, /const \{[^}]*\bstore\b[^}]*\} = require\('\.\.\/data\/history'\)/);
  });

  test('clear-all tambien pone las estadisticas a cero, clear-data no', () => {
    assert.equal((IPC.match(/StatsTracker\.zeroStats\(\)/g) || []).length, 1);
    const clearData = IPC.slice(IPC.indexOf("ipcMain.handle('clear-data'"), IPC.indexOf("ipcMain.handle('clear-all'"));
    assert.doesNotMatch(clearData, /zeroStats/);
  });

  test('los borrados por sesion no tocan el historial ni las estadisticas', () => {
    // "Borrar datos" de una sesion aislada no puede vaciar el historial global
    // del navegador: seria tirar el trabajo del usuario desde otra pestana.
    const desde = IPC.indexOf("ipcMain.handle('sessions:clear-data'");
    const hasta = IPC.indexOf("ipcMain.handle('clear-webchat-data'");
    const bloque = IPC.slice(desde, hasta);
    assert.doesNotMatch(bloque, /HistoryStore|zeroStats/);
  });
});
