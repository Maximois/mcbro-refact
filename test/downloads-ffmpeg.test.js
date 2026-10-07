'use strict';

// downloads/ffmpeg.js hace require('electron') y de child_process, asi que no se
// puede importar en un test de node plano sin arrancar un Electron. Estos tests
// leen el fuente.
//
// Los que importan de verdad son los de bootstrap.js: la prueba de que el bloque se
// movio entero esta en el test de la extraccion, que compara las once funciones.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const leer = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const MAIN = leer('src/main/bootstrap.js');
const FFMPEG = leer('src', 'main', 'downloads', 'ffmpeg.js');
const HLS = leer('src', 'main', 'downloads', 'hls.js');
const codigo = (s) => s.slice(s.indexOf('*/') + 2);

describe('downloads/ffmpeg.js -- la extraccion', () => {
  test('las once funciones se fueron de bootstrap.js', () => {
    const fns = ['findFfmpeg', 'findFfprobe', 'installFfmpegPortable', 'ensureFfmpegAvailable',
      'inspectMediaFile', 'remuxToMp4', 'transcodeToMp4', 'isUsableMp4',
      'detectMediaInputFormat', 'resolveMediaInputFormat', 'finalizeMediaFile'];
    for (const fn of fns) {
      assert.match(FFMPEG, new RegExp(`function ${fn}\\(`), `${fn} deberia estar en ffmpeg.js`);
      assert.doesNotMatch(MAIN, new RegExp(`function ${fn}\\(`), `${fn} sigue en bootstrap.js`);
    }
    // Y las once se exportan, o bootstrap.js no podria llamar a las dos que necesita.
    for (const fn of fns) {
      assert.ok(FFMPEG.includes(`  ${fn},`) || FFMPEG.includes(`  ${fn}\n`), `${fn} no se exporta`);
    }
  });

  test('bootstrap.js solo usa dos de ellas, y de una linea', () => {
    assert.match(MAIN, /const DownloadsFfmpeg = require\('\.\/downloads\/ffmpeg'\);/);
    assert.match(MAIN, /ipcMain\.handle\('ffmpeg-check', \(\) => \(\{ found: !!DownloadsFfmpeg\.findFfmpeg\(\), path: DownloadsFfmpeg\.findFfmpeg\(\) \|\| '' \}\)\);/);
    assert.match(MAIN, /ipcMain\.handle\('ffmpeg-install', \(\) => DownloadsFfmpeg\.installFfmpegPortable\(\)\);/);
    // No mas de dos usos: si se accumulan, el bloque vuelve a bootstrap.js de a poco.
    assert.equal((MAIN.match(/DownloadsFfmpeg\./g) || []).length, 3,
      'la referencia al modulo + los dos usos');
  });

  test('hls.js cierra la deuda del paso 16 y lo requiere directo', () => {
    assert.match(HLS, /const Ffmpeg = require\('\.\/ffmpeg'\);/);
    assert.match(HLS, /function registerHlsIpc\(\)/);
    assert.match(HLS, /await Ffmpeg\.finalizeMediaFile\(rawName, fname\);/);
    assert.match(HLS, /await Ffmpeg\.finalizeMediaFile\(rawName, fname, mapMatch \? 'mp4' : 'mpegts'\);/);
    // Y no queda ninguna llamada suelta a la variable que inyectaba bootstrap.js.
    assert.doesNotMatch(codigo(HLS), /(?<!Ffmpeg\.)finalizeMediaFile/);
  });

  test('no hay ciclo: ffmpeg.js no requiere hls.js ni main.js', () => {
    for (const m of ['./hls', './file', '../../main', 'main.js', 'bootstrap.js']) {
      assert.doesNotMatch(FFMPEG, new RegExp(`require\\('${m.replace(/[.\/]/g, '\\$&')}'\\)`),
        `ffmpeg.js no deberia requerir ${m}`);
    }
    assert.match(FFMPEG, /require\('\.\.\/runtime'\)/);
  });
});

describe('downloads/ffmpeg.js -- TRAMPA 1: FFMPEG_DIR no se cachea', () => {
  test('sigue siendo una flecha, no un path ya resuelto', () => {
    // Si fuera `const FFMPEG_DIR = path.join(...)`, se evaluaria al cargarse el
    // modulo. bootstrap.js cambia el userData al perfil de desarrollo al cargar,
    // antes de los requires, asi que hoy daria bien por casualidad. Cachearlo
    // antes de ese setPath instalaria FFmpeg en el perfil equivocado: el mismo
    // bug que se corrigio para las rutas [DATA].
    assert.match(FFMPEG, /const FFMPEG_DIR = \(\) => path\.join\(app\.getPath\('userData'\), 'ffmpeg'\);/);
    // La cabecera MENCIONA el `const FFMPEG_DIR = path.join(...)` para explicar
    // que es justo lo que no hay que hacer, asi que la busqueda va en el codigo.
    assert.doesNotMatch(codigo(FFMPEG), /const FFMPEG_DIR = path\.join/);
  });

  test('findFfmpeg mira el perfil del usuario y el portable ahi', () => {
    assert.match(FFMPEG, /path\.join\(FFMPEG_DIR\(\), process\.platform === 'win32' \? 'ffmpeg\.exe' : 'ffmpeg'\)/);
    assert.match(FFMPEG, /path\.join\(app\.getPath\('userData'\), process\.platform === 'win32' \? 'ffmpeg\.exe' : 'ffmpeg'\)/);
  });

  test('el orden de candidatos es el que es, y termina en el PATH', () => {
    // FFMPEG_PATH primero para poder forzar uno; luego el portable del perfil;
    // luego el perfil a secas; luego LOCALAPPDATA; y el PATH al final.
    const cuerpo = codigo(FFMPEG);
    const i = cuerpo.indexOf('const candidates = [');
    const bloque = cuerpo.slice(i, cuerpo.indexOf('].filter(Boolean)', i));
    const orden = ['process.env.FFMPEG_PATH', 'FFMPEG_DIR()', "app.getPath('userData')", 'process.env.LOCALAPPDATA', '...pathCandidates'];
    let prev = -1;
    for (const piece of orden) {
      const at = bloque.indexOf(piece);
      assert.ok(at > prev, `${piece} deberia ir despues del anterior`);
      prev = at;
    }
  });
});

describe('downloads/ffmpeg.js -- TRAMPA 2: ffprobe se deduce de ffmpeg', () => {
  test('mira al lado del ffmpeg, no lo busca por su cuenta', () => {
    // Sin ffprobe al lado, inspectMediaFile devuelve null y TODO se recodifica.
    assert.match(FFMPEG, /const ffmpeg = findFfmpeg\(\);\s*if \(!ffmpeg\) return null;\s*const candidate = path\.join\(path\.dirname\(ffmpeg\)/);
  });

  test('sin ffprobe devuelve null en vez de reventar', () => {
    // Devolver null hace que finalizeMediaFile no vea streams y recodifique.
    // Lanzar haria que la descarga entera se marcara como fallida.
    assert.match(FFMPEG, /if \(!ffprobe\) return Promise\.resolve\(null\);/);
  });

  test('cualquier error de ffprobe es null tambien', () => {
    // error, exit code distinto de 0, y JSON invalido: los tres.
    assert.match(FFMPEG, /proc\.on\('error', \(\) => resolve\(null\)\);/);
    assert.match(FFMPEG, /if \(code !== 0\) return resolve\(null\);/);
    assert.match(FFMPEG, /try \{ resolve\(JSON\.parse\(output\)\); \} catch \{ resolve\(null\); \}/);
  });
});

describe('downloads/ffmpeg.js -- TRAMPA 3: remux antes que recodificar', () => {
  test('el remux copia bytes y la recodificacion no', () => {
    assert.match(FFMPEG, /'-c', 'copy'/);
    assert.match(FFMPEG, /'-c:v', 'libx264'/);
    assert.match(FFMPEG, /'-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'/);
  });

  test('la pista de audio es opcional en los dos comandos', () => {
    // El `?` final de `-map 0:a:0?` es de ffmpeg: "este flujo puede no estar".
    // Sin el, un video mudo hace fallar el comando entero.
    assert.equal((FFMPEG.match(/'-map', '0:a:0\?'/g) || []).length, 2,
      'los dos comandos, remux y recodificacion');
  });

  test('solo se remuxea con video h264, y audio aac o nada', () => {
    // La condicion es larga y easy de equivocar al tocarla: si se relaja, se
    // copian bytes a un MP4 que luego no abre nadie.
    const cuerpo = codigo(FFMPEG);
    assert.match(cuerpo, /if \(hasVideo && hasCompatibleVideo && \(!streams\.some\(stream => stream\.codec_type === 'audio'\) \|\| hasCompatibleAudio\)\) \{/);
    assert.match(cuerpo, /const hasCompatibleVideo = streams\.some\(stream => stream\.codec_type === 'video' && stream\.codec_name === 'h264'\);/);
  });

  test('el remux se verifica antes de borrar el original', () => {
    // Si se confiara en el codigo de salida, un ffmpeg que sale con 0 pero no
    // escribio nada borraria el .part. Y el temporal solo se borra DESPUES de
    // que isUsableMp4 diga que hay algo.
    const cuerpo = codigo(FFMPEG);
    assert.match(cuerpo, /if \(remuxed\.ok && isUsableMp4\(finalPath\)\) \{\s*try \{ fs\.unlinkSync\(rawPath\); \} catch \{\}/);
  });

  test('si el remux falla, se borra el mp4 a medias antes de recodificar', () => {
    // Un MP4 a medias molesta mas que un .ts entero: el de la segunda pasada
    // empieza a escribir encima y some reproductores lo leen igual.
    assert.match(FFMPEG, /if \(fs\.existsSync\(finalPath\)\) fs\.unlinkSync\(finalPath\); \} catch \{\}/);
  });
});

describe('downloads/ffmpeg.js -- TRAMPA 4: el fallback nunca pierde el archivo', () => {
  test('sin ffmpeg, renombra a .ts y avisa', () => {
    // Con `includes` y no con una regex: el `$/i` de `\.mp4$/i` dentro de un
    // literal de regex cierra el patron y da "Invalid regular expression flags".
    assert.ok(FFMPEG.includes("const fallbackPath = finalPath.replace(/\\.mp4$/i, '.ts');"));
    // converted:false es lo que lee el renderer para ponerlo en la lista. Son
    // CUATRO: sin temporal, sin ffmpeg, al fallar el rename del fallback, y tras
    // fallar la recodificacion. La cuarta se me paso al contarlas a ojo.
    assert.equal((codigo(FFMPEG).match(/converted: false/g) || []).length, 4);
  });

  test('si el temporal no existe, el error lo dice', () => {
    assert.match(FFMPEG, /if \(!fs\.existsSync\(rawPath\)\) \{\s*return \{ path: rawPath\.replace\(/);
    assert.match(FFMPEG, /error: 'No se encontró el temporal descargado'/);
  });

  test('el .source se deja como estaba, y se avisa de que hoy no lo produce nadie', () => {
    // hls.js usa .part.ts. Puede que sea de yt-dlp (paso 19). Borrarlo a ojo
    // seria el tipo de limpieza que rompio el detector de file.js.
    assert.ok(FFMPEG.includes("rawPath.replace(/\\.source$/i, '.ts')"));
    assert.doesNotMatch(codigo(FFMPEG), /\.part\.source/);
  });
});

describe('downloads/ffmpeg.js -- TRAMPA 5: isUsableMp4', () => {
  test('exige mas de 1 KB, no solo que exista', () => {
    // Sin el tamano, un ffmpeg que sale con codigo 0 sin escribir nada contaria
    // como conversion buena, y el .part original se borraria igual.
    assert.match(FFMPEG, /return fs\.existsSync\(filePath\) && fs\.statSync\(filePath\)\.size > 1024;/);
  });

  test('si stat falla, dice que no, sin reventar', () => {
    assert.match(FFMPEG, /function isUsableMp4\(filePath\) \{\s*try \{[^}]*\} catch \{ return false; \}/);
  });
});

describe('downloads/ffmpeg.js -- deteccion de formato', () => {
  test('la extension gana si ya lo dice', () => {
    assert.ok(FFMPEG.includes("/\\.(?:ts|m2ts|mts)(?:\\.|$)/i.test(lower) || lower.endsWith('.part.ts')) return 'mpegts';"));
    assert.match(FFMPEG, /function resolveMediaInputFormat\(filePath, hint\) \{\s*if \(hint\) return hint;\s*return detectMediaInputFormat\(filePath\);/);
  });

  test('si no, mira los bytes: ftyp o styp es mp4', () => {
    assert.match(FFMPEG, /if \(sample\.subarray\(4, 8\)\.toString\(\) === 'ftyp' \|\| sample\.subarray\(4, 8\)\.toString\(\) === 'styp'\) return 'mp4';/);
    assert.match(FFMPEG, /if \(length < 4\) return undefined;/);
  });

  test('el MPEG-TS se reconoce por los bytes de sincronismo 0x47', () => {
    // 188 es el tamano del paquete TS. Con tres ya no es casualidad.
    assert.match(FFMPEG, /for \(let offset = 0; offset \+ 188 <= length; offset \+= 188\) \{\s*if \(sample\[offset\] === 0x47\) tsHits\+\+;/);
    assert.match(FFMPEG, /if \(tsHits >= 3 \|\| \(length >= 1 && sample\[0\] === 0x47\)\) return 'mpegts';/);
  });

  test('si no se puede leer el archivo, no dice que es mpegts', () => {
    // El `catch {}` vacio es lo correcto aqui: un archivo que no se puede abrir
    // es "no lo se", no "es mpegts".
    assert.match(FFMPEG, /\} catch \{\}\s*return undefined;\s*\}/);
  });
});

describe('downloads/ffmpeg.js -- la instalacion portable', () => {
  test('si ya esta instalado, no vuelve a descargar 90 MB', () => {
    assert.match(FFMPEG, /if \(fs\.existsSync\(ffmpegExe\)\) return \{ ok: true, path: ffmpegExe \};/);
  });

  test('fuera de Windows no intenta descargar nada', () => {
    assert.match(FFMPEG, /if \(process\.platform !== 'win32'\) \{\s*return \{\s*ok: false,\s*error: 'FFmpeg no encontrado\. Instalalo con tu gestor de paquetes/);
  });

  test('las comillas simples se escapan para PowerShell', () => {
    // `Expand-Archive -LiteralPath '...'` con una comilla suelta dentro del
    // path rompe el comando, y el usuario ve un error de sintaxis de PowerShell
    // en vez de "no se pudo instalar".
    assert.equal((codigo(FFMPEG).match(/replace\(\/'\/g, "''"\)/g) || []).length, 2,
      'el zip y el directorio de extraccion');
    assert.match(FFMPEG, /execFile\('powershell\.exe', \[\s*'-NoProfile', '-Command',\s*`Expand-Archive -LiteralPath/);
  });

  test('los temporales llevan Date.now, para que dos instalaciones no choquen', () => {
    assert.match(FFMPEG, /mc-ffmpeg-\$\{Date\.now\(\)\}\.zip/);
    assert.match(FFMPEG, /mc-ffmpeg-extract-\$\{Date\.now\(\)\}/);
  });

  test('execFile se pide dentro de la funcion, no arriba del todo', () => {
    // Require perezoso a proposito: no cargar child_process si no se instala.
    const cuerpo = codigo(FFMPEG);
    // Son DOS require de child_process: el de arriba del modulo, que trae spawn
    // porque todo el modulo lo usa, y el perezoso de execFile. Lo que se fija es
    // que el perezoso este DENTRO de la funcion, no arriba con los demas.
    assert.equal((cuerpo.match(/require\('child_process'\)/g) || []).length, 2);
    assert.match(cuerpo, /const \{ spawn \} = require\('child_process'\);/);
    const i = cuerpo.indexOf("const { execFile } = require('child_process');");
    const ini = cuerpo.indexOf('async function installFfmpegPortable');
    assert.ok(i > ini, 'el de execFile va dentro de installFfmpegPortable');
    assert.ok(i < cuerpo.indexOf('await new Promise((resolve, reject)'), 'y se usa despues');
  });

  test('copia ffmpeg Y ffprobe, y comprueba que ffmpeg.exe salio', () => {
    assert.match(FFMPEG, /for \(const name of \['ffmpeg\.exe', 'ffprobe\.exe'\]\) \{/);
    assert.match(FFMPEG, /if \(!fs\.existsSync\(ffmpegExe\)\) throw new Error\('No se pudo extraer ffmpeg\.exe'\);/);
  });

  test('el error trae guia, no solo el mensaje', () => {
    assert.match(FFMPEG, /guide: 'Descargá FFmpeg Essentials desde https:\/\/www\.gyan\.dev\/ffmpeg\/builds\//);
  });
});

describe('downloads/ffmpeg.js -- ensureFfmpegAvailable', () => {
  test('busca antes de instalar', () => {
    assert.match(FFMPEG, /if \(findFfmpeg\(\)\) return \{ ok: true, path: findFfmpeg\(\) \};/);
    assert.match(FFMPEG, /return installFfmpegPortable\(\);/);
  });

  test('FIXADO: busca DOS veces cuando ya esta instalado', () => {
    // Redundante, y probablemente sin querer: podria ser un `const found`.
    // Se fija a proposito, con "FIXADO:" en el nombre, porque "limpiarlo" es
    // el cambio mas tentador del modulo y no cambia nada de lo que ve el
    // usuario. Igual pasa en `ffmpeg-check`, que tambien llama dos veces.
    const cuerpo = codigo(FFMPEG);
    assert.ok(cuerpo.includes('if (findFfmpeg()) return { ok: true, path: findFfmpeg() };'),
      'que siga buscando dos veces, que es lo que hace');
  });
});