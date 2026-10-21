# Streaming provider setup

OpenDeck never ships service credentials and never bypasses DRM. Every provider below needs its own developer app, and playback stays inside that provider's player. Because browsers do not expose iframe or DRM audio to Web Audio, streamed tracks are mixed through **System audio capture (AUX)**: deck faders and EQ act on the captured signal, not on the stream itself.

Current status:

| Service | Search / metadata | In-app playback | What it needs |
| --- | --- | --- | --- |
| YouTube Music | Yes, inside the signed-in session | Yes, official `youtube-nocookie.com` embed | Nothing (works today) |
| Spotify | Web API after OAuth | Web Playback SDK (Widevine) | Spotify Premium + developer app client ID |
| Apple Music | MusicKit JS | MusicKit JS (DRM) | Apple Developer token + Apple Music subscription |
| TIDAL | Partner API only | Not publicly available | TIDAL partnership / player SDK |
| Beatport | No public API | Not publicly available | Beatport LINK partnership |
| Beatsource | No public API | Not publicly available | Beatsource LINK partnership |
| SoundCloud | Public API with client ID | Widget player | SoundCloud app client ID (+ user OAuth for private tracks) |
| Deezer | Public search API | Not integrated | App ID / OAuth for personal libraries |

## Spotify

Requirements: **Spotify Premium** (the Web Playback SDK refuses free accounts) and a Spotify developer app. No client secret is needed: desktop apps use OAuth 2.0 Authorization Code with PKCE.

1. Open <https://developer.spotify.com/dashboard> and create an app.
2. Add the redirect URI `http://127.0.0.1:43827/callback`. Spotify allows loopback `http://127.0.0.1:<port>` redirect URIs for desktop apps; if the dashboard rejects it, use an HTTPS redirect you control and paste the returned `code`/`state` back into OpenDeck.
3. Select the Web API and Web Playback SDK. Requested scopes: `streaming`, `user-read-email`, `user-read-private`, `user-read-playback-state`, `user-modify-playback-state`, and optionally `playlist-read-private`.
4. Copy the **Client ID** (not the secret).
5. When OpenDeck asks, paste the Client ID under Stream > Spotify > Connect. The app opens the Spotify consent page in a child window, receives the code on the loopback listener, exchanges it with PKCE, and stores the refresh/access tokens in the app data directory (not in `localStorage`).
6. Load `https://sdk.scdn.co/spotify-player.js`, call `Spotify.Player` with the access token, and transfer playback to the OpenDeck device. The SDK requires Widevine; the Tauri/WebView2 build reports Widevine support, but this still needs a live Premium account to verify.

Notes:

- Client secrets must never be bundled in a desktop app. PKCE is the supported public-client flow.
- Logout must revoke the token (`POST https://accounts.spotify.com/api/token` is not enough; call the token revocation endpoint) and clear the loopback listener.
- Playback must start after a user gesture; browsers block autoplay with audio.

## Apple Music

Requirements: an Apple Developer Program membership and an Apple Music subscription for full playback.

1. In the Apple Developer portal, create a **MusicKit identifier** and a **MusicKit private key** (`.p8`). Note the Team ID and Key ID.
2. Generate a developer token (ES256 JWT): header `{ "alg": "ES256", "kid": "<KeyID>" }`, payload `{ "iss": "<TeamID>", "iat": <now>, "exp": <now + up to 15777000> }`. If you restrict the token to a web origin, add `"origin": "http://tauri.localhost"` (the Tauri webview origin) or the origin you serve the UI from.
3. Paste the token into Stream > Apple Music > Connect. OpenDeck configures MusicKit JS (`https://js-cdn.music.apple.com/musickit/v3/musickit.js`) with `developerToken` and calls `music.authorize()` inside a user gesture.
4. Tokens expire after at most six months; document the rotation date and regenerate before it lapses.

Notes:

- MusicKit playback is DRM protected. Confirm FairPlay/Widevine playback inside WebView2 before advertising it as supported; the current DRM probe only proves EME is present.
- Apple's terms require the Apple Music badge and player chrome for web playback.

## TIDAL

- TIDAL's public API (metadata, search) is partner-gated; there is no public web playback SDK.
- Playback requires a TIDAL partner agreement and their player SDK; API-only access yields metadata and at best short previews.
- Until a partnership exists, OpenDeck keeps TIDAL as a signed-in service window plus system capture. Do not attempt to extract or decrypt TIDAL streams.
- If access is granted, use OAuth 2.0 + PKCE and keep tokens in the app data directory.

## Beatport and Beatsource

- Both are catalog/DJ-store services. Streaming is sold through **Beatport LINK** / **Beatsource LINK**, which is licensed to hardware and DJ-software partners; there is no public playback API or SDK.
- Their public sites can be opened and searched in a service window, and tracks can be sent to the queue as deep links.
- A real integration needs a LINK partnership and their player SDK; without it, in-app playback is not legally or technically possible.

## SoundCloud

Requirements: a SoundCloud app (client ID) for search; user OAuth for private tracks and likes.

1. Register an app at <https://soundcloud.com/you/apps> and copy the **Client ID**. Use PKCE for user authorization; a distributed desktop app cannot keep a client secret.
2. Search: `GET https://api.soundcloud.com/tracks?q=<query>&client_id=<id>&limit=20`. Filter by `streamable` and `policy` before offering playback.
3. Playback: load the Widget API (`https://w.soundcloud.com/player/api.js`) and an iframe pointing at `https://w.soundcloud.com/player/?url=<track-url>&client_id=<id>`. The widget supports play/pause/seek and position events, but its audio is cross-origin and cannot be routed into Web Audio; use system capture.
4. Some tracks are geo-blocked, preview-only or not streamable through the API. Show the provider's message instead of retrying.

## Deezer (optional)

- Public search API works without a key; personal libraries and full playback need an app ID and OAuth.
- Playback is DRM protected and not integrated; keep it as a service window.

## Shared implementation checklist (when credentials arrive)

1. Add credential storage in Rust under the app config directory with restrictive permissions; never commit tokens or client secrets.
2. Add a loopback OAuth listener on `127.0.0.1:43827` for Spotify (and SoundCloud if user auth is added), with `state` validation and a timeout.
3. Add `streaming/spotify.ts`, `streaming/apple.ts`, `streaming/soundcloud.ts` adapters that expose the same `QueueTrack` shape as `streaming/youtube.ts`.
4. Extend `playStreamOnDeck` to accept provider embeds/SDK players, while keeping the "AUX capture" warning for anything that cannot join Web Audio.
5. Add tests for URL parsing, token expiry, PKCE challenge generation and provider error mapping. Live playback tests require real accounts and cannot run in CI.
6. Update the Stream tab with a per-provider credential card (Client ID / developer token), connection status and a "Revoke" action.

## Legal notes

- Do not bundle or repackage any provider's proprietary player, and do not circumvent Widevine, FairPlay or PlayReady.
- DJ/public performance use may require commercial terms from the service (for example Beatport LINK or a SoundCloud commercial plan). This document is setup guidance, not a license.
- Keep the app's MIT license; provider SDKs remain under their own terms.
