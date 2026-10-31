const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 800, height: 600 });
  win.loadURL('https://example.com');
  console.log('Minimal window opened');
});

app.on('window-all-closed', () => {
  console.log('All windows closed');
  app.quit();
});
