const { app, BrowserWindow } = require('electron');

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

  win.loadURL('data:text/html,<h1>Data URL test</h1>');

  win.webContents.on('did-finish-load', () => {
    console.log('Data URL loaded');
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
