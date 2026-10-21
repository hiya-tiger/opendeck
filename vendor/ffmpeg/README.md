# Bundled FFmpeg

OpenDeck ships a static FFmpeg build for RTMP broadcasting so users do not need to install anything.

- Build: `ffmpeg-N-127790-g56dbd4cd37-win64-lgpl` from BtbN's FFmpeg-Builds (Windows x64, LGPLv3 build, static).
- Source archive: <https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-20-13-08/ffmpeg-N-127790-g56dbd4cd37-win64-lgpl.zip>.
- Binary: `win32-x64/ffmpeg.exe`, SHA-256 `8E591D65C30C6844EFCEC55AA70678039C1F6925C5E87C4880F9CBF018E2133B`, 138361856 bytes.
- Version banner: `ffmpeg version N-127790-g56dbd4cd37-20261020`.
- License: see `win32-x64/LICENSE.txt` (LGPLv3). Corresponding source is available from the FFmpeg project and the BtbN build scripts linked on the release page.

The executable is not committed to git because GitHub rejects files over 100 MB. Fetch it with:

```
npm run fetch:ffmpeg
```

The script downloads the pinned archive, verifies the SHA-256 above, and writes `win32-x64/ffmpeg.exe`. `npm run build` (and therefore `npm start`) runs it automatically. Run it once before a Tauri build.

FFmpeg runs as a separate process and is not linked into OpenDeck, so the app remains MIT licensed. When updating, change the archive URL, version, size and hash in `scripts/fetch-ffmpeg.mjs` and this file, then refresh `LICENSE.txt`. The app resolves the binary from `vendor/ffmpeg/<platform>/` in development and from the bundle resources when packaged, then falls back to `ffmpeg` on `PATH`.

Only Windows x64 is bundled today. On Linux/macOS the app uses `ffmpeg` from `PATH`; add a matching platform directory to bundle it there too.
