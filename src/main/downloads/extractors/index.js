'use strict';
/**
 * MC Browser -- src/main/downloads/extractors/index.js
 *
 * Registro de extractores de hosts. Un extractor sabe renovar el enlace
 * directo (re-mint) cuando el host expira los tickets (MediaFire free. Para
 * el resto cae en generic, que no renueva: el reanudador por Range usa la
 * URL original.
 *
 * Para añadir un host nuevo basta un archivo en esta carpeta con el contrato
 * { name, match(url), mint?(url) } y agregarlo al array.
 */

const mediafire = require('./mediafire');
const generic = require('./generic');

const EXTRACTORS = [mediafire];

function pickExtractor(url) {
  for (const ex of EXTRACTORS) {
    if (ex.match(url)) return ex;
  }
  return generic;
}

module.exports = { pickExtractor, EXTRACTORS };