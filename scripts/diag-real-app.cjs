const { app, BrowserWindow, ipcMain, session, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const logFile = path.join(process.env.TEMP || '/tmp', 'opendecks-real-app.log');
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(logFile, line);
};
fs.writeFileSync(logFile, '');

const root = () => app.getAppPath();

const createWindow = () => {
  log('Creating main window');
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    title: 'OpenDecks',
    backgroundColor: '#f4f6fd',
    webPreferences: {
      preload: path.join(root(), 'dist', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: true,
    },
  });
  log('Loading renderer/index.html');
  win.loadFile(path.join(root(), 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => {
    log('Renderer did-finish-load');
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    log(`Renderer did-fail-load: ${errorCode} ${errorDescription}`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    log(`Renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });

  win.webContents.on('crashed', (_event, killed) => {
    log(`Renderer crashed: killed=${killed}`);
  });

  win.on('closed', () => {
    log('Window closed');
  });

  win.on('unresponsive', () => {
    log('Window unresponsive');
  });

  // Stub the IPC handlers the renderer polls
  ipcMain.handle('rtmp:available', async () => false);
  ipcMain.handle('streaming:status', async () => ({ providers: [], active: null }));
  ipcMain.handle('link:status', async () => ({ enabled: false, peers: 0, tempo: 0 }));
  ipcMain.handle('link:enable', async () => ({ ok: false }));
  ipcMain.handle('link:disable', async () => {});
  ipcMain.handle('link:set-tempo', async () => {});

  return win;
};

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(() => {
  log('app.whenReady fired');
  createWindow();

  app.on('activate', () => {
    log('app.activate');
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  log('window-all-closed');
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  log('will-quit');
});

app.on('gpu-process-crashed', (_event, killed) => {
  log(`GPU process crashed: killed=${killed}`);
});

app.on('child-process-gone', (_event, details) => {
  log(`Child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
});
