'use strict';
/**
 * MC Browser -- src/main/stats/process-metrics.js
 *
 * Ahora solo registra el handler 'get-sysinfo' (datos del sistema: SO, CPU,
 * memoria, versiones y carpeta de descargas). Lo consume el renderer en la
 * seccion de informacion del sistema de Ajustes, via preload.getSysinfo().
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
const { app, ipcMain } = require('electron');
const { CFG } = require('../config');

ipcMain.handle('get-sysinfo', () => ({
  hostname: os.hostname(), platform: os.platform(), arch: os.arch(),
  cpus: os.cpus().length, totalMemory: os.totalmem(), freeMemory: os.freemem(),
  uptime: os.uptime(), nodeVersion: process.version, electronVersion: process.versions.electron,
  chromeVersion: process.versions.chrome,
  dlDir: CFG.downloadDir || app.getPath('downloads')
}));