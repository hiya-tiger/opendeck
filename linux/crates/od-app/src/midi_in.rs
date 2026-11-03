//! MIDI input through midir (ALSA sequencer): every input port is opened
//! and its messages go to the UI thread over a channel, tagged with the
//! port name so the right profile (or the SLAB driver) handles them.
use std::sync::mpsc::{channel, Receiver};

pub struct MidiIn { pub rx: Receiver<(usize, Vec<u8>)>, pub ports: Vec<String>, _conns: Vec<midir::MidiInputConnection<()>>, pub error: Option<String> }

pub fn open_all() -> MidiIn {
    let (tx, rx) = channel();
    let mut ports = vec![];
    let mut conns = vec![];
    let mut error = None;
    match midir::MidiInput::new("OpenDecks") {
        Ok(probe) => {
            for (i, p) in probe.ports().iter().enumerate() {
                let name = probe.port_name(p).unwrap_or_else(|_| format!("port {i}"));
                if name.contains("Midi Through") { continue; }
                let Ok(inp) = midir::MidiInput::new("OpenDecks") else { continue };
                let tx = tx.clone();
                let idx = ports.len();
                if let Ok(c) = inp.connect(p, "opendecks-in", move |_, msg, _| { let _ = tx.send((idx, msg.to_vec())); }, ()) { conns.push(c); ports.push(name); }
            }
        }
        Err(e) => error = Some(e.to_string()),
    }
    MidiIn { rx, ports, _conns: conns, error }
}
