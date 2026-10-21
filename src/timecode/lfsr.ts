import type { TimecodeDef } from "./defs.ts";

export const parity = (value: number): number => {
  let x = value;
  x ^= x >>> 16;
  x ^= x >>> 8;
  x ^= x >>> 4;
  return (0x6996 >>> (x & 0xf)) & 1;
};

export const maskOf = (def: TimecodeDef): number => (1 << def.bits) - 1;

export const forward = (state: number, def: TimecodeDef): number =>
  ((state >>> 1) | (parity(state & (def.taps | 1)) << (def.bits - 1))) & maskOf(def);

export const reverse = (state: number, def: TimecodeDef): number =>
  (((state << 1) & maskOf(def)) |
    parity(state & ((def.taps >>> 1) | (1 << (def.bits - 1))))) >>>
  0;

export const bitOf = (state: number, def: TimecodeDef): number => (state >>> (def.bits - 1)) & 1;

export const stateAt = (def: TimecodeDef, index: number): number => {
  let state = def.seed;
  for (let n = 0; n < index; n += 1) state = forward(state, def);
  return state;
};

export const buildPositionTable = (def: TimecodeDef): Int32Array => {
  const table = new Int32Array(1 << def.bits).fill(-1);
  let state = def.seed;
  for (let n = 0; n < def.length; n += 1) {
    table[state] = n;
    state = forward(state, def);
  }
  return table;
};
