//! MIDI jog decoding: relative encoders (three common encodings), 14-bit absolute
//! encoders (MSB CC n + LSB CC n+32), touch on/off notes, sensitivity.
//!
//! Mappings are data (`JogMap`). Every map records where its numbers came from; only
//! manufacturer documentation or captured device messages are acceptable sources.
//! No Mixxx (GPL) mapping file or script was opened to build these.

use crate::deck::JogZone;
use std::f64::consts::TAU;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JogEncoding {
    /// 1..63 forward, 127..65 backward (two's complement in 7 bits). 0x41 = -63.
    Relative2sComplement,
    /// 64 = no movement, 65.. forward, ..63 backward.
    RelativeOffset64,
    /// Bit 6 is the sign: 0x01..0x3F forward, 0x41..0x7F backward.
    RelativeSignBit,
    /// Absolute 14-bit position: MSB on `cc`, LSB on `cc + 32`; wraps at 16384.
    Absolute14,
}

#[derive(Clone, Debug)]
pub struct JogMap {
    pub controller: &'static str,
    pub source: &'static str,
    /// 0-based MIDI channel of this deck's jog.
    pub channel: u8,
    pub encoding: JogEncoding,
    pub top_cc: u8,
    pub ring_cc: Option<u8>,
    pub touch_note: Option<u8>,
    /// Some controllers (e.g. Hercules DJControl Inpulse 500) send touch as a CC (0 / 127).
    pub touch_cc: Option<u8>,
    /// Encoder ticks (or 14-bit counts) per platter revolution.
    pub ticks_per_rev: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum JogEvent {
    Touch(bool),
    Move { zone: JogZone, radians: f64 },
}

pub struct MidiJog {
    pub map: JogMap,
    pub sensitivity: f64,
    msb: Option<u8>,
    last_abs: Option<i32>,
}

impl MidiJog {
    pub fn new(map: JogMap) -> Self {
        Self { map, sensitivity: 1.0, msb: None, last_abs: None }
    }

    pub fn decode_relative(enc: JogEncoding, v: u8) -> i32 {
        let v = (v & 0x7f) as i32;
        match enc {
            JogEncoding::Relative2sComplement => {
                if v >= 64 {
                    v - 128
                } else {
                    v
                }
            }
            JogEncoding::RelativeOffset64 => v - 64,
            JogEncoding::RelativeSignBit => {
                if v & 0x40 != 0 {
                    -(v & 0x3f)
                } else {
                    v & 0x3f
                }
            }
            JogEncoding::Absolute14 => 0,
        }
    }

    fn rad(&self, ticks: f64) -> f64 {
        ticks / self.map.ticks_per_rev * TAU * self.sensitivity
    }

    /// Feed one 3-byte channel message. Returns the jog event it carries, if any.
    pub fn feed(&mut self, msg: [u8; 3]) -> Option<JogEvent> {
        let status = msg[0] & 0xf0;
        let ch = msg[0] & 0x0f;
        if ch != self.map.channel {
            return None;
        }
        let (d1, d2) = (msg[1] & 0x7f, msg[2] & 0x7f);
        match status {
            0x90 | 0x80 if Some(d1) == self.map.touch_note => Some(JogEvent::Touch(status == 0x90 && d2 > 0)),
            0xb0 if Some(d1) == self.map.touch_cc => Some(JogEvent::Touch(d2 > 0)),
            0xb0 => {
                let zone = if d1 == self.map.top_cc || (self.map.encoding == JogEncoding::Absolute14 && d1 == self.map.top_cc + 32) {
                    JogZone::Top
                } else if Some(d1) == self.map.ring_cc {
                    JogZone::Ring
                } else {
                    return None;
                };
                match self.map.encoding {
                    JogEncoding::Absolute14 => {
                        if d1 == self.map.top_cc {
                            self.msb = Some(d2);
                            None
                        } else {
                            let msb = self.msb?;
                            let v = ((msb as i32) << 7) | d2 as i32;
                            let ev = self.last_abs.map(|last| {
                                let mut d = v - last;
                                if d > 8192 {
                                    d -= 16384;
                                } else if d < -8192 {
                                    d += 16384;
                                }
                                JogEvent::Move { zone, radians: self.rad(d as f64) }
                            });
                            self.last_abs = Some(v);
                            ev
                        }
                    }
                    enc => {
                        let t = Self::decode_relative(enc, d2);
                        if t == 0 {
                            None
                        } else {
                            Some(JogEvent::Move { zone, radians: self.rad(t as f64) })
                        }
                    }
                }
            }
            _ => None,
        }
    }

    /// Encode a movement of `ticks` (for simulations / captured-message replay tests).
    pub fn encode_relative(enc: JogEncoding, ticks: i32) -> u8 {
        let t = ticks.clamp(-63, 63);
        match enc {
            JogEncoding::Relative2sComplement => (t & 0x7f) as u8,
            JogEncoding::RelativeOffset64 => (64 + t) as u8,
            JogEncoding::RelativeSignBit => {
                if t < 0 {
                    0x40 | (-t) as u8
                } else {
                    t as u8
                }
            }
            JogEncoding::Absolute14 => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relative_encodings_round_trip() {
        for enc in [JogEncoding::Relative2sComplement, JogEncoding::RelativeOffset64, JogEncoding::RelativeSignBit] {
            for t in [-63, -10, -1, 1, 10, 63] {
                assert_eq!(MidiJog::decode_relative(enc, MidiJog::encode_relative(enc, t)), t, "{enc:?} {t}");
            }
        }
    }
    #[test]
    fn flx4_doc_values() {
        // DDJ-FLX4 list: clockwise increases from 0x41, counter-clockwise decreases from 0x3F.
        assert_eq!(MidiJog::decode_relative(JogEncoding::RelativeOffset64, 0x41), 1);
        assert_eq!(MidiJog::decode_relative(JogEncoding::RelativeOffset64, 0x3f), -1);
        // Inpulse: 01..3F CW, 7F..40 CCW.
        assert_eq!(MidiJog::decode_relative(JogEncoding::Relative2sComplement, 0x7f), -1);
        assert_eq!(MidiJog::decode_relative(JogEncoding::Relative2sComplement, 0x01), 1);
    }
}
