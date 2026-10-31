const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    title: 'OpenDecks Diagnostic',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'blank.html'));

  win.webContents.on('did-finish-load', () => {
    console.log('Blank page loaded');
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.log('Renderer gone:', details.reason, details.exitCode);
  });

  win.on('closed', () => {
    console.log('Window closed');
    app.quit();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
