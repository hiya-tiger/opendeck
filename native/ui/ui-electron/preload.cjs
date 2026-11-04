const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("__TAURI__", { core: { invoke: (cmd, a) => ipcRenderer.invoke("inv", cmd, a) } });
