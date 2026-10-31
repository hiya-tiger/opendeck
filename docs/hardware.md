# Hardware controllers and samplers

OpenDecks uses Web MIDI, so any class-compliant USB-MIDI device works without a driver install on Windows 10/11, macOS and Linux. The Tauri/WebView2 build grants the MIDI permission in the host; the Electron build uses Chromium's own permission handling.

## What is supported

| Device type | Examples | Behaviour |
| --- | --- | --- |
| Built-in presets | Hercules DJControl T10, Numark Party Mix III | Transport, pads, tempo and mixer controls are mapped automatically when the device name matches |
| Drum / sampler pads | Roland SP-404MKII, Akai MPC pads, Novation Launchpad | Notes 36-43 play sampler pads 1-8 with velocity; other notes and CCs can be learned |
| Keyboard controllers | Akai MPK Mini, Arturia MiniLab, Novation Launchkey | Pads and keys send notes; knobs send CCs; use Learn to bind transport, EQ, faders or pads |
| MIDI interfaces / routers | CME U6MIDI Pro, iConnectivity mio | Routes any connected keyboard or pad bank into OpenDecks; OpenDecks sees the interface's input port |
| Generic USB-MIDI keyboard | Any class-compliant device | Same as above; no vendor driver needed |

OpenDecks does not require or use SysEx. It lists all connected inputs and re-scans on hot-plug.

## Quick start

1. Connect the device by USB. If the maker supplies a driver or control app (Roland, Akai, Arturia), install it only when the device is not recognised as a class-compliant MIDI port.
2. Open the mixer's **MIDI** card and press **Enable MIDI**.
3. The card lists each input with its manufacturer. If the list stays empty, unplug and replug the device, or check the device's USB-MIDI mode. A recognised controller shows its preset name next to the input.
4. Built-in presets fill any targets that are not already mapped. A binding you learned yourself always wins, and **Clear** still removes individual mappings.
5. Play a pad or move a knob: the live monitor shows `ch1 note 36 vel 100` or `ch1 CC74 64`.
6. Pads on notes 36-43 (C1-G1) play sampler pads 1-8 immediately. For anything else, choose a target in the dropdown, press **Learn**, then move that control.

## Recommended mappings

| Target | Suggested control |
| --- | --- |
| Deck A/B play, cue, sync, loop | Transport buttons or pad bank |
| Channel A/B faders, crossfader, master | Sliders |
| Deck tempo / filter | Knobs (CC) |
| Hot cues 1-8 | Pad bank |
| Sampler 1-8 | Notes 36-43, or any pads learned to `Sampler n` |

Mappings are stored per browser profile in `localStorage` under `opendeck.midi.map.v1`. **Clear** removes the mapping for the selected target only.

## Device notes

### Hercules DJControl T10

- The preset follows Hercules' DJUCED MIDI map: deck buttons on channels 2 and 3, hot-cue pads on channels 7 and 8, channel faders on CC0, crossfader on channel 1 CC0, tempo on CC8, EQ on CC2-4 and trim on CC5.
- Hot cues 1-8 are the first pad page (notes 0-7). Deck A's sampler page (notes 48-55) is mapped to OpenDecks's sampler; switch the pad page on the controller to use it.
- The T10 has no software master fader or headphone-mix CC in DJUCED's map, so those targets stay unbound. Use Learn if your firmware sends different controls.
- Motorised platters and LED feedback are not driven by OpenDecks; the platters still send MIDI and can be learned.

### Numark Party Mix III

- The preset follows the community Mixxx mapping: play/cue/sync on notes 0-2, tempo on CC0, pads 1-4 on notes 20-23, and channel faders on CC22.
- Crossfader and master are on MIDI channel 16 (CC8 and CC10). The cue-mix knob and filter knobs are not mapped because OpenDecks has no matching targets.
- Only four hot cues per deck are exposed by the controller. Pads 5-8 remain available through Learn with another controller.

### Roland SP-404MKII

- Acts as a USB audio interface and a USB-MIDI device. OpenDecks uses the MIDI port; audio can be routed separately through the OS or an audio interface.
- Install the Roland driver if Windows does not expose a MIDI port. Set the device's USB mode to **Vendor** when using the Roland driver, or **Generic** for class-compliant operation.
- Pads send notes; bank A defaults to 36-43, which triggers OpenDecks's sampler immediately. Use Learn if your bank starts elsewhere.
- The SP-404MKII's own effects and sequencer remain on the device; OpenDecks only receives MIDI.

### Akai MPK Mini

- Class compliant on Windows/macOS. The eight pads send notes 36-43 by default on many presets, so they map to the sampler with no setup.
- Keys send notes outside the drum range; bind them with Learn to a deck action if you want keyboard-triggered transport or cues.
- Use the Akai editor to change pad notes or CC numbers if a preset conflicts with another controller.

### CME U6MIDI Pro

- A router/interface rather than a controller. Connect the keyboard or pad device to its MIDI input (or USB host port) and route that port to USB.
- OpenDecks sees the U6MIDI Pro input; all upstream channels and notes arrive unchanged. Channel numbers are preserved, so a binding learned on channel 3 stays on channel 3.
- Use the CME app to merge or filter ports if you want one OpenDecks input for several devices.

### Generic plug-in keyboards

- If notes 36-43 are unavailable, open **Learn**, choose `Sampler 1`, and press the key or pad you want. Repeat for each pad.
- Velocity is passed to the sampler for note triggers, so soft and hard hits differ.
- Controllers that send only Note On/Off and no CC still work for pads and transport. Modulation and pitch-bend messages are ignored unless mapped.

## Troubleshooting

- **No devices listed:** confirm the OS sees the MIDI port (Windows Device Manager or macOS Audio MIDI Setup). Close other apps that may hold the port exclusively.
- **Enable does nothing:** the card times out after six seconds instead of hanging. Use the Tauri/WebView2 or Electron build; a plain browser may require a permission prompt.
- **Wrong device responds:** bindings store the MIDI channel. Learn the control again with only that device connected, or clear the old binding.
- **Double triggers:** some controllers send both Note On and a CC for the same pad. Clear one of the two learned mappings.
- **No sound from pads:** the sampler feeds the master bus, so check the mixer's master level, the sampler volume slider and the browser's audio output.

Physical-device testing is still pending for the DJControl T10, Party Mix III, SP-404MKII, MPK Mini and U6MIDI Pro. The T10 values come from DJUCED's bundled `DJControl_T10.djm`, the Party Mix III values from the community Mixxx mapping, and the MIDI parser, presets, learn flow and persistence have unit tests.

## Supported Hardware Catalogue (195 Devices)

OpenDecks includes built-in presets and USB MIDI / USB Audio auto-detection for **195** DJ controllers, all-in-one systems, battle/club mixers, DVS interfaces, media players, motorized turntables, and pad/rhythm accessories (plus the legacy Hercules DJControl T10 and Numark Party Mix III presets). Connecting a 4-deck controller automatically enables the 4-deck workspace, and connecting a DVS mixer or audio interface badges it as `[DVS Ready]` or `[DVS Upgrade]` in the DVS input selector.

### 2-Deck Controllers (66)

| Device | Vendor | Decks | DVS |
| --- | --- | --- | --- |
| Hercules DJControl T10 | Hercules | 2 | — |
| Numark Party Mix III | Numark | 2 | — |
| Numark MixTrack Go | Numark | 2 | — |
| Hercules DJControl Inpulse 200 MK3 | Hercules | 2 | — |
| RANE ONE MKII | RANE | 2 | — |
| Pioneer DJ DDJ-RB | Pioneer DJ | 2 | — |
| AlphaTheta DDJ-FLX2 | AlphaTheta | 2 | — |
| Pioneer DJ DDJ-400 | Pioneer DJ | 2 | — |
| Pioneer DJ DDJ-200 | Pioneer DJ | 2 | — |
| AlphaTheta OMNIS-DUO | AlphaTheta | 2 | — |
| Pioneer DJ DDJ-REV5 | Pioneer DJ | 2 | — |
| Hercules DJControl Inpulse T7 | Hercules | 2 | — |
| Numark Mixstream Pro Go | Numark | 2 | — |
| Hercules DJControl Inpulse 200 MK2 | Hercules | 2 | — |
| Numark Mixstream Pro + | Numark | 2 | — |
| Numark Mixstream Pro | Numark | 2 | — |
| Hercules DJControl Inpulse 300 MK2 | Hercules | 2 | — |
| Pioneer DJ DDJ-FLX4 | Pioneer DJ | 2 | — |
| Denon DJ SC Live 2 | Denon DJ | 2 | — |
| Pioneer DJ DDJ-REV1 | Pioneer DJ | 2 | — |
| Pioneer DJ DDJ-REV7 | Pioneer DJ | 2 | — |
| Numark Party Mix Live | Numark | 2 | — |
| Numark Party Mix II | Numark | 2 | — |
| Reloop Ready | Reloop | 2 | — |
| RANE ONE | RANE | 2 | — |
| Hercules DJControl Inpulse 500 | Hercules | 2 | — |
| Numark Mixtrack Platinum FX | Numark | 2 | — |
| Numark Mixtrack Pro FX | Numark | 2 | — |
| Numark DJ2GO2 Touch | Numark | 2 | — |
| Mixars PRIMO | Mixars | 2 | — |
| Hercules DJControl Inpulse 300 | Hercules | 2 | — |
| Hercules DJControl Inpulse 200 | Hercules | 2 | — |
| Hercules DJControl Starlight | Hercules | 2 | — |
| Numark Party Mix | Numark | 2 | — |
| Pioneer DJ DDJ SB3 | Pioneer DJ | 2 | — |
| Roland DJ-505 | Roland | 2 | — |
| Roland DJ-202 | Roland | 2 | — |
| Pioneer DJ DDJ-SR2 | Pioneer DJ | 2 | — |
| Numark Mixtrack Platinum | Numark | 2 | — |
| Pioneer DJ DDJ-SB2 | Pioneer DJ | 2 | — |
| Numark Party Mix Pro | Numark | 2 | — |
| Numark DJ2GO2 | Numark | 2 | — |
| Hercules DJControl Jogvision | Hercules | 2 | — |
| Denon DJ MC4000 | Denon DJ | 2 | — |
| Numark Mixtrack Pro 3 | Numark | 2 | — |
| Pioneer DJ DDJ-SB | Pioneer DJ | 2 | — |
| Numark Mixtrack Pro II | Numark | 2 | — |
| Pioneer DJ DDJ-SR | Pioneer DJ | 2 | — |
| Pioneer DJ DDJ-WeGO3 | Pioneer DJ | 2 | — |
| Numark MixDeck Express | Numark | 2 | — |
| Denon DJ MC2000 | Denon DJ | 2 | — |
| Pioneer DJ DDJ-WeGO | Pioneer DJ | 2 | — |
| Reloop Terminal Mix 2 | Reloop | 2 | — |
| Pioneer DJ DDJ-ERGO | Pioneer DJ | 2 | — |
| Numark Mixtrack Pro | Numark | 2 | — |
| Vestax Typhoon | Vestax | 2 | — |
| Reloop Beatmix 2 | Reloop | 2 | — |
| Vestax VCI-100 mk II | Vestax | 2 | — |
| Vestax VCI-380 | Vestax | 2 | — |
| Vestax VCI-300 | Vestax | 2 | — |
| Gemini Slate | Gemini | 2 | — |
| Pioneer DJ DDJ-S1 | Pioneer DJ | 2 | — |
| Korg KAOSS DJ | Korg | 2 | — |
| Numark MixDeck | Numark | 2 | — |
| Novation TWITCH | Novation | 2 | — |
| Numark Mixtrack Edge | Numark | 2 | — |

### 4-Deck Controllers & All-In-One Systems (45)

| Device | Vendor | Decks | DVS |
| --- | --- | --- | --- |
| AlphaTheta XDJ-AN | AlphaTheta | 4 | — |
| RANE SYSTEM ONE | RANE | 4 | — |
| AlphaTheta XDJ-AZ | AlphaTheta | 4 | — |
| AlphaTheta DDJ-GRV6 | AlphaTheta | 4 | — |
| Native Instruments Traktor Kontrol S3 | Native Instruments | 4 | — |
| Native Instruments Traktor Kontrol S2 MK3 | Native Instruments | 4 | — |
| RANE PERFORMER | RANE | 4 | — |
| Denon DJ PRIME 4+ | Denon DJ | 4 | — |
| Pioneer DJ OPUS-QUAD | Pioneer DJ | 4 | — |
| Reloop Mixon 8 Pro | Reloop | 4 | — |
| Pioneer DJ DDJ-FLX10 | Pioneer DJ | 4 | — |
| RANE FOUR | RANE | 4 | — |
| Denon DJ SC Live 4 | Denon DJ | 4 | — |
| Numark NS4FX | Numark | 4 | — |
| Pioneer DJ XDJ-RX3 | Pioneer DJ | 4 | — |
| Pioneer DJ DDJ-FLX6 | Pioneer DJ | 4 | — |
| Pioneer DJ XDJ-XZ | Pioneer DJ | 4 | — |
| Denon DJ PRIME 4 | Denon DJ | 4 | — |
| Roland DJ-707M | Roland | 4 | — |
| Pioneer DJ DDJ-1000SRT | Pioneer DJ | 4 | — |
| Pioneer DJ DDJ-SX3 | Pioneer DJ | 4 | — |
| Roland DJ-808 | Roland | 4 | — |
| Numark NS6II | Numark | 4 | — |
| Pioneer DJ DDJ-SZ2 | Pioneer DJ | 4 | — |
| Denon DJ MC7000 | Denon DJ | 4 | — |
| Pioneer DJ DDJ-SX2 | Pioneer DJ | 4 | — |
| Reloop Mixon 4 | Reloop | 4 | — |
| Denon DJ MCX8000 | Denon DJ | 4 | — |
| Numark NS7 III | Numark | 4 | — |
| Pioneer DJ DDJ-SZ | Pioneer DJ | 4 | — |
| Numark NVII | Numark | 4 | — |
| Numark NV | Numark | 4 | — |
| Reloop Beatmix 4 | Reloop | 4 | — |
| Denon DJ MC6000MK2 | Denon DJ | 4 | — |
| Pioneer DJ DDJ-SX | Pioneer DJ | 4 | — |
| Gemini Slate 4 | Gemini | 4 | — |
| Reloop Terminal Mix 4 | Reloop | 4 | — |
| Numark Mixtrack Quad | Numark | 4 | — |
| Numark MixDeck Quad | Numark | 4 | — |
| Numark N4 | Numark | 4 | — |
| Reloop Terminal Mix 8 | Reloop | 4 | — |
| Vestax VCI-400 | Vestax | 4 | — |
| Numark NS6 | Numark | 4 | — |
| Numark NS7 II | Numark | 4 | — |
| Numark NS7 | Numark | 4 | — |

### DVS, Battle & Club Mixers (39)

| Device | Vendor | Decks | DVS |
| --- | --- | --- | --- |
| Pioneer DJ DJM-750MK2 | Pioneer DJ | 4 | DVS Ready |
| Pioneer DJ DJM-450 | Pioneer DJ | 2 | DVS Ready |
| Pioneer DJ DJM-250MK2 | Pioneer DJ | 2 | DVS Ready |
| AlphaTheta DJM-V5 | AlphaTheta | 4 | DVS Upgrade |
| Native Instruments Traktor Kontrol Z2 | Native Instruments | 2 | DVS Upgrade |
| AlphaTheta Euphonia | AlphaTheta | 4 | DVS Upgrade |
| Pioneer DJ DJM-A9 | Pioneer DJ | 4 | DVS Upgrade |
| Pioneer DJ DJM-S5 | Pioneer DJ | 2 | DVS Ready |
| RANE SEVENTY A-Trak Edition | RANE | 2 | DVS Ready |
| Pioneer DJ DJM-S7 | Pioneer DJ | 2 | DVS Ready |
| Pioneer DJ DJM-S11 | Pioneer DJ | 2 | DVS Ready |
| RANE SEVENTY-TWO MKII | RANE | 2 | DVS Ready |
| Pioneer DJ DJM-V10-LF | Pioneer DJ | 4 | DVS Upgrade |
| Pioneer DJ DJM-V10 | Pioneer DJ | 4 | DVS Upgrade |
| Denon DJ X1850 PRIME | Denon DJ | 4 | DVS Upgrade |
| Rane SEVENTY | RANE | 2 | DVS Ready |
| Numark Scratch | Numark | 2 | DVS Ready |
| Reloop ELITE | Reloop | 2 | DVS Ready |
| Rane SEVENTY-TWO | RANE | 2 | DVS Ready |
| Denon DJ X1800 Prime | Denon DJ | 4 | DVS Upgrade |
| Mixars QUATTRO | Mixars | 4 | DVS Ready |
| Pioneer DJ DJM-S3 | Pioneer DJ | 2 | DVS Ready |
| Reloop RMX-90 DVS | Reloop | 4 | DVS Ready |
| Pioneer DJ DJM-900NXS2 | Pioneer DJ | 4 | DVS Upgrade |
| Pioneer DJ DJM-S9 | Pioneer DJ | 2 | DVS Ready |
| Akai Pro AMX | Akai Pro | 2 | DVS Ready |
| Mixars DUO | Mixars | 2 | DVS Ready |
| Allen & Heath Xone:43C | Allen & Heath | 4 | DVS Upgrade |
| Pioneer DJ DJM-900SRT | Pioneer DJ | 4 | DVS Ready |
| Rane MP2015 | RANE | 4 | DVS Upgrade |
| Pioneer DJ DJM-900NXS | Pioneer DJ | 4 | DVS Upgrade |
| Pioneer DJ DJM-850 | Pioneer DJ | 4 | DVS Upgrade |
| Rane TTM57mkII | RANE | 2 | DVS Ready |
| Rane Sixty-Two | RANE | 2 | DVS Ready |
| Allen & Heath Xone:DB4 | Allen & Heath | 4 | DVS Upgrade |
| Rane Sixty-Four | RANE | 4 | DVS Ready |
| Allen & Heath Xone:DB2 | Allen & Heath | 4 | DVS Upgrade |
| Rane Sixty-One | RANE | 2 | DVS Ready |
| Rane Sixty-Eight | RANE | 4 | DVS Ready |

### DVS Audio Interfaces (6)

| Device | Vendor | Decks | DVS |
| --- | --- | --- | --- |
| Reloop Flux Go | Reloop | 2 | DVS Ready |
| Reloop Flux | Reloop | 4 | DVS Ready |
| Denon DJ DS1 | Denon DJ | 2 | DVS Ready |
| Rane SL3 | RANE | 4 | DVS Ready |
| Rane SL4 | RANE | 4 | DVS Ready |
| Rane SL2 | RANE | 2 | DVS Ready |

### Single-Deck Media Players & Motorized Turntables (23)

| Device | Vendor | Decks | DVS |
| --- | --- | --- | --- |
| AlphaTheta CDJ-1500X | AlphaTheta | 1 | — |
| AlphaTheta CDJ-3000X | AlphaTheta | 1 | — |
| Pioneer DJ PLX-CRSS12 | Pioneer DJ | 1 | DVS Ready |
| Pioneer DJ CDJ-3000 | Pioneer DJ | 1 | — |
| Denon DJ LC6000 PRIME | Denon DJ | 1 | — |
| Phase | MWM | 1 | DVS Ready |
| Denon DJ SC6000 PRIME | Denon DJ | 1 | — |
| Denon DJ SC6000M PRIME | Denon DJ | 1 | DVS Ready |
| RANE TWELVE MKII | RANE | 1 | DVS Ready |
| Denon DJ SC5000M Prime | Denon DJ | 1 | DVS Ready |
| Reloop RP8000 MK2 | Reloop | 1 | DVS Ready |
| Rane TWELVE | RANE | 1 | DVS Ready |
| Denon DJ SC5000 Prime | Denon DJ | 1 | — |
| Pioneer DJ CDJ-2000NXS2 | Pioneer DJ | 1 | — |
| Pioneer DJ CDJ-850 | Pioneer DJ | 1 | — |
| Pioneer DJ CDJ-900 | Pioneer DJ | 1 | — |
| Pioneer DJ CDJ-2000NXS | Pioneer DJ | 1 | — |
| Pioneer DJ CDJ-2000 | Pioneer DJ | 1 | — |
| Pioneer DJ CDJ-900NXS | Pioneer DJ | 1 | — |
| Reloop RP-8000 | Reloop | 1 | DVS Ready |
| Numark NDX500 | Numark | 1 | — |
| Pioneer DJ XDJ-1000 | Pioneer DJ | 1 | — |
| Numark V7 | Numark | 1 | DVS Ready |

### Accessories, Pad Controllers & Rhythm Machines (16)

| Device | Vendor | Decks | DVS |
| --- | --- | --- | --- |
| AlphaTheta SLAB | AlphaTheta | 2 | — |
| Roland SP-404MKII | Roland | 2 | — |
| Pioneer DJ DDJ-XP2 | Pioneer DJ | 2 | — |
| Roland TR-8S | Roland | 2 | — |
| Roland TR-8 | Roland | 2 | — |
| Roland TR-08 | Roland | 2 | — |
| Roland TR-09 | Roland | 2 | — |
| Numark Dashboard | Numark | 2 | — |
| Vestax VFX-1 | Vestax | 2 | — |
| Allen & Heath Xone:K1 | Allen & Heath | 2 | — |
| Pioneer DJ DDJ-SP1 | Pioneer DJ | 2 | — |
| Novation Dicers | Novation | 2 | — |
| Numark NSFX | Numark | 2 | — |
| Reloop NEON | Reloop | 2 | — |
| Akai Pro AFX | Akai Pro | 2 | — |
| Denon DJ DN-HC1000S | Denon DJ | 2 | — |
