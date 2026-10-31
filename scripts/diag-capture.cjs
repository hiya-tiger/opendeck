const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const logFile = path.join(process.env.TEMP || '/tmp', 'opendecks-renderer-crash.log');
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(logFile, line);
};

// Clear previous log
fs.writeFileSync(logFile, '');

app.whenReady().then(() => {
  log('app.whenReady fired');
  
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    title: 'OpenDecks Diagnostic',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  log('Window created, loading renderer/index.html');
  
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

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
    log('Window closed event');
  });

  win.on('unresponsive', () => {
    log('Window unresponsive');
  });
});

app.on('window-all-closed', () => {
  log('window-all-closed');
  app.quit();
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
