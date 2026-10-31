import { STEM_CROSSOVERS, type StemId } from "./stems.ts";

export interface StemBand {
  nodes: AudioNode[];
  gain: GainNode;
  fx: BiquadFilterNode;
}

/**
 * Builds the deck's four-way band split.
 *
 * The bands are derived subtractively: each band is the low-passed remainder of
 * what the previous bands did not take, and the last band is whatever is left.
 * That makes `low + lowmid + highmid + high` reconstruct the input exactly, so a
 * deck with every band at unity gain is transparent.
 *
 * A parallel split (low-pass and high-pass Butterworth at the same corner, with
 * the middle bands as cascades) does not sum flat. Measured on the previous
 * graph at 48 kHz: -14.6 dB at 180 Hz, -9.8 dB at 800 Hz, -17.4 dB at 5 kHz,
 * plus a ~2 dB shelf across the rest of the spectrum. Because every track plays
 * through this split, that coloration was permanent.
 */
export function buildStemBands(
  ctx: BaseAudioContext,
  input: AudioNode,
  bus: AudioNode,
): Record<StemId, StemBand> {
  const tone = (): BiquadFilterNode => {
    const fx = ctx.createBiquadFilter();
    fx.type = "lowpass";
    fx.frequency.value = 24000;
    // Q above 0.5 puts a resonant lift just under the corner, which the band sum
    // inherits (+0.97 dB at 16 kHz measured). Keep the open state flat.
    fx.Q.value = 0.5;
    return fx;
  };

  const band = (source: AudioNode): StemBand => {
    const fx = tone();
    const gain = ctx.createGain();
    source.connect(fx);
    fx.connect(gain);
    gain.connect(bus);
    return { nodes: [fx], gain, fx };
  };

  // sum = from - subtract
  const residual = (from: AudioNode, subtract: AudioNode): GainNode => {
    const sum = ctx.createGain();
    const invert = ctx.createGain();
    invert.gain.value = -1;
    from.connect(sum);
    subtract.connect(invert);
    invert.connect(sum);
    return sum;
  };

  const split = (source: AudioNode, hz: number): { band: AudioNode; rest: GainNode } => {
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = hz;
    lp.Q.value = 0.7;
    source.connect(lp);
    return { band: lp, rest: residual(source, lp) };
  };

  const low = split(input, STEM_CROSSOVERS.low);
  const lowmid = split(low.rest, STEM_CROSSOVERS.lowmid);
  const highmid = split(lowmid.rest, STEM_CROSSOVERS.highmid);

  return {
    low: band(low.band),
    lowmid: band(lowmid.band),
    highmid: band(highmid.band),
    high: band(highmid.rest),
  };
}
