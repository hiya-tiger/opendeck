(function () {
  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core || !tauri.core.invoke) return;
  if (window.opendeckDesktop) return;

  const invoke = tauri.core.invoke;
  const listen = (event, handler) => {
    if (!tauri.event || !tauri.event.listen) return () => {};
    let unlisten = null;
    tauri.event.listen(event, (payload) => handler(payload.payload)).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  };

  const raw = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  const notWired = (what) => () =>
    Promise.reject(new Error(`${what} is not wired into the Tauri build yet`));

  window.opendeckDesktop = {
    platform: "tauri",
    versions: {
      tauri: tauri.app && tauri.app.version ? tauri.app.version() : undefined,
    },
    analysis: {
      fromFile: (path) => invoke("analyze_file", { path }),
      fromBytes: (bytes) => invoke("analyze_bytes_raw", raw(bytes)),
    },
    // D42: stream sources (partner keys, OAuth, decodable audio) are only
    // implemented in the Electron build; the Tauri shell reports none.
    streaming: {
      status: async () => ({ sources: [], widevineBuild: false, redirectUri: "" }),
      setKey: async () => ({ ok: false, error: "Streaming sources need the Electron build." }),
      clearKey: async () => ({ ok: false }),
      signIn: async () => ({ ok: false, error: "Streaming sources need the Electron build." }),
      signOut: async () => ({ ok: false }),
      request: async () => ({ status: 0, body: "", error: "network", detail: "Streaming sources need the Electron build." }),
      audio: async () => ({ ok: false, error: "Streaming sources need the Electron build." }),
    },
    media: {
      fetch: async (url) => {
        const bytes = await invoke("media_fetch_raw", { url });
        return { ok: true, bytes: new Uint8Array(bytes) };
      },
    },
    recording: {
      save: (_name, bytes) => invoke("recording_save_raw", raw(bytes)),
    },
    rtmp: {
      available: () => invoke("rtmp_available"),
      start: (endpoint, key) => invoke("rtmp_start", { endpoint, key }),
      chunk: (chunk) => invoke("rtmp_chunk_raw", raw(chunk)),
      stop: () => invoke("rtmp_stop"),
      onLog: (handler) => listen("rtmp:log", handler),
      onExit: (handler) => listen("rtmp:exit", handler),
    },
    unsupported: notWired,
  };

  window.__opendeckRuntime = "tauri";
})();
