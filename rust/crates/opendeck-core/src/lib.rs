pub mod analysis;
pub mod dsp;
pub mod wav;

pub use analysis::{
    analyze_mono, band_peaks, chroma, detect_key, estimate_bpm, peaks, spectral_flux, Analysis,
    BandPeaks, Key,
};
pub use wav::{read_wav_mono, WavError};
