export type StemId = "low" | "lowmid" | "highmid" | "high";

export interface StemDef {
  id: StemId;
  label: string;
  short: string;
  color: string;
}

export const STEMS: StemDef[] = [
  { id: "low", label: "Low / kick + bass", short: "LOW", color: "#4d6bfe" },
  { id: "lowmid", label: "Low mid / body", short: "L-MID", color: "#7c5cff" },
  { id: "highmid", label: "High mid / vocals", short: "H-MID", color: "#23b5a5" },
  { id: "high", label: "High / hats + air", short: "HIGH", color: "#f0a726" },
];

export const STEM_CROSSOVERS = { low: 180, lowmid: 800, highmid: 5000 } as const;

export const defaultStemGains = (): Record<StemId, number> => ({
  low: 1,
  lowmid: 1,
  highmid: 1,
  high: 1,
});

export interface CenterFocus {
  mid: number;
  side: number;
}

export function centerFocus(width: number): CenterFocus {
  const clamped = Math.max(0, Math.min(1, width));
  return { mid: 1, side: 1 - clamped };
}

export function stemGainForBand(id: StemId): number {
  return STEMS.some((stem) => stem.id === id) ? 1 : 0;
}

export function applyStemSolo(
  gains: Record<StemId, number>,
  muted: Record<StemId, boolean>,
  solo: StemId | null,
): Record<StemId, number> {
  const out = { ...gains };
  for (const stem of STEMS) {
    if (muted[stem.id]) out[stem.id] = 0;
    else if (solo) out[stem.id] = solo === stem.id ? gains[stem.id] : 0;
  }
  return out;
}
