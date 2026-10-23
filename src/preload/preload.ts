import { contextBridge, ipcRenderer, webUtils } from "electron";

const on = (channel: string, handler: (payload: unknown) => void): (() => void) => {
  const listener = (_event: unknown, payload: unknown): void => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("opendeckDesktop", {
  platform: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome },
  streaming: {
    login: (provider: string, url: string, hints: string[]) => ipcRenderer.invoke("streaming:login", provider, url, hints),
    open: (provider: string, url: string, hints: string[]) => ipcRenderer.invoke("streaming:open", provider, url, hints),
    status: (provider: string, hints: string[]) => ipcRenderer.invoke("streaming:status", provider, hints),
    logout: (provider: string) => ipcRenderer.invoke("streaming:logout", provider),
    search: (provider: string, url: string) => ipcRenderer.invoke("streaming:search", provider, url),
    onLogin: (handler: (payload: unknown) => void) => on("streaming:login", handler),
  },
  media: {
    fetch: (url: string) => ipcRenderer.invoke("media:fetch", url),
    pathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  separation: {
    status: () => ipcRenderer.invoke("separation:status"),
    install: () => ipcRenderer.invoke("separation:install"),
    cache: (request: { hash: string; trackPath?: string | null }) => ipcRenderer.invoke("separation:cache", request),
    run: (request: unknown) => ipcRenderer.invoke("separation:run", request),
    read: (dir: string) => ipcRenderer.invoke("separation:read", dir),
    onProgress: (handler: (payload: unknown) => void) => on("separation:progress", handler),
  },
  serato: {
    running: () => ipcRenderer.invoke("serato:running"),
    writeTags: (request: unknown) => ipcRenderer.invoke("serato:write-tags", request),
    undo: () => ipcRenderer.invoke("serato:undo"),
  },
  recording: {
    save: (name: string, bytes: Uint8Array) => ipcRenderer.invoke("recording:save", name, bytes),
  },
  rtmp: {
    available: () => ipcRenderer.invoke("rtmp:available"),
    start: (endpoint: string, key: string) => ipcRenderer.invoke("rtmp:start", endpoint, key),
    chunk: (chunk: Uint8Array) => ipcRenderer.invoke("rtmp:chunk", chunk),
    stop: () => ipcRenderer.invoke("rtmp:stop"),
    onLog: (handler: (payload: unknown) => void) => on("rtmp:log", handler),
    onExit: (handler: (payload: unknown) => void) => on("rtmp:exit", handler),
  },
});
