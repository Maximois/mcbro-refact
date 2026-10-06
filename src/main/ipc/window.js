'use strict';
/**
 * MC Browser -- src/main/ipc/window.js
 *
 * Los canales de control de la ventana principal: win-min, win-max, win-ismax,
 * win-close y open-external. Son los que usa la titlebar.
 */

const { ipcMain, shell } = require('electron');
const { getMainWin } = require('../runtime');

function registerWindowIpc() {
  ipcMain.handle('win-min', (e) => getMainWin()?.minimize());
  ipcMain.handle('win-max', (e) => getMainWin()?.isMaximized() ? getMainWin().unmaximize() : getMainWin()?.maximize());
  ipcMain.handle('win-ismax', (e) => getMainWin()?.isMaximized() || false);
  ipcMain.handle('win-close', (e) => getMainWin()?.close());
  ipcMain.handle('open-external', (e, url) => {
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://')))
      shell.openExternal(url);
  });
}

module.exports = { registerWindowIpc };
