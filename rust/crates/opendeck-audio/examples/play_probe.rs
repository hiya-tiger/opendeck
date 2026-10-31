//! M2 native-output probe. **Not part of the application.**
//!
//! This binary is an `example` target with `required-features`, so a plain
//! `cargo build`, `cargo test` or `cargo build --release -p opendeck-app` never
//! builds it and never links cpal. Running it needs two deliberate acts: the
//! `native-output` + `decode` features, and `OPENDECK_NATIVE_OUTPUT_PROBE=1`.
//!
//! ```text
//! OPENDECK_NATIVE_OUTPUT_PROBE=1 cargo run --release -p opendeck-audio \
//!   --features native-output,decode --example play_probe -- --tone --seconds 2
//! ```
//!
//! It bypasses the Web Audio graph entirely: no EQ, no FX, no mixer, no
//! analyser, no recording, no pitch hold, no time-stretch. See
//! `docs/mobile/RUST-PROBE.md` for what that means and what it would cost to
//! close the gap.
//!
//! Output is `key=value` lines so a transcript can be pasted into a report
//! without re-typing numbers.
//!
//! Exit codes: 0 device opened and callbacks advanced the transport,
//! 1 device refused or failed, 2 probe gate closed, 3 bad usage.

use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant};

use opendeck_audio::{
    decode_file, probe_gate_from_env, NativeOutput, PcmVoice, ProbeGate, TransportState,
    VoiceOptions, PROBE_ENV,
};

const USAGE: &str = "\
usage: play_probe (--tone | --file <path>) [--seconds <n>] [--rate <hz>]

  --tone            play a generated 440 Hz stereo tone (no file needed)
  --file <path>     decode and play a local file (mp3, m4a/aac, flac, wav, aiff)
  --list-configs    print every output config the default device offers, then
                    stop unless --tone or --file is also given
  --seconds <n>     how long to observe the stream (default 2)
  --rate <hz>       source rate for --tone (default 48000); files use their own";

struct Args {
    tone: bool,
    file: Option<String>,
    seconds: f64,
    rate: u32,
    list_configs: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        tone: false,
        file: None,
        seconds: 2.0,
        rate: 48_000,
        list_configs: false,
    };
    let mut rest = std::env::args().skip(1);
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--tone" => args.tone = true,
            "--list-configs" => args.list_configs = true,
            "--file" => {
                args.file = Some(rest.next().ok_or("--file needs a path")?);
            }
            "--seconds" => {
                let value = rest.next().ok_or("--seconds needs a number")?;
                args.seconds = value.parse().map_err(|_| format!("bad --seconds {value:?}"))?;
            }
            "--rate" => {
                let value = rest.next().ok_or("--rate needs a number")?;
                args.rate = value.parse().map_err(|_| format!("bad --rate {value:?}"))?;
            }
            "-h" | "--help" => return Err(String::new()),
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    if !args.tone && args.file.is_none() && !args.list_configs {
        return Err("one of --tone or --file is required".into());
    }
    Ok(args)
}

/// Print every output config the default device offers. This is the evidence
/// for D21: the probe either finds the source rate here or must refuse.
fn list_configs() -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("no default output device")?;
    println!("probe=device-listed");
    println!("device={}", device.name().unwrap_or_else(|_| "unknown".into()));
    let configs = device
        .supported_output_configs()
        .map_err(|error| error.to_string())?;
    let mut index = 0;
    for config in configs {
        println!(
            "config[{index}] rate={}-{} channels={} format={:?}",
            config.min_sample_rate().0,
            config.max_sample_rate().0,
            config.channels(),
            config.sample_format()
        );
        index += 1;
    }
    println!("config_count={index}");
    Ok(())
}

fn tone(frames: usize, sample_rate: u32) -> PcmVoice {
    let left_hz = 440.0f64;
    let right_hz = 443.0f64;
    let mut left = Vec::with_capacity(frames);
    let mut right = Vec::with_capacity(frames);
    for frame in 0..frames {
        let t = frame as f64 / sample_rate as f64;
        let envelope = (t * 2.0).min(1.0) * 0.25;
        left.push((t * left_hz * std::f64::consts::TAU).sin() as f32 * envelope as f32);
        right.push((t * right_hz * std::f64::consts::TAU).sin() as f32 * envelope as f32);
    }
    PcmVoice::new(vec![left, right], VoiceOptions::new()).expect("tone is well formed")
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            if !message.is_empty() {
                eprintln!("play_probe: {message}");
            }
            eprintln!("{USAGE}");
            return ExitCode::from(3);
        }
    };

    match probe_gate_from_env() {
        ProbeGate::Enabled => {}
        ProbeGate::Disabled(reason) => {
            println!("probe=gate-closed");
            println!("gate_env={PROBE_ENV}");
            println!("gate_reason={reason}");
            println!("tier=NONE");
            eprintln!("play_probe: refusing to open a device: {reason}");
            return ExitCode::from(2);
        }
    }

    if args.list_configs {
        match list_configs() {
            Ok(()) => {}
            Err(error) => {
                println!("probe=config-error");
                println!("error={error}");
                println!("tier=COMPILED");
                return ExitCode::from(1);
            }
        }
        if !args.tone && args.file.is_none() {
            return ExitCode::SUCCESS;
        }
    }

    // Build the source first so a decode failure is reported as a decode
    // failure, not as a device failure.
    let (voice, sample_rate, source_frames, source) = match (&args.file, args.tone) {
        (Some(path), _) => match decode_file(path) {
            Ok(track) => {
                let frames = track.frames;
                let rate = track.sample_rate;
                match track.into_voice(VoiceOptions::new()) {
                    Ok(voice) => (voice, rate, frames, format!("file:{path}")),
                    Err(error) => {
                        println!("probe=decode-error");
                        println!("error={error}");
                        println!("tier=COMPILED");
                        return ExitCode::from(1);
                    }
                }
            }
            Err(error) => {
                println!("probe=decode-error");
                println!("error={error}");
                println!("tier=COMPILED");
                return ExitCode::from(1);
            }
        },
        (None, true) => {
            let frames = (args.rate as f64 * 5.0) as usize;
            (tone(frames, args.rate), args.rate, frames, "tone".to_string())
        }
        (None, false) => unreachable!("parse_args rejects this"),
    };

    println!("probe=starting");
    println!("source={source}");
    println!("source_rate={sample_rate}");
    println!("source_frames={source_frames}");

    let state: Arc<TransportState> = TransportState::new(1.0);
    state.set_playing(true);

    let mut output = match NativeOutput::start(voice, state.clone(), sample_rate) {
        Ok(output) => output,
        Err(error) => {
            println!("probe=device-error");
            println!("error={error}");
            println!("tier=COMPILED");
            eprintln!("play_probe: {error}");
            return ExitCode::from(1);
        }
    };

    let config = output.config();
    println!("probe=device-opened");
    println!("device={}", output.device_name());
    println!("device_rate={}", config.sample_rate.0);
    println!("device_channels={}", config.channels);
    println!("device_format={:?}", output.format());
    println!("device_buffer_size={:?}", config.buffer_size);


    let start = state.position();
    let deadline = Instant::now() + Duration::from_millis((args.seconds * 1000.0) as u64);
    let mut moved = 0.0f64;
    let mut previous = start;
    let mut callbacks = 0u32;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
        let now = state.position();
        let delta = now - previous;
        if delta != 0.0 {
            callbacks += 1;
            moved += delta.abs();
        }
        previous = now;
    }

    let end = state.position();
    let active = output.is_active();
    output.stop();

    println!("position_start={start}");
    println!("position_end={end}");
    println!("frames_moved={moved}");
    println!("callbacks_advanced={callbacks}");
    println!("stream_was_active={active}");

    // The honest ceiling of this run: the device accepted a stream and its
    // callback pulled frames through the transport. Whether a human heard it is
    // one tier higher and needs ears, not a counter.
    if active && callbacks > 0 && moved > 0.0 {
        println!("tier=DEVICE");
        println!("note=device callbacks advanced the transport; audibility is not proven (HARDWARE needs a human)");
        ExitCode::SUCCESS
    } else {
        println!("tier=COMPILED");
        println!("note=the stream opened but no callback advanced the transport within the window");
        ExitCode::from(1)
    }
}
