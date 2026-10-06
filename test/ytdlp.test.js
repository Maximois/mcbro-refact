'use strict';

// tools/ytdlp.js hace require('electron') y de child_process, asi que no se puede
// importar en un test de node plano. Estos tests leen el fuente.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const leer = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const MAIN = leer('main.js');
const YTDLP = leer('tools', 'ytdlp.js');
const FFMPEG = leer('src', 'main', 'downloads', 'ffmpeg.js');
const codigo = (s) => s.slice(s.indexOf('*/') + 2);

// El punto de este archivo es que los canales de preload.js y renderer.html NO
// pueden cambiar de nombre. Si se renombrara uno, el boton de instalar yt-dlp
// dejaria de funcionar sin que ningun test de node lo notara.
const PRELOAD = leer('preload.js');
const RENDERER = leer('src', 'renderer.html');

describe('tools/ytdlp.js -- la extraccion', () => {
  test('main.js lo carga y lo registra una vez', () => {
    assert.match(MAIN, /const YtDlp = require\('\.\/tools\/ytdlp'\);/);
    assert.match(MAIN, /YtDlp\.registerYtdlpIpc\(\);/);
    // Una sola llamada. El require es `require('./tools/ytdlp')` y no lleva el
    // nombre de la funcion, asi que no cuenta aqui.
    assert.equal((MAIN.match(/registerYtdlpIpc\(\)/g) || []).length, 1);
  });

  test('los cinco helpers se fueron de main.js', () => {
    for (const fn of ['findYtdlp', 'isYtdlpNativeLoginHost', 'writeYtdlpCookiesFile',
      'cleanupYtdlpCookiesFile']) {
      assert.match(YTDLP, new RegExp(`function ${fn}\\(`), `${fn} deberia estar en ytdlp.js`);
      assert.doesNotMatch(MAIN, new RegExp(`function ${fn}\\(`), `${fn} sigue en main.js`);
    }
    assert.match(YTDLP, /const YTDLP_NATIVE_LOGIN_HOSTS = \/\(\^\|\\\.\)instagram/);
    assert.doesNotMatch(MAIN, /YTDLP_NATIVE_LOGIN_HOSTS/);
    assert.match(YTDLP, /let ytdlpPath = '';/);
    assert.doesNotMatch(MAIN, /ytdlpPath/);
  });

  test('los canales se registran DENTRO de la funcion, y los cinco estan', () => {
    const cuerpo = codigo(YTDLP);
    const i = cuerpo.indexOf('function registerYtdlpIpc() {');
    assert.ok(i > -1);
    for (const ch of ['ytdlp-check', 'ytdlp-version', 'ytdlp-install', 'ytdlp-analyze', 'ytdlp-download']) {
      assert.match(YTDLP, new RegExp(`ipcMain\\.handle\\('${ch}'`), `falta el canal ${ch}`);
    }
    // Y ninguno quedo en main.js.
    assert.doesNotMatch(MAIN, /ipcMain\.handle\('ytdlp-/);
  });

  test('los nombres de canal siguen siendo los que espera el renderer', () => {
    // preload.js traduce ytdlpDownload -> ytdlp-download, y renderer.html usa
    // los botones. Si un canal cambiara de nombre, la app dejaria de descargar
    // y aqui no habria ningun fallo visible.
    for (const [fn, ch] of [['ytdlpCheck', 'ytdlp-check'], ['ytdlpVersion', 'ytdlp-version'],
      ['ytdlpInstall', 'ytdlp-install'], ['ytdlpAnalyze', 'ytdlp-analyze'],
      ['ytdlpDownload', 'ytdlp-download']]) {
      assert.ok(PRELOAD.includes(`${fn}:`), `preload.js deberia exponer ${fn}`);
      // invoke('ytdlp-check') y invoke('ytdlp-analyze', url): el canal va
      // seguido de coma o de cierre. Con el parentesis escapado DENTRO de la
      // clase, el `)` de cierre queda fuera y el patron no compila.
      assert.ok(new RegExp(`invoke\\('${ch}'[,)]`).test(PRELOAD),
        `preload.js deberia invocar ${ch}`);
      assert.match(YTDLP, new RegExp(`handle\\('${ch}'`), `ytdlp.js deberia manejar ${ch}`);
    }
    assert.ok(RENDERER.includes('ytdlp-install-btn'));
  });

  test('ytdlp-log se sigue emitiendo, y main.js tambien lo usa', () => {
    // El renderer esta suscrito a este evento. ffmpeg.js lo emite para sus
    // avisos y hay una linea en main.js que tambien lo usa, asi que no se puede
    // "normalizar" el nombre sin tocar las tres cosas.
    assert.match(YTDLP, /ACTIONS\.emit\('ytdlp-log'/);
    assert.match(FFMPEG, /ACTIONS\.emit\?\.\('ytdlp-log'/);
    assert.match(MAIN, /ACTIONS\.emit\('ytdlp-log', 'Stream scan error: /);
    assert.ok(RENDERER.includes('ytdlp-log'));
  });

  test('los canales de ffmpeg NO se fueron con el bloque', () => {
    // Estaban en medio del bloque de yt-dlp, entre ytdlp-check y
    // ytdlp-version. No son de yt-dlp: llaman a ffmpeg.js.
    assert.match(MAIN, /ipcMain\.handle\('ffmpeg-check'/);
    assert.match(MAIN, /ipcMain\.handle\('ffmpeg-install'/);
    assert.doesNotMatch(YTDLP, /ipcMain\.handle\('ffmpeg-/);
  });

  test('no hay ciclo: ytdlp.js no requiere main.js', () => {
    assert.doesNotMatch(YTDLP, /require\('\.\.\/main\.js'\)|require\('\.\.\/\.\.\/main\.js'\)/);
    assert.match(YTDLP, /require\('\.\.\/src\/main\/runtime'\)/);
    assert.match(YTDLP, /require\('\.\.\/src\/main\/config'\)/);
  });
});

describe('tools/ytdlp.js -- TRAMPA 1: findYtdlp no busca en el PATH', () => {
  test('los dos ultimos candidatos son rutas RELATIVAS, no del PATH', () => {
    // FIXADO. fs.existsSync('yt-dlp.exe') se resuelve contra el directorio de
    // trabajo del proceso. Si el usuario tiene yt-dlp en el PATH pero no en su
    // perfil ni en el CWD, ytdlp-check responde false aunque `yt-dlp` funcione
    // en una terminal.
    assert.ok(codigo(YTDLP).includes("[path.join(app.getPath('userData'), 'yt-dlp.exe'), 'yt-dlp.exe', 'yt-dlp']"));
    // Y el contraste con ffmpeg.js, que SI recorre el PATH a mano. Esta aqui
    // para que no se "arregle" este copiando el estilo del otro.
    assert.match(FFMPEG, /String\(process\.env\.PATH/);
    assert.ok(!codigo(YTDLP).includes('process.env.PATH'), 'ytdlp.js no deberia recorrer el PATH');
  });

  test('FIXADO: la cache se revalida con existsSync en cada uso', () => {
    // Si el usuario borra el ejecutable, la siguiente llamada lo busca otra vez
    // en vez de usar un caminho muerto.
    assert.ok(codigo(YTDLP).includes("if (ytdlpPath && fs.existsSync(ytdlpPath)) return ytdlpPath;"));
  });

  test('instalar deja el camino cacheado', () => {
    assert.ok(codigo(YTDLP).includes("      ytdlpPath = dest;"));
  });
});

describe('tools/ytdlp.js -- TRAMPA 2: las cookies van a un archivo en claro', () => {
  test('se exportan de la particion correcta, con el literal', () => {
    // persist:mc es el mismo particionado que usa el resto de la app. Cambiar
    // la cadena rota la sesion de golpe y no hay ningun test de node que lo
    // note, porque solo electron sabe lo que significa.
    assert.ok(codigo(YTDLP).includes("session.fromPartition('persist:mc').cookies.get({ url: pageUrl })"));
  });

  test('el archivo es Netscape, con las siete columnas y tabuladores', () => {
    assert.ok(codigo(YTDLP).includes("const lines = ['# Netscape HTTP Cookie File', '# Generado por MC Browser para yt-dlp'];"));
    assert.ok(codigo(YTDLP).includes("lines.push([domain, includeSubdomains, c.path || '/', c.secure ? 'TRUE' : 'FALSE', expires, c.name, c.value].join('\\t'));"));
  });

  test('los subdominios se marcan con el punto inicial', () => {
    // Sin esto, yt-dlp no mandaria la cookie a los subdominios.
    assert.ok(codigo(YTDLP).includes("const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';"));
  });

  test('si no hay cookies, no se crea archivo', () => {
    assert.ok(codigo(YTDLP).includes('if (!cookies.length) return null;'));
  });

  test('el borrado va en el finally de LOS DOS handlers', () => {
    // En el catch no basta: el camino feliz tambien tiene que borrar. Sin el
    // finally, un analyze que va bien deja el archivo con la sesion de la
    // persona en el temporal.
    assert.equal((codigo(YTDLP).match(/finally \{ cleanupYtdlpCookiesFile\(cookiesFile\); \}/g) || []).length, 2,
      'ytdlp-analyze y ytdlp-download');
  });

  test('FIXADO: el borrado no se espera, y no hay reintento', () => {
    // fs.unlink con callback sin await: no bloquea la respuesta al renderer.
    // El precio es que si el borrado falla, el archivo se queda con las cookies
    // dentro. Se deja asi porque esperar cambiaria el comportamiento observable.
    assert.ok(codigo(YTDLP).includes("  fs.unlink(file, () => {});"));
    assert.doesNotMatch(YTDLP, /await fs\.unlink|fs\.unlinkSync|rmSync/);
  });

  test('el archivo lleva Date.now, para que dos descargas no se pisen', () => {
    assert.ok(codigo(YTDLP).includes('mc-ytdlp-cookies-${Date.now()}.txt'));
  });

  test('si la exportacion falla, avisa por consola y devuelve null', () => {
    // Y null significa "sigue sin cookies", que los handlers saben manejar.
    assert.ok(codigo(YTDLP).includes("} catch (e) { console.error('[ytdlp-cookies]', e.message); return null; }"));
  });
});

describe('tools/ytdlp.js -- TRAMPA 3: pagina en vez de stream', () => {
  test('los cinco sitios con login propio estan en la lista', () => {
    for (const h of ['instagram', 'facebook', 'twitter', 'x', 'tiktok']) {
      // El patron es (^|\.)dominio\.com$, asi que en el archivo NO hay una
      // subcadena `\.dominio\.com$`: hay `(^|\.)dominio\.com$|`. La busqueda va
      // a `dominio\.com$` y el (^|\.) se comprueba aparte.
      assert.ok(codigo(YTDLP).includes(`${h}\\.com$`), `falta ${h}`);
    }
    // Cada sitio va con el grupo (^|\.) delante: o el dominio empieza la
    // cadena, o tiene un punto antes. Sin eso, `notinstagram.com` entraria.
    assert.equal((codigo(YTDLP).match(/\(\^\|\\\.\)/g) || []).length, 5);
  });

  test('FIXADO: el regex ancla al FINAL del host, y acepta subdominios', () => {
    // Con `$` al final, `notinstagram.com` NO entra: hace falta el (^|\.) de
    // delante. Y el `i` cubre mayusculas.
    const m = codigo(YTDLP).match(/const YTDLP_NATIVE_LOGIN_HOSTS = (\/.*\/i);/);
    assert.ok(m, 'no se encuentra el regex');
    // Ojo: al quitar los delimitadores hay que volver a pasar la `i`, que no
    // viene en el cuerpo del patron. Sin ella, WWW.INSTAGRAM.COM no entra, que
    // es justo una de las cosas que se comprueba abajo.
    const re = new RegExp(m[1].slice(1, -2), 'i');
    assert.equal(re.test('www.instagram.com'), true);
    assert.equal(re.test('notinstagram.com'), false, 'sin el punto delante no es el dominio');
    assert.equal(re.test('WWW.INSTAGRAM.COM'), true, 'la i del final es lo que hace esto');
    assert.equal(re.test('youtube.com'), false);
    assert.equal(re.test(''), false);
    assert.equal(re.test('instagram.com'), true, 'el dominio pelado tambien');
  });

  test('solo gana la pagina si viene pageUrl Y el host es de la lista', () => {
    // opts.url y opts.pageUrl no son sinonimos, y cual gana depende del host.
    assert.ok(codigo(YTDLP).includes('if (isYtdlpNativeLoginHost(pageHost)) target = opts.pageUrl;'));
    assert.ok(codigo(YTDLP).includes('let target = opts.url;'));
  });

  test('las cookies se piden dos veces: la pagina y, si falla, el target', () => {
    assert.ok(codigo(YTDLP).includes('cookiesFile = await writeYtdlpCookiesFile(opts.pageUrl);'));
    assert.ok(codigo(YTDLP).includes('if (!cookiesFile) cookiesFile = await writeYtdlpCookiesFile(target).catch(() => null);'));
  });

  test('si pageUrl no es una URL valida, no revienta', () => {
    assert.ok(codigo(YTDLP).includes('        } catch {}\n      }\n      if (!cookiesFile)'));
  });
});

describe('tools/ytdlp.js -- TRAMPA 4: stdout se supone que es solo la ruta', () => {
  test('se pide la ruta final con after_move, y se acumula stdout', () => {
    // after_move, porque yt-dlp puede renombrar al terminar (por ejemplo al
    // fusionar两条 streams) y la ruta de antes no seria la buena.
    assert.ok(codigo(YTDLP).includes("'--print', 'after_move:filepath'"));
    assert.ok(codigo(YTDLP).includes("proc.stdout.on('data', d => { output += d.toString();"));
  });

  test('FIXADO: path es output.trim(), sin dividir en lineas', () => {
    // Si yt-dlp escribiera un aviso extra en stdout, path seria un texto
    // multilinea y el renderer recibiria una ruta que no existe. Se deja: es el
    // contrato con la salida de una herramienta de terceros.
    assert.ok(codigo(YTDLP).includes("resolve({ ok: true, path: output.trim() })"));
    assert.doesNotMatch(YTDLP, /output\.split\(/);
  });

  test('stderr va al renderer y NO se acumula', () => {
    // Por eso stdout puede assumptionser solo la ruta: el progreso va por stderr.
    assert.ok(codigo(YTDLP).includes("proc.stderr.on('data', d => { try { getMainWin()?.webContents?.send('ytdlp-log', d.toString().trim()); } catch {} });"));
  });

  test('el progreso se manda sin romper si no hay ventana', () => {
    // La app puede cerrarse mientras yt-dlp sigue corriendo.
    assert.equal((codigo(YTDLP).match(/getMainWin\(\)\?\.webContents\?\.send\('ytdlp-log'/g) || []).length, 2,
      'stdout y stderr');
  });
});

describe('tools/ytdlp.js -- TRAMPA 5: tres timeouts distintos', () => {
  test('FIXADO: version 5 s, analyze 30 s, download NINGUNO', () => {
    // La descarga sin timeout es a proposito: un video largo legitimate tarda
    // mas de 30 s y matarlo seria peor que esperar. El precio es que si yt-dlp
    // se cuelga, ese spawn se queda vivo hasta que cierre la app.
    assert.ok(codigo(YTDLP).includes("spawn(p, ['--version'], { timeout: 5000 })"));
    assert.ok(codigo(YTDLP).includes('spawn(p, args, { timeout: 30000 })'));
    const dl = codigo(YTDLP).slice(codigo(YTDLP).indexOf("ipcMain.handle('ytdlp-download'"));
    assert.doesNotMatch(dl, /timeout/, 'ytdlp-download no debe tener timeout');
  });

  test('el analyze no descarga nada, y solo devuelve el numero de formatos', () => {
    assert.ok(codigo(YTDLP).includes("const args = ['--no-download', '--dump-json'];"));
    assert.ok(codigo(YTDLP).includes('formats: (data.formats || []).length'));
  });

  test('nunca se descarga una playlist entera', () => {
    assert.ok(codigo(YTDLP).includes("'--no-playlist'"));
  });

  test('el nombre lo pone yt-dlp, no nosotros', () => {
    // %(title)s y %(ext)s: la extension la decide yt-dlp segun el contenedor
    // que elija. Por eso el .source de ffmpeg.js no aparece por aqui.
    assert.ok(codigo(YTDLP).includes("'-o', path.join(dlDir, '%(title)s.%(ext)s')"));
  });
});

describe('tools/ytdlp.js -- los errores se devuelven de forma uniforme', () => {
  test('si no esta instalado, todos los canales lo dicen igual', () => {
    // Solo DOS: ytdlp-analyze y ytdlp-download. ytdlp-version devuelve cadena
    // vacia y ytdlp-check un booleano, porque el renderer los usa distinto.
    assert.equal((codigo(YTDLP).match(/if \(!p\) return \{ error: 'yt-dlp not found' \};/g) || []).length, 2);
  });

  test('ytdlp-check responde un booleano, no un objeto', () => {
    // El renderer lo usa como bandera. Si volviera { error } al cambiar esto,
    // un objeto es truthy y la app creeria que yt-dlp esta instalado siempre.
    assert.ok(codigo(YTDLP).includes("ipcMain.handle('ytdlp-check', () => !!findYtdlp());"));
  });

  test('version devuelve cadena vacia si falla, no undefined', () => {
    // UNA vez: en `proc.on('error')`. El close resuelve el valor de --version,
    // que puede ser cadena vacia sin que se haya escrito resolve('') por
    // ningun lado.
    assert.equal((codigo(YTDLP).match(/resolve\(''\)/g) || []).length, 1);
    assert.ok(codigo(YTDLP).includes("} catch { return ''; }"));
  });

  test('install devuelve la ruta donde quedo', () => {
    assert.ok(codigo(YTDLP).includes("return { ok: true, path: dest };"));
    assert.ok(codigo(YTDLP).includes('yt-dlp/releases/latest/download/yt-dlp.exe'));
  });
});