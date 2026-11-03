//! OpenDecks for Linux: egui (eframe + wgpu) front end on the Rust engine.
//!
//!   opendecks [--music DIR] [--null-audio] [--buffer N]
//!   opendecks --bench-scroll SECS --fixtures DIR   (4 decks playing, waveforms scrolling; prints SCROLL {json})
//! Prints `FIRST_FRAME []` on stdout after the second frame (cold-start harness).
mod app;
mod keys;
mod library;
mod midi_in;
mod settings;
mod waveform;

#[cfg(debug_assertions)]
#[global_allocator]
static ALLOC: assert_no_alloc::AllocDisabler = assert_no_alloc::AllocDisabler;

fn main() -> eframe::Result<()> {
    let start = std::time::Instant::now();
    let args = app::Args::parse(std::env::args().skip(1).collect());
    let opts = eframe::NativeOptions {
        renderer: eframe::Renderer::Wgpu,
        vsync: !args.bench_unthrottled(),
        viewport: egui::ViewportBuilder::default().with_title("OpenDecks").with_app_id("io.opendeck.OpenDecks").with_inner_size([1440.0, 900.0]).with_min_inner_size([960.0, 600.0]),
        ..Default::default()
    };
    eframe::run_native("OpenDecks", opts, Box::new(move |cc| Ok(Box::new(app::OpenDecks::new(cc, args, start)))))
}
