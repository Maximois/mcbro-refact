'use strict';
/**
 * MC Browser -- src/main/stats/process-metrics.js
 *
 * Ahora solo registra el handler 'get-sysinfo' (datos del sistema: SO, CPU,
 * memoria, versiones y carpeta de descargas) mas el bloque `build`: sello,
 * commit y nombre del instalador que corresponde a esta app. Lo consume el
 * renderer en la seccion de informacion del sistema de Ajustes, via
 * preload.getSysinfo().
 *
 * -----------------------------------------------------------------------------
 * QUE SE QUITO DE AQUI Y POR QUE
 * -----------------------------------------------------------------------------
 * Antes este modulo tambien era el unico muestreador de CPU/RAM por proceso:
 * PROCESS_METRICS_CACHE, sampleProcessMetrics(), startProcessMetricsSampler(),
 * stopProcessMetricsSampler() y el handler 'get-processes', que alimentaba la
 * fila "CPU" de la barra de estado (startStatusBarResources() en el renderer).
 * Se elimino completo: el unico muestreo era de CPU/RAM y ya no se ense.
 *
 * Al quitarlo desaparecio su TRAMPA 2 (las unidades de memoria: workingSetSize
 * viene en KILOBYTES, y tasklist.exe ya entrega MB) y la TRAMPA 1 (que
 * startProcessMetricsSampler() se llamaba dos veces, en whenReady y en
 * 'activate'). Ninguna de las dos aplica ya a este archivo.
 *
 * -----------------------------------------------------------------------------
 * POR QUE EL ARCHIVO SE SIGUE LLAMANDO process-metrics.js
 * -----------------------------------------------------------------------------
 * Por el archivo, no por lo que hace. Renombrarlo a sysinfo.js obligaria a
 * tocar test/ipc-channels.test.js, que comprueba que 'get-sysinfo' se declara
 * aqui, y no compensa el ruido de un rename sin cambios de comportamiento.
 *
 * QUE NO DEBE HACER
 *   - No decidir nada de descargas ni de medios. Eso vive en src/main/downloads/.
 *   - No volver a llamar a app.getAppMetrics(). Se elimino el unico muestreador
 *     porque toda la app compartia esa llamada: app.getAppMetrics() promedia CPU
 *     desde la ultima vez que CUALQUIER codigo del proceso principal la llamo, y
 *     reinicia la ventana de medicion para todos los procesos a la vez. Si se
 *     reintroduce una llamada suelta desde otro sitio, los porcentajes vuelven a
 *     depender de quien llame antes.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, ipcMain } = require('electron');
const { CFG } = require('../config');

// Sello de build embebido por tools/build-installer.js al empaquetar. No existe
// en dev ni si se empaqueto con electron-builder directo: en esos casos la app
// responde `build: null` y el renderer muestra "sin sello".
function readBuildInfo() {
  try {
    const file = path.join(app.getAppPath(), 'build-info.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

ipcMain.handle('get-sysinfo', () => {
  const buildInfo = readBuildInfo();
  return {
    hostname: os.hostname(), platform: os.platform(), arch: os.arch(),
    cpus: os.cpus().length, totalMemory: os.totalmem(), freeMemory: os.freemem(),
    uptime: os.uptime(), nodeVersion: process.version, electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    // Alias con los nombres que el renderer ya consume en "Acerca de":
    // ab-electron, ab-chrome, ab-node, ab-mem, ab-datadir.
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.version,
    mem: (os.totalmem() / 1073741824).toFixed(2) + ' GB',
    dataDir: app.getPath('userData'),
    dlDir: CFG.downloadDir || app.getPath('downloads'),
    build: buildInfo ? {
      label: buildInfo.artifactName || '',
      stamp: buildInfo.stamp || '',
      commit: buildInfo.commit || '',
      clean: buildInfo.clean === true,
      packageVersion: buildInfo.version || ''
    } : null
  };
});