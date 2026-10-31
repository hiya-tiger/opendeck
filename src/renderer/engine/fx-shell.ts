export interface FxShell {
  input: GainNode;
  output: GainNode;
  dry: GainNode;
  wet: GainNode;
}

/**
 * The dry/wet shell every deck effect chain is built inside.
 *
 * `wet` starts muted. GainNodes default to 1, so wiring `input -> wet -> output`
 * and leaving the default doubles the signal: a freshly constructed deck used to
 * come up +6.02 dB hot into a -3 dBFS limiter, which squashed every track. The
 * deck's constructor calls `setFx("off")`, which early-returns because "off" is
 * already the current type, so `applyFxParams()` never ran to correct it.
 */
export function createFxShell(ctx: BaseAudioContext): FxShell {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  wet.gain.value = 0;
  input.connect(dry);
  dry.connect(output);
  input.connect(wet);
  wet.connect(output);
  return { input, output, dry, wet };
}
