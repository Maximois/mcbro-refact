#!/usr/bin/env node
/**
 * Test simple para verificar que el IPC está funcionando
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let win;

app.whenReady().then(() => {
  // Registrar handler de test
  ipcMain.handle('test-ipc', () => {
    console.log('[MAIN] test-ipc handler called');
    return { ok: true, message: 'IPC works!' };
  });

  win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile(path.join(__dirname, 'src', 'renderer.html'));
  win.webContents.openDevTools();
});

app.on('window-all-closed', () => {
  app.quit();
});
