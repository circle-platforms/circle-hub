export const SEVERITY_BANDS = {
  minor: { order: 0, minimum: 0, maximum: 2 },
  major: { order: 1, minimum: 3, maximum: 5 },
  critical: { order: 2, minimum: 6, maximum: 7 },
} as const;

export type Severity = keyof typeof SEVERITY_BANDS;
export type SeverityBand = { severity: Severity; minimum: number; maximum: number };

export function worstSeverity(ranks: readonly unknown[]): SeverityBand | { invalid: true } | null {
  let worst: Severity | null = null;
  for (const rank of ranks) {
    if (typeof rank !== 'string' || !Object.hasOwn(SEVERITY_BANDS, rank)) return { invalid: true };
    if (worst === null || SEVERITY_BANDS[rank as Severity].order > SEVERITY_BANDS[worst].order) worst = rank as Severity;
  }
  return worst === null ? null : { severity: worst, ...SEVERITY_BANDS[worst] };
}

export function levelNumber(rank: unknown): number | null {
  if (typeof rank !== 'string') return null;
  const match = /^P([0-7])$/.exec(rank);
  return match === null ? null : Number(match[1]);
}
