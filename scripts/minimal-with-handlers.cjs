const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 800, height: 600 });
  win.loadURL('https://example.com');
  console.log('Minimal window opened');

  win.on('closed', () => {
    console.log('Window closed');
    app.quit();
  });
});

app.on('window-all-closed', () => {
  console.log('All windows closed');
  app.quit();
});
