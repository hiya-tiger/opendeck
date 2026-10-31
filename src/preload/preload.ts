import { contextBridge, ipcRenderer, webUtils } from "electron";

const on = (channel: string, handler: (payload: unknown) => void): (() => void) => {
  const listener = (_event: unknown, payload: unknown): void => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const videoApi = {
  openOutput: (opts?: { fullscreen?: boolean } | boolean) => ipcRenderer.invoke("video:open-output", typeof opts === "boolean" ? { fullscreen: opts } : opts),
  closeOutput: () => ipcRenderer.invoke("video:close-output"),
  fullscreenOutput: (fullscreen?: boolean) => ipcRenderer.invoke("video:fullscreen-output", fullscreen),
  statusOutput: () => ipcRenderer.invoke("video:status-output"),
  syncOutput: (state: unknown) => ipcRenderer.invoke("video:sync-output", state),
  onOutputState: (handler: (payload: unknown) => void) => on("video:output-state", handler),
  onOutputClosed: (handler: (payload: unknown) => void) => on("video:output-closed", handler),
};

const api = {
  platform: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome },
  streaming: {
    login: (provider: string, url: string, hints: string[]) => ipcRenderer.invoke("streaming:login", provider, url, hints),
    open: (provider: string, url: string, hints: string[]) => ipcRenderer.invoke("streaming:open", provider, url, hints),
    status: (provider: string, hints: string[]) => ipcRenderer.invoke("streaming:status", provider, hints),
    logout: (provider: string) => ipcRenderer.invoke("streaming:logout", provider),
    search: (provider: string, url: string, token?: string) => ipcRenderer.invoke("streaming:search", provider, url, token),
    license: (provider: string, licenseUrl: string, challenge: Uint8Array, token?: string) =>
      ipcRenderer.invoke("streaming:license", provider, licenseUrl, challenge, token),
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
    writeLibrary: (request: unknown) => ipcRenderer.invoke("serato:export-library", request),
    exportLibrary: (request: unknown) => ipcRenderer.invoke("serato:export-library", request),
    applyCrateColumns: (request: unknown) => ipcRenderer.invoke("serato:apply-crate-columns", request),
    sqliteColumns: (request: unknown) => ipcRenderer.invoke("serato:apply-crate-columns", request),
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
  video: videoApi,
  link: {
    status: () => ipcRenderer.invoke("link:status"),
    enable: () => ipcRenderer.invoke("link:enable"),
    disable: () => ipcRenderer.invoke("link:disable"),
    setLocalTempo: (bpm: number) => ipcRenderer.invoke("link:set-tempo", bpm),
  },
  djmedia: {
    state: () => ipcRenderer.invoke("djmedia:state"),
    settings: (patch: unknown) => ipcRenderer.invoke("djmedia:settings", patch),
    forget: (mediaKey?: string) => ipcRenderer.invoke("djmedia:forget", mediaKey),
    respond: (sourceId: string, action: "add" | "ignore", always: boolean) => ipcRenderer.invoke("djmedia:respond", sourceId, action, always),
    loadTrack: (sourceId: string, trackId: string) => ipcRenderer.invoke("djmedia:load-track", sourceId, trackId),
    onStatus: (handler: (payload: unknown) => void) => on("djmedia:status", handler),
    onPrompt: (handler: (payload: unknown) => void) => on("djmedia:prompt", handler),
    onPromptCleared: (handler: (payload: unknown) => void) => on("djmedia:prompt-cleared", handler),
    onLibrary: (handler: (payload: unknown) => void) => on("djmedia:library", handler),
    onRemoved: (handler: (payload: unknown) => void) => on("djmedia:removed", handler),
    onProgress: (handler: (payload: unknown) => void) => on("djmedia:progress", handler),
  },
  videoOpenOutput: videoApi.openOutput,
  videoCloseOutput: videoApi.closeOutput,
  videoFullscreenOutput: videoApi.fullscreenOutput,
  videoSyncOutput: videoApi.syncOutput,
  onVideoOutputState: videoApi.onOutputState,
};

contextBridge.exposeInMainWorld("opendeckDesktop", api);
contextBridge.exposeInMainWorld("opendeck", api);
