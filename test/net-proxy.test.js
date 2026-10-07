'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MOD = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'net', 'proxy.js'),
  'utf8'
);
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src/main/bootstrap.js'), 'utf8');
// El JSDoc menciona el nombre de sessions/partitions.js al explicar la
// importacion; las aserciones de ausencias van contra el codigo, no el texto.
const codigo = MOD.slice(MOD.indexOf('*/') + 2);

describe('net/proxy.js — la regla de proxy', () => {
  test('proxyRulesFromCfg devuelve null si el proxy esta apagado', () => {
    assert.match(MOD, /if \(!CFG\.proxyEnabled \|\| !CFG\.proxyHost\) return null;/);
  });

  // Los defaults (socks5, 1080) son los que estan en la expresion repetida 4
  // veces. Si cambian aqui, tienen que cambiar en un solo sitio.
  test('los defaults son socks5 y 1080', () => {
    assert.match(MOD, /const type = CFG\.proxyType \|\| 'socks5';/);
    assert.match(MOD, /const port = CFG\.proxyPort \|\| 1080;/);
  });
});

describe('net/proxy.js — la duplicacion de setProxy se fue con el modulo', () => {
  // El bug que vigila esto: alguien anade una quinta sesion y copia/pega el
  // bloque entero en vez de llamar a la funcion.
  test('bootstrap.js ya no escribe ninguna regla de proxy a mano', () => {
    assert.doesNotMatch(MAIN, /proxyRules:\s*`\$\{CFG\.proxyType/);
    assert.doesNotMatch(MAIN, /CFG\.proxyType \|\| 'socks5'/);
  });

  test('las 4 sesiones llaman a applyProxyFromCfg con su etiqueta', () => {
    // El paso 13 movio tres de las cuatro a sus modulos de sesion, asi que ya
    // no estan todas en bootstrap.js. Se cuentan ahi y en los modulos que las
    // pertenecen; lo que se vigila es que sean cuatro y con su etiqueta.
    const modulos = ['extra', 'webchat', 'whatsapp']
      .map((m) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'sessions', `${m}.js`), 'utf8'))
      .join('\n');
    const fuente = `${MAIN}\n${modulos}`;
    const llamadas = [...fuente.matchAll(/(?:\w+\.)?applyProxyFromCfg\(\s*(\w+)\s*,\s*'(\[[^\]]*\])?'/g)];
    assert.equal(llamadas.length, 4, 'principal, webchat, whatsapp y aislada');
    const etiquetas = llamadas.map((c) => c[2] || '').sort();
    assert.deepEqual(etiquetas, ['', '[session]', '[webchat]', '[whatsapp]']);
    // Y cada una en su sitio: la principal en bootstrap.js, las otras en su modulo.
    assert.match(MAIN, /applyProxyFromCfg\(\s*sess\s*,\s*''/);
    assert.match(modulos, /applyProxyFromCfg\(\s*sess\s*,\s*'\[session\]'/);
    assert.match(modulos, /applyProxyFromCfg\(\s*wchSess\s*,\s*'\[webchat\]'/);
    assert.match(modulos, /applyProxyFromCfg\(\s*waSess\s*,\s*'\[whatsapp\]'/);
  });

  // Fire-and-forget: applyProxyFromCfg no espera. Si empezara a devolver una
  // promesa, los 4 call sites (que no la usan) seguirian funcionando, pero
  // setProxy() empezaria a aplicar el proxy antes de terminar el arranque.
  test('applyProxyFromCfg no devuelve la promesa de setProxy', () => {
    assert.match(MOD, /function applyProxyFromCfg\(sess, tag\) \{[\s\S]*?sess\.setProxy\(regla\)\.catch\(/);
    assert.doesNotMatch(MOD, /function applyProxyFromCfg[\s\S]*?return sess\.setProxy/);
  });

  test('la etiqueta llega al log con el prefijo [PROXY]', () => {
    assert.match(MOD, /console\.error\(`\[PROXY\]\$\{tag\}`, e\.message\)/);
  });
});

describe('net/proxy.js — setProxy', () => {
  test('valida tipo, host y puerto antes de tocar nada', () => {
    assert.match(MOD, /const TIPOS_VALIDOS = \/\^\(http\|https\|socks5\)\$\/;/);
    assert.match(
      MOD,
      /if \(proxyEnabled && \(!TIPOS_VALIDOS\.test\(proxyType\) \|\| !proxyHost \|\| !Number\.isInteger\(proxyPort\) \|\| proxyPort < 1 \|\| proxyPort > 65535\)\)/,
      'la validacion no debe cambiar'
    );
    assert.match(MOD, /return \{ ok: false, error: 'Configuración de proxy inválida' \};/);
  });

  // Apagar manda mode:'direct', no proxyRules:''. Una cadena vacia no es lo
  // mismo que "sin proxy" para Chromium.
  test('al apagar usa mode: direct y no una cadena vacia', () => {
    assert.match(MOD, /const destino = proxyEnabled \? \{ proxyRules \} : \{ mode: 'direct' \};/);
    assert.doesNotMatch(MOD, /proxyEnabled \? \{ proxyRules \} : \{ proxyRules: '' \}/);
  });

  // La principal sin catch (el error llega al renderer); los paneles con catch
  // silencioso. No es un descuido.
  test('la sesion principal falla hacia el renderer, los paneles no', () => {
    assert.match(MOD, /await session\.fromPartition\('persist:mc'\)\.setProxy\(destino\);/);
    assert.match(MOD, /await session\.fromPartition\(WEBCHAT_PARTITION\)\.setProxy\(destino\)\.catch\(\(\) => \{\}\);/);
    assert.match(MOD, /await session\.fromPartition\(WHATSAPP_PARTITION\)\.setProxy\(destino\)\.catch\(\(\) => \{\}\);/);
  });

  test('persiste en CFG y guarda antes de responder ok', () => {
    assert.match(MOD, /Object\.assign\(CFG, \{ proxyEnabled, proxyType, proxyHost, proxyPort \}\);\s*\n\s*saveCfg\(\);/);
    assert.match(MOD, /catch \(e\) \{ return \{ ok: false, error: e\.message \}; \}/);
  });
});

describe('net/proxy.js — el IPC', () => {
  test('proxy:set sigue registrado en bootstrap.js', () => {
    assert.match(MAIN, /ipcMain\.handle\('proxy:set', \(_e, settings = \{\}\) => Proxy\.setProxy\(settings\)\);/);
  });

  // Desde el paso 13 el módulo existe, asi que se importa y la firma se simplifica.
  test('las particiones se importan de sessions/partitions.js', () => {
    assert.match(
      MOD,
      /const \{ WEBCHAT_PARTITION, WHATSAPP_PARTITION \} = require\('\.\.\/sessions\/partitions'\);/
    );
    assert.doesNotMatch(codigo, /partitions\.webchat|partitions\.whatsapp/);
    assert.match(
      MAIN,
      /ipcMain\.handle\('proxy:set', \(_e, settings = \{\}\) => Proxy\.setProxy\(settings\)\);/
    );
  });
});