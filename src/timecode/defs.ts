export type ChannelPair = "default" | "swapped";

export interface TimecodeDef {
  id: string;
  name: string;
  carrierHz: number;
  bits: number;
  seed: number;
  taps: number;
  length: number;
  safeLength: number;
  primary: "left" | "right";
  polarity: 1 | -1;
  phaseDeg: 90 | 270;
  seconds: number;
}

const def = (
  id: string,
  name: string,
  carrierHz: number,
  bits: number,
  seed: number,
  taps: number,
  length: number,
  safeLength: number,
  extra: Partial<TimecodeDef> = {},
): TimecodeDef => ({
  id,
  name,
  carrierHz,
  bits,
  seed,
  taps,
  length,
  safeLength,
  primary: "right",
  polarity: 1,
  phaseDeg: 90,
  seconds: length / carrierHz,
  ...extra,
});

export const TIMECODES: TimecodeDef[] = [
  def("serato-2a", "Serato CV02 side A", 1000, 20, 0x59017, 0x361e4, 712000, 707000),
  def("serato-2b", "Serato CV02 side B", 1000, 20, 0x8f3c6, 0x4f0d8, 922000, 917000),
  def("serato-cd", "Serato Control CD", 1000, 20, 0xd8b40, 0x34d54, 950000, 940000),
  def("traktor-a", "Traktor MK2 side A", 2000, 23, 0x134503, 0x041040, 1500000, 1480000, {
    primary: "left",
    polarity: -1,
    phaseDeg: 270,
  }),
  def("traktor-b", "Traktor MK2 side B", 2000, 23, 0x32066c, 0x041040, 2110000, 2090000, {
    primary: "left",
    polarity: -1,
    phaseDeg: 270,
  }),
  def("mixvibes-v2", "MixVibes V2", 1300, 20, 0x22c90, 0x00008, 950000, 923000, {
    phaseDeg: 270,
  }),
  def("pioneer-a", "Pioneer rekordbox DVS A", 1000, 20, 0x78370, 0x7933a, 635000, 614000, {
    polarity: -1,
  }),
  def("pioneer-b", "Pioneer rekordbox DVS B", 1000, 20, 0xf7012, 0x2ef1c, 918500, 913000, {
    polarity: -1,
  }),
];

export const findTimecode = (id: string): TimecodeDef | undefined =>
  TIMECODES.find((t) => t.id === id);

export const detectTimecode = (carrierHz: number): TimecodeDef[] => {
  const scored = TIMECODES.map((t) => ({ t, d: Math.abs(t.carrierHz - carrierHz) }));
  const min = Math.min(...scored.map((s) => s.d));
  return scored.filter((s) => s.d <= Math.max(40, min)).map((s) => s.t);
};
