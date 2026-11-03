# Streaming source setup

OpenDecks ships no service credentials, never scrapes service pages, never uses yt-dlp, and never decrypts or bypasses DRM. Each streaming source uses the service's official API and needs a key from that service's developer or partner programme. Until a key is saved, the source shows **needs partner API key** and does nothing else. Design notes: [decisions D42](decisions.md).

Keys go in **Stream > (service) > Partner client id / Client secret > Save key**. They are stored by the desktop app in its data folder, encrypted with the OS keychain when available, and never shown again. **Sign in** opens the service's own sign-in page in your browser; it returns to OpenDecks through `http://127.0.0.1:43827/callback`, so register that exact redirect URI with the service.

## What plays where

| Source | Key from | Sign-in | On the deck |
| --- | --- | --- | --- |
| Beatport LINK | Beatport partner portal (licensed DJ-software partners only) | Required, plus a LINK subscription | Full deck path when the stream endpoint returns plain audio; encrypted streams are refused with a message |
| Beatsource LINK | Beatsource partner programme (same API family) | Required, plus a subscription | As Beatport |
| TIDAL | developer.tidal.com app (client id + secret) | Optional (your collection) | Plain manifests (usually previews) on the full deck path; DRM manifests play in TIDAL's embedded player, monitor only |
| SoundCloud | soundcloud.com/you/apps or the SoundCloud API CLI (client id + secret) | Optional (likes, playlists) | Public-API MP3/HLS streams on the full deck path; previews labelled; blocked tracks refused; widget as fallback |
| Web players | Nothing | None | Paste a Spotify, Apple Music, Deezer, YouTube, TIDAL, SoundCloud or Beatport link: the official player in the deck, monitor only |

**Full deck path** means the audio is decoded once like a local file: BPM/key analysis, waveform, stems, EQ, FX, sync, loops.

**Monitor only** means the official player runs inside the deck panel. Its audio is cross-origin or decrypted inside the Widevine CDM, so it can't reach Web Audio: no EQ, FX, waveform, sync or analysis. To put it in the mix, use **System audio capture (AUX)**.

## Widevine

Spotify, Apple Music, Deezer and most TIDAL full tracks play only through Widevine (or FairPlay). Stock Electron has no Widevine CDM, so in the standard OpenDecks build those embedded players show previews only. Full DRM tracks in the embedded players need a Widevine-enabled Electron build (castlabs "Electron for Content Security", plus their VMP signing for production). Even then the audio stays monitor-only.

## Per-service notes

### Beatport / Beatsource LINK
- API: `https://api.beatport.com/v4` / `https://api.beatsource.com/v4`. OAuth: `/auth/o/authorize/`, `/auth/o/token/` (authorization code + PKCE; no client-credentials grant).
- Search `/catalog/search/?type=tracks`, browse `/my/playlists/`, `/catalog/genres/{id}/top/100/`, stream `/catalog/tracks/{id}/stream/`.
- The streaming contract is in Beatport's partner SDK documentation (partner login). It has not been verified against a live partner key.

### TIDAL
- Token: `https://auth.tidal.com/v1/oauth2/token` (client credentials with HTTP Basic, or PKCE via `https://login.tidal.com/authorize`, scopes `playback search.read collection.read playlists.read user.read`).
- Search `GET /v2/searchResults?filter[query]=…&include=tracks`, names via `GET /v2/tracks?filter[id]=…&include=artists,albums`, playback `GET /v2/trackManifests/{id}`. DJ-grade TIDAL streaming (as in Serato/rekordbox) is a separate partner agreement and is not implemented.

### SoundCloud
- OAuth 2.1 at `https://secure.soundcloud.com` (PKCE required; all clients are confidential, so the secret is needed). API calls send `Authorization: OAuth <token>`.
- Search `GET /tracks?q=…&access=playable,preview`, streams `GET /tracks/{urn}/streams`. SoundCloud's attribution rules ask for uploader credit, SoundCloud as source and a link to the track. The deck shows the uploader and "via SoundCloud" with the track URL as its tooltip; a clickable link and the SoundCloud logo are still to do and check the API Terms before public performance use.

## Legal notes

- Do not bundle any service's client secret in a build. Keys are per installation.
- DJ/public performance may need commercial terms from the service. This document is setup guidance, not a licence.
- OpenDecks stays MIT; provider APIs and players remain under their own terms.
