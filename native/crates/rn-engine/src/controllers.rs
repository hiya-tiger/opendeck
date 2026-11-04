//! Clean-room jog maps. Each entry was typed from the manufacturer's own published MIDI
//! list (cited per entry). No Mixxx (GPL) mapping or script was used.
//! `ticks_per_rev` is NOT published in any of these documents: the value here is a
//! placeholder that must be replaced by a captured measurement (one full turn, count ticks)
//! before shipping. `verified_on_hardware` stays false until that capture exists.

use crate::midi_jog::{JogEncoding, JogMap};

pub struct ControllerJog {
    pub map_deck1: JogMap,
    pub map_deck2: JogMap,
    pub ticks_per_rev_documented: bool,
    pub verified_on_hardware: bool,
}

pub const FLX4_SRC: &str = "AlphaTheta DDJ-FLX4 List of MIDI messages Ver 1.0 (DDJ-FLX4_MIDI_message_List_E1.pdf, downloads.support.alphatheta.com/software_info/dj-controllers/DDJ-FLX4/), group 1 fig. 1-4 JOG DIAL (Platter) and JOG DIAL (Wheel side)";
pub const INPULSE200_SRC: &str = "Hercules 'List of MIDI commands' DJControl Inpulse 200 V1.0 (ts.hercules.com/download/sound/manuals/DJC_Inpulse200/DJControlInpulse200_MIDI_Commands_V_1_0.pdf): JOG_A B1 09, JOG_SCRATCH_A B1 0A, JOG_TOUCH_A 91 08; deck B on B2/92";
pub const INPULSE500_SRC: &str = "Hercules 'MIDI COMMANDS' DJControl Inpulse 500 (ts.hercules.com/download/sound/manuals/DJC_Inpulse500/DJControlInpulse500_MIDI_Commands.pdf), area D1-16 / D2-16 Jog-wheel: CC 9 (no vinyl), CC 10 (vinyl), touch CC 8 (0/127)";

fn m(controller: &'static str, source: &'static str, channel: u8, encoding: JogEncoding, top: u8, ring: Option<u8>, touch_note: Option<u8>, touch_cc: Option<u8>) -> JogMap {
    JogMap { controller, source, channel, encoding, top_cc: top, ring_cc: ring, touch_note, touch_cc, ticks_per_rev: 2048.0 }
}

pub fn catalogue() -> Vec<ControllerJog> {
    vec![
        // FLX4: platter rotate (vinyl on) CC 0x22, wheel side CC 0x21, touch NOTE 0x36. Data:
        // "difference count value from previous operation; clockwise increases from 0x41,
        // counter-clockwise decreases from 0x3F" -> offset-64 relative.
        ControllerJog {
            map_deck1: m("AlphaTheta DDJ-FLX4", FLX4_SRC, 0, JogEncoding::RelativeOffset64, 0x22, Some(0x21), Some(0x36), None),
            map_deck2: m("AlphaTheta DDJ-FLX4", FLX4_SRC, 1, JogEncoding::RelativeOffset64, 0x22, Some(0x21), Some(0x36), None),
            ticks_per_rev_documented: false,
            verified_on_hardware: false,
        },
        // Inpulse 200: "Incremental 01 > 3F CW slow>fast, 7F > 40 CCW slow>fast" -> two's complement.
        ControllerJog {
            map_deck1: m("Hercules DJControl Inpulse 200", INPULSE200_SRC, 1, JogEncoding::Relative2sComplement, 0x0a, Some(0x09), Some(0x08), None),
            map_deck2: m("Hercules DJControl Inpulse 200", INPULSE200_SRC, 2, JogEncoding::Relative2sComplement, 0x0a, Some(0x09), Some(0x08), None),
            ticks_per_rev_documented: false,
            verified_on_hardware: false,
        },
        ControllerJog {
            map_deck1: m("Hercules DJControl Inpulse 500", INPULSE500_SRC, 1, JogEncoding::Relative2sComplement, 0x0a, Some(0x09), None, Some(0x08)),
            map_deck2: m("Hercules DJControl Inpulse 500", INPULSE500_SRC, 2, JogEncoding::Relative2sComplement, 0x0a, Some(0x09), None, Some(0x08)),
            ticks_per_rev_documented: false,
            verified_on_hardware: false,
        },
    ]
}
