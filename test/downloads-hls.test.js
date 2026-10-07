'use strict';

// downloads/hls.js hace require('electron'), asi que no se puede importar en un
// test de node plano. Estos tests leen el fuente.
//
// La cabecera del modulo ya explica las seis trampas; aqui se fija cada una en
// codigo, porque las trampas de HLS son de las que fallan SIN ERROR: el IV mal
// calculado da un video con saltos, el padding mal puesto lanza un error de red
// falso, y reanudar un directo produce un archivo hecho de dos momentos
// distintos sin quejarse.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const leer = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const MAIN = leer('src/main/bootstrap.js');
const HLS = leer('src', 'main', 'downloads', 'hls.js');
const FILE = leer('src', 'main', 'downloads', 'file.js');

// El JSDoc NOMBRA todas las trampas que comprueban estos tests, asi que las
// ausencias se buscan en el codigo, nunca en el texto.
const codigo = (s) => s.slice(s.indexOf('*/') + 2);

describe('downloads/hls.js -- la extraccion', () => {
  test('bootstrap.js lo registra sin parametros, desde el paso 18', () => {
    assert.match(MAIN, /const DownloadsHls = require\('\.\/downloads\/hls'\);/);
    // Antes era registerHlsIpc({ finalizeMediaFile }) porque la funcion vivia
    // en bootstrap.js y no se podia requerir sin ciclo. El paso 18 la movio a
    // ffmpeg.js y hls.js la requiere directo, asi que el parametro desaparecio.
    //
    // Se fija que NO vuelva, porque reintroducirlo "por simetria" con
    // registerFileDownloadIpc seria volver a una deuda que ya se cerro.
    assert.match(MAIN, /DownloadsHls\.registerHlsIpc\(\);/);
    assert.doesNotMatch(MAIN, /registerHlsIpc\(\{/);
    assert.match(HLS, /function registerHlsIpc\(\)/);
    assert.match(HLS, /const Ffmpeg = require\('\.\/ffmpeg'\);/);
  });

  test('los helpers del manifiesto se fueron de bootstrap.js', () => {
    for (const fn of ['resolveUrl', 'downloadSegment', 'pickBestHlsVariant',
      'parseHlsSegmentUrls', 'hlsSegmentIv', 'decryptAes128Segment',
      'loadHlsEncryption', 'writeHlsChunk', 'flushHlsOutput']) {
      assert.ok(HLS.includes(`function ${fn}(`), `${fn} no esta en hls.js`);
      assert.doesNotMatch(MAIN, new RegExp(`function ${fn}\\(`), `${fn} sigue en bootstrap.js`);
    }
    assert.match(HLS, /ipcMain\.handle\('dl-hls'/);
    assert.doesNotMatch(MAIN, /ipcMain\.handle\('dl-hls'/);
  });

  test('dl-file se movió en el paso 17, a su propio módulo', () => {
    // Antes este test decía "dl-file se queda para el paso 17". Falló al hacer
    // el 17, que es lo que debía pasar: los tests de extracción avisan de qué se
    // movió.
    assert.match(MAIN, /const DownloadsFile = require\('\.\/downloads\/file'\);/);
    assert.match(MAIN, /DownloadsFile\.registerFileDownloadIpc\(\);/);
    assert.doesNotMatch(MAIN, /ipcMain\.handle\('dl-file'/);
    assert.match(FILE, /ipcMain\.handle\('dl-file'/);
  });

  test('FFMPEG_DIR se fue a ffmpeg.js en el paso 18', () => {
    // Vive justo despues de los helpers HLS, asi que era el que mas
    // probablemente se habria llevado por error.
    const FFMPEG = leer('src', 'main', 'downloads', 'ffmpeg.js');
    assert.match(FFMPEG, /const FFMPEG_DIR = \(\) => path\.join\(app\.getPath\('userData'\), 'ffmpeg'\);/);
    assert.doesNotMatch(MAIN, /FFMPEG_DIR/);
    assert.doesNotMatch(HLS, /FFMPEG_DIR/);
  });

  test('la reanudacion viene de lib/hls-resume, con la ruta relativa correcta', () => {
    assert.match(HLS, /require\('\.\.\/\.\.\/\.\.\/lib\/hls-resume'\)/);
    assert.match(HLS, /fingerprintHlsPlaylist, loadHlsResumeState, saveHlsResumeState/);
    // Y el require de bootstrap.js era su unico consumidor, asi que se borro. Solo
    // queda el comentario que explica por que, sin ninguna llamada.
    assert.doesNotMatch(MAIN, /require\('\.\/lib\/hls-resume'\)/);
    assert.doesNotMatch(MAIN, /loadHlsResumeState\(/);
    assert.doesNotMatch(MAIN, /saveHlsResumeState\(/);
  });
});

describe('downloads/hls.js -- TRAMPA 4: el IV se deriva bien', () => {
  // Si el IV sale mal, decipher NO falla: devuelve bytes, el archivo se guarda y
  // el unico sintoma es que el video va a saltos. Es el peor fallo posible
  // porque parece un problema de red o de servidor.
  test('el IV sin IV= del manifiesto va en el offset 8 y en big-endian', () => {
    assert.match(HLS, /const iv = Buffer\.alloc\(16, 0\);\s*const seq = BigInt\(mediaSeq \+ segmentIndex\);\s*iv\.writeBigUInt64BE\(seq, 8\);/);
  });

  test('un IV explicito se alinea a la DERECHA, no a la izquierda', () => {
    // Buffer.from(hex) da un buffer corto si el IV del manifiesto tiene menos de
    // 16 bytes. La copia al final del buffer de 16 es lo que lo alinea; sin el
    // Math.max, un IV corto se pegaria al principio y el decipher leeria basura.
    assert.match(HLS, /parsed\.copy\(iv, Math\.max\(0, 16 - parsed\.length\)\);/);
  });

  test('un IV del manifiesto tiene prioridad sobre el derivado', () => {
    assert.match(HLS, /if \(ivHex\) \{/);
  });
});

describe('downloads/hls.js -- TRAMPA 5: el decipher sin padding', () => {
  test('setAutoPadding(false) antes de.update', () => {
    // Los segmentos HLS no vienen rellenos al tamano de bloque. Con
    // auto-padding, decipher.final() lanza en el ultimo bloque y el error sale
    // como si fuera de red, en un bucle que descifro bien.
    assert.match(HLS, /const decipher = crypto\.createDecipheriv\('aes-128-cbc', key, iv\);\s*decipher\.setAutoPadding\(false\);/);
  });

  test('un metodo distinto de AES-128 dice que no, en vez de fallar raro', () => {
    assert.match(HLS, /no soportado\. Probá con yt-dlp/);
    assert.match(HLS, /Clave AES-128 inválida o inaccesible/);
  });
});

describe('downloads/hls.js -- TRAMPA 1 y 2: reanudar y no dejar archivos rotos', () => {
  test('un segmento que falla cancela TODO, no se salta', () => {
    // El guardia y el throw van en la MISMA asercion a proposito. Con dos
    // aserciones separadas, cambiar el `if (results.some(...))` por un
    // `if (false)` dejaba el throw escrito-- y muerto-- y el test pasaba.
    // Se vio mutando el codigo.
    assert.match(codigo(HLS), /if \(results\.some\(buffer => !buffer\)\) \{\s*failedSegments \+= results\.filter\(buffer => !buffer\)\.length;\s*throw new Error\(`Fallaron \$\{failedSegments\} segmentos HLS; conversión cancelada para evitar un archivo corrupto`\);/);
    // Y el .part.ts se queda para que el usuario vea que tiene.
    assert.match(HLS, /if \(hlsOutput && !hlsOutput\.closed\) hlsOutput\.destroy\(\);/);
  });

  test('la reanudacion solo se escribe si la playlist es VOD', () => {
    // Un directo no tiene ENDLIST y sus segmentos se desplazan: reanudar por
    // indice en un vivo produce un archivo con segmentos de dos momentos.
    //
    // Esto se busco en codigo() y no en el archivo entero porque la cabecera
    // del modulo reproduce esta misma linea como ejemplo, y el test pasaba
    // porque en realidad la estaba leyendo ahi. Se vio al mutar el codigo.
    assert.match(codigo(HLS), /const isVodPlaylist = \/\^\\s\*#EXT-X-ENDLIST\\s\*\$\/im\.test\(mediaText\);/);
    assert.match(codigo(HLS), /const resumeState = isVodPlaylist\s*\? loadHlsResumeState\([^)]*\)\s*: null;/);
  });

  test('las dos escrituras del estado de reanudacion estan dentro de un if (isVodPlaylist)', () => {
    const cuerpo = codigo(HLS);
    const guardas = [...cuerpo.matchAll(/if \(isVodPlaylist\) \{/g)];
    assert.ok(guardas.length >= 2, 'la reanudacion se escribe al menos en el init y en cada lote');
    // saveHlsResumeState solo puede aparecer dentro de esos dos bloques.
    assert.equal((cuerpo.match(/saveHlsResumeState\(/g) || []).length, 2);
  });

  test('el fingerprint se pasa al leer el estado, para descartar si el manifiesto cambio', () => {
    assert.match(HLS, /const fingerprint = fingerprintHlsPlaylist\(playlistUrl, mediaText\);/);
    assert.match(HLS, /loadHlsResumeState\(hlsResumePath, rawName, fingerprint, resolved\.length\)/);
  });

  test('sin estado de reanudacion se borra el .resume.json viejo', () => {
    assert.match(HLS, /if \(!resumeState\) try \{ fs\.unlinkSync\(hlsResumePath\); \} catch \{\}/);
  });

  test('el estado de reanudacion se borra al terminar bien', () => {
    assert.match(HLS, /try \{ fs\.unlinkSync\(hlsResumePath\); \} catch \{\}\s*const size = \(downloadedBytes/);
  });
});

describe('downloads/hls.js -- la eleccion de variante', () => {
  test('gana la de mayor resolucion, y a igualdad la de mayor ancho de banda', () => {
    assert.match(HLS, /if \(resolution > bestResolution \|\| \(resolution === bestResolution && bandwidth > bestBandwidth\)\)/);
  });

  test('si el manifiesto no declara nada, se usa la URL que se dio', () => {
    // Con una sola variante no hay nada que elegir, y el handler solo llama a
    // pickBestHlsVariant si encuentra EXT-X-STREAM-INF.
    assert.match(HLS, /return bestResolution >= 0 \|\| bestBandwidth >= 0 \? bestUrl : baseUrl;/);
    assert.ok(HLS.includes('if (/#EXT-X-STREAM-INF/i.test(manifestText))'));
  });

  test('una linea .m3u8 dentro de la playlist de medios no se cuenta como segmento', () => {
    // Las playlists variante son entradas mas, no segmentos. Si se colaran, el
    // descarga intentaria escribir un .m3u8 en el .ts.
    assert.ok(HLS.includes("if (/\\.m3u8(\\?|#|$)/i.test(trimmed)) continue;"));
  });
});

describe('downloads/hls.js -- lo que el renderer puede recibir', () => {
  test('una URL que no es http se rechaza antes de tocar disco', () => {
    // Primero la validacion, luego el mkdir. Al reves, una URL mala crearia la
    // carpeta de descargas.
    const cuerpo = codigo(HLS);
    const valida = cuerpo.indexOf("/^https?:\\/\\//i.test(url)");
    const mkdir = cuerpo.indexOf('fs.existsSync(dlDir)');
    assert.ok(valida > -1 && mkdir > valida, 'la validacion tiene que ir antes que el mkdir');
  });

  test('un cuerpo que no es HLS se guarda como archivo, no se rechaza', () => {
    assert.match(HLS, /if \(!manifestText\.includes\('#EXTM3U'\)\)/);
    assert.match(HLS, /No es HLS, guardar como archivo directo/);
  });

  test('cancelar se distingue de fallar en lo que ve el usuario', () => {
    // El mensaje del log y el del evento dl-error tienen que decir cosas
    // distintas, o el usuario ve "Error HLS: Cancelado por el usuario".
    assert.match(HLS, /error: cancelled \? 'Cancelado' : e\.message, cancelled/);
    assert.match(HLS, /\(cancelled \? '✗ Cancelado: ' : '✗ Error HLS: '\)/);
  });

  test('la entrada del registro se borra aunque el handler reviente', () => {
    const cuerpo = codigo(HLS);
    const finallyIdx = cuerpo.lastIndexOf('finally {');
    assert.ok(finallyIdx > -1, 'dl-hls necesita un finally');
    assert.match(cuerpo.slice(finallyIdx), /DownloadsRegistry\.dlRegistry\.delete\(id\);/);
  });
});