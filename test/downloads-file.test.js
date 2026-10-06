'use strict';

// downloads/file.js hace require('electron'), asi que no se puede importar en un
// test de node plano. Estos tests leen el fuente.
//
// El bloque mas importante es el de `detectedExt`: fija el comportamiento ACTUAL,
// que es raro a proposito. Si alguien "arregla" el detector, este test falla y le
// dice que va a cambiar los nombres de archivo que ve el usuario.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const leer = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const MAIN = leer('main.js');
const FILE = leer('src', 'main', 'downloads', 'file.js');
const codigo = (s) => s.slice(s.indexOf('*/') + 2);

describe('downloads/file.js -- la extraccion', () => {
  test('main.js lo registra y dl-file se fue de ahi', () => {
    assert.match(MAIN, /const DownloadsFile = require\('\.\/src\/main\/downloads\/file'\);/);
    assert.match(MAIN, /DownloadsFile\.registerFileDownloadIpc\(\);/);
    assert.doesNotMatch(MAIN, /ipcMain\.handle\('dl-file'/);
    assert.match(FILE, /ipcMain\.handle\('dl-file'/);
  });

  test('este modulo NO lleva inyeccion temporal, porque no usa ffmpeg', () => {
    // A diferencia de hls.js: aqui no hay nada que remuxar, solo renombrar. Si
    // alguien le metiera un parametro sin usarlo, seria seudo-codigo.
    assert.match(FILE, /function registerFileDownloadIpc\(\)/);
    // La cabecera NOMBRA finalizeMediaFile al explicar por que no hace falta,
    // asi que la busqueda va en el codigo.
    assert.doesNotMatch(codigo(FILE), /finalizeMediaFile/);
  });

  test('el bloque de ffmpeg se fue a ffmpeg.js en el paso 18', () => {
    const FFMPEG = leer('src', 'main', 'downloads', 'ffmpeg.js');
    for (const fn of ['findFfmpeg', 'findFfprobe', 'installFfmpegPortable',
      'ensureFfmpegAvailable', 'inspectMediaFile', 'remuxToMp4', 'transcodeToMp4',
      'isUsableMp4', 'detectMediaInputFormat', 'resolveMediaInputFormat', 'finalizeMediaFile']) {
      assert.match(FFMPEG, new RegExp(`function ${fn}\\(`), `${fn} deberia estar en ffmpeg.js`);
      assert.doesNotMatch(MAIN, new RegExp(`function ${fn}\\(`), `${fn} no deberia quedar en main.js`);
      assert.doesNotMatch(FILE, new RegExp(`function ${fn}\\(`), `${fn} no deberia estar en file.js`);
    }
  });

  test('main.js solo conserva los dos canales de ffmpeg', () => {
    // Se quedan porque son de una linea y MainWindow los llama. Lo que ya no
    // esta es la implementacion.
    assert.match(MAIN, /ipcMain\.handle\('ffmpeg-check', \(\) => \(\{ found: !!DownloadsFfmpeg\.findFfmpeg\(\), path: DownloadsFfmpeg\.findFfmpeg\(\) \|\| '' \}\)\);/);
    assert.match(MAIN, /ipcMain\.handle\('ffmpeg-install', \(\) => DownloadsFfmpeg\.installFfmpegPortable\(\)\);/);
  });
});

describe('downloads/file.js -- TRAMPA 1: reanudar con Range', () => {
  test('el offset de reanudacion es el tamano del .part', () => {
    // No hay JSON de estado: el propio archivo parcial es el estado.
    assert.match(FILE, /if \(fs\.existsSync\(rawName\)\) offset = totalLen = fs\.statSync\(rawName\)\.size;/);
  });

  test('con offset se pide Range, y el stream se abre en modo append', () => {
    assert.match(FILE, /if \(offset > 0\) headers\['Range'\] = `bytes=\$\{offset\}-`;/);
    assert.match(FILE, /fs\.createWriteStream\(rawName, \{ flags: offset > 0 \? 'a' : 'w' \}\)/);
  });

  test('si el servidor ignora el Range, se reinicia desde cero', () => {
    // El fallo que evita: concatenar el .part viejo con la respuesta entera, y
    // acabar con un archivo del tamano de la suma, sin error de red.
    const cuerpo = codigo(FILE);
    const i = cuerpo.indexOf('if (res.status === 200 && offset > 0) {');
    assert.ok(i > -1, 'tiene que haber la comprobacion del 200 con offset');
    const bloque = cuerpo.slice(i, cuerpo.indexOf('if (!output)', i));
    assert.match(bloque, /output\.close\(\); output = null;/);
    assert.match(bloque, /fs\.writeFileSync\(rawName, Buffer\.alloc\(0\)\);/);
    assert.match(bloque, /totalLen = 0; offset = 0;/);
  });

  test('el WriteStream se cierra antes de truncar', () => {
    // En Windows un stream abierto bloquea el fichero y el writeFileSync
    // siguiente falla con EPERM. El orden NO es cosmetico.
    const cuerpo = codigo(FILE);
    assert.ok(cuerpo.indexOf('output.close();') < cuerpo.indexOf('fs.writeFileSync(rawName, Buffer.alloc(0));'));
  });

  test('se acepta 206 ademas de 200', () => {
    // Un Range bien servido responde 206, no 200: tratarlo como error haria que
    // ninguna reanudacion funcionase.
    assert.match(FILE, /if \(!res\.ok && res\.status !== 206\) throw new Error\(`HTTP \$\{res\.status\} \(\$\{ct\}\)`\)/);
  });
});

describe('downloads/file.js -- TRAMPA 3: el nombre viene del renderer', () => {
  test('se sanean los caracteres que Windows prohibe', () => {
    // Sin esto, un nombre con `a:b` revienta en renameSync y el usuario pierde
    // el archivo entero.
    assert.match(FILE, /String\(name \|\| 'media_' \+ Date\.now\(\)\)\.replace\(\/\[\\\\\/:\*\?"<>\|\]\/g, '_'\)/);
  });

  test('el destino se borra antes del rename, porque Windows no sobreescribe', () => {
    assert.match(FILE, /if \(fs\.existsSync\(finalTarget\)\) try \{ fs\.unlinkSync\(finalTarget\); \} catch \{\}\s*fs\.renameSync\(rawName, finalTarget\);/);
  });

  test('la URL se valida antes de crear la carpeta de descargas', () => {
    const cuerpo = codigo(FILE);
    assert.ok(cuerpo.indexOf('/^https?:\\/\\//i.test(url)') < cuerpo.indexOf('fs.existsSync(dlDir)'),
      'validar despues de crear el directorio seria crear directorios por URL invalida');
  });
});

describe('downloads/file.js -- TRAMPA 2: el detector de extensiones', () => {
  // Estos tests fijan el comportamiento RARO. No son una opinion sobre lo que
  // deberia hacer: son lo que hace hoy. Si se cambian, hay que cambiar el nombre
  // de los archivos que descarga el usuario, y eso es una decision suya.

  test('FIXADO: toda imagen se guarda como .png, incluido jpg, gif y webp', () => {
    const cuerpo = codigo(FILE);
    // El primer patron se lleva por delante jpg/jpeg/gif/webp, asi que las tres
    // ramas siguientes NO se ejecutan nunca.
    //
    // Se compara el texto del patron, no su posicion. La primera version de
    // este test comparaba indices, y al mutar el patron `indexOf` devuelve -1 y
    // -1 es menor que todo: la asercion pasaba con el detector ya cambiado. Se
    // vio mutando el codigo.
    assert.ok(
      cuerpo.includes("if (/\\.(png|jpe?g|gif|webp|avif|bmp|svg)(?:$|[?#])/i.test(lower)) return '.png';"),
      'el primer patron tiene que seguir gainando al de jpg, y siendo el que es',
    );

    // Y las tres ramas muertas siguen ahi, escritas pero inalcanzables.
    assert.match(cuerpo, /if \(\/\\\.\(jpg\|jpeg\)\(\?:\$\|\[\?#\]\)\/i\.test\(lower\)\) return '\.jpg';/);
    assert.match(cuerpo, /if \(\/\\\.\(gif\)\(\?:\$\|\[\?#\]\)\/i\.test\(lower\)\) return '\.gif';/);
    assert.match(cuerpo, /if \(\/\\\.\(webp\)\(\?:\$\|\[\?#\]\)\/i\.test\(lower\)\) return '\.webp';/);
  });

  test('FIXADO: el audio se guarda como .mp3 y el video como .mp4', () => {
    assert.match(FILE, /if \(\/\\\.\(mp3\|wav\|flac\|ogg\|m4a\|aac\)\(\?:\$\|\[\?#\]\)\/i\.test\(lower\)\) return '\.mp3';/);
    assert.match(FILE, /if \(\/\\\.\(mp4\|m4v\|webm\|mkv\|mov\|avi\|mpeg\|mpg\|3gp\)\(\?:\$\|\[\?#\]\)\/i\.test\(lower\)\) return '\.mp4';/);
    assert.match(FILE, /return '\.bin';/);
  });

  test('la extension no se duplica si el nombre ya la trae', () => {
    assert.match(FILE, /const finalNameBase = safeBase\.toLowerCase\(\)\.endsWith\(detectedExt\.toLowerCase\(\)\) \? safeBase : safeBase \+ detectedExt;/);
  });

  test('la comparacion es case-insensitive, y el query se quita antes', () => {
    // `foto.PNG?x=1` tiene que acabar en .png, no en .png.png ni en .bin.
    assert.match(FILE, /const lower = String\(url \|\| ''\)\.split\('\?'\)\[0\]\.toLowerCase\(\);/);
  });

  test('las tres ramas muertas se siguen escribiendo, y el modulo lo avisa', () => {
    // Para que no desaparezcan por limpieza de codigo sin que nadie se entere de
    // que el detector se simplifico.
    assert.match(FILE, /NUNCA/);
    assert.match(FILE, /cambiaria los nombres que el usuario ve/);
  });
});

describe('downloads/file.js -- el estado y los mensajes', () => {
  test('un archivo de 0 bytes es error, no exito', () => {
    assert.match(FILE, /if \(totalLen === 0\) throw new Error\('Servidor devolvió 0 bytes'\);/);
  });

  test('cancelar se distingue de fallar en lo que ve el usuario', () => {
    assert.match(FILE, /error: cancelled \? 'Cancelado' : e\.message, cancelled/);
    assert.match(FILE, /\(cancelled \? '✗ Cancelado: ' : '✗ Error: '\)/);
  });

  test('la entrada del registro se borra aunque reviente', () => {
    const cuerpo = codigo(FILE);
    const f = cuerpo.lastIndexOf('finally {');
    assert.ok(f > -1);
    assert.match(cuerpo.slice(f), /DownloadsRegistry\.dlRegistry\.delete\(id\);/);
  });

  test('dl-file no dice converted, porque aqui no hay conversion', () => {
    // hls.js devuelve `converted` de finalizeMediaFile. Este camino siempre es
    // false, y el renderer lo lee.
    assert.match(FILE, /return \{ ok: true, path: resultPath, size: totalLen, converted: false \};/);
  });
});