# Hardware controllers and samplers

OpenDeck uses Web MIDI, so any class-compliant USB-MIDI device works without a driver install on Windows 10/11, macOS and Linux. The Tauri/WebView2 build grants the MIDI permission in the host; the Electron build uses Chromium's own permission handling.

## What is supported

| Device type | Examples | Behaviour |
| --- | --- | --- |
| Drum / sampler pads | Roland SP-404MKII, Akai MPC pads, Novation Launchpad | Notes 36-43 play sampler pads 1-8 with velocity; other notes and CCs can be learned |
| Keyboard controllers | Akai MPK Mini, Arturia MiniLab, Novation Launchkey | Pads and keys send notes; knobs send CCs; use Learn to bind transport, EQ, faders or pads |
| MIDI interfaces / routers | CME U6MIDI Pro, iConnectivity mio | Routes any connected keyboard or pad bank into OpenDeck; OpenDeck sees the interface's input port |
| Generic USB-MIDI keyboard | Any class-compliant device | Same as above; no vendor driver needed |

OpenDeck does not require or use SysEx. It lists all connected inputs and re-scans on hot-plug.

## Quick start

1. Connect the device by USB. If the maker supplies a driver or control app (Roland, Akai, Arturia), install it only when the device is not recognised as a class-compliant MIDI port.
2. Open the mixer's **MIDI** card and press **Enable MIDI**.
3. The card lists each input with its manufacturer. If the list stays empty, unplug and replug the device, or check the device's USB-MIDI mode.
4. Play a pad or move a knob: the live monitor shows `ch1 note 36 vel 100` or `ch1 CC74 64`.
5. Pads on notes 36-43 (C1-G1) play sampler pads 1-8 immediately. For anything else, choose a target in the dropdown, press **Learn**, then move that control.

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

### Roland SP-404MKII

- Acts as a USB audio interface and a USB-MIDI device. OpenDeck uses the MIDI port; audio can be routed separately through the OS or an audio interface.
- Install the Roland driver if Windows does not expose a MIDI port. Set the device's USB mode to **Vendor** when using the Roland driver, or **Generic** for class-compliant operation.
- Pads send notes; bank A defaults to 36-43, which triggers OpenDeck's sampler immediately. Use Learn if your bank starts elsewhere.
- The SP-404MKII's own effects and sequencer remain on the device; OpenDeck only receives MIDI.

### Akai MPK Mini

- Class compliant on Windows/macOS. The eight pads send notes 36-43 by default on many presets, so they map to the sampler with no setup.
- Keys send notes outside the drum range; bind them with Learn to a deck action if you want keyboard-triggered transport or cues.
- Use the Akai editor to change pad notes or CC numbers if a preset conflicts with another controller.

### CME U6MIDI Pro

- A router/interface rather than a controller. Connect the keyboard or pad device to its MIDI input (or USB host port) and route that port to USB.
- OpenDeck sees the U6MIDI Pro input; all upstream channels and notes arrive unchanged. Channel numbers are preserved, so a binding learned on channel 3 stays on channel 3.
- Use the CME app to merge or filter ports if you want one OpenDeck input for several devices.

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

Physical-device testing is still pending for the SP-404MKII, MPK Mini and U6MIDI Pro; the MIDI parser, default pad map, learn flow and persistence have unit tests.
