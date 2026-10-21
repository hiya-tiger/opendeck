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
    streaming: {
      login: (provider, url, hints) => invoke("streaming_login", { provider, url, hints }),
      open: (provider, url, hints) => invoke("streaming_open", { provider, url, hints }),
      status: (provider, hints) => invoke("streaming_status", { provider, hints }),
      logout: (provider) => invoke("streaming_logout", { provider }),
      search: (provider, url) => invoke("streaming_search", { provider, url }),
      onLogin: (handler) => listen("streaming:login", handler),
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
