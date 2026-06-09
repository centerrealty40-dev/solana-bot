/** hnu5 forensic ladder — mirrored with lead offset on each TP rung. */

export type ExitLadderRungSpec = {
  /** Stable id for journal / state (tp1, tp2, …). */
  id: string;
  /** Leader take-profit threshold (% vs avg cost). */
  leaderTpPct: number;
  /** Fraction of **remaining** bag to sell at this rung (0–1). */
  sellFracOfRemaining: number;
};

export type EffectiveExitRung = ExitLadderRungSpec & {
  /** Our trigger = leaderTpPct − exitLeadPct (never below 0.5%). */
  effectiveTpPct: number;
  /** Last rung in ladder — closes position fully. */
  isFinal: boolean;
};

/** Default hnu5 / combo-v1 forensic: ~70% @ +13%, remainder @ +25%. */
export const HNU5_DEFAULT_EXIT_LADDER: ExitLadderRungSpec[] = [
  { id: 'tp1', leaderTpPct: 13, sellFracOfRemaining: 0.7 },
  { id: 'tp2', leaderTpPct: 25, sellFracOfRemaining: 1 },
];

/**
 * Parse `13:0.7,25:1` — pct:sellFrac pairs (sellFrac omitted → 1).
 */
export function parseExitLadderSpec(raw: string): ExitLadderRungSpec[] {
  const trimmed = raw.trim();
  if (!trimmed) return [...HNU5_DEFAULT_EXIT_LADDER];

  const rungs: ExitLadderRungSpec[] = [];
  for (const part of trimmed.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const [pctStr, fracStr] = p.split(':');
    const leaderTpPct = Number(pctStr);
    if (!Number.isFinite(leaderTpPct) || leaderTpPct <= 0) continue;
    const sellFracOfRemaining =
      fracStr != null && fracStr !== '' ? Number(fracStr) : 1;
    if (!Number.isFinite(sellFracOfRemaining) || sellFracOfRemaining <= 0) continue;
    rungs.push({
      id: `tp${rungs.length + 1}`,
      leaderTpPct,
      sellFracOfRemaining: Math.min(1, sellFracOfRemaining),
    });
  }
  return rungs.length > 0 ? rungs : [...HNU5_DEFAULT_EXIT_LADDER];
}

export function effectiveExitLadder(
  ladder: ExitLadderRungSpec[],
  exitLeadPct: number,
): EffectiveExitRung[] {
  const lead = Math.max(0, exitLeadPct);
  const sorted = [...ladder].sort((a, b) => a.leaderTpPct - b.leaderTpPct);
  const lastIdx = sorted.length - 1;
  return sorted.map((rung, i) => ({
    ...rung,
    effectiveTpPct: Math.max(0.5, +(rung.leaderTpPct - lead).toFixed(4)),
    isFinal: i === lastIdx,
  }));
}

/** SL ahead of leader = tighter stop (smaller loss %). */
export function effectiveStopLossPct(
  leaderSlPct: number,
  exitLeadPct: number,
  multiLeg: boolean,
  leaderSlMultiPct: number,
): number {
  const base = multiLeg ? leaderSlMultiPct : leaderSlPct;
  return Math.max(1, +(base - exitLeadPct).toFixed(4));
}

export function nextExitRung(
  ladder: EffectiveExitRung[],
  rungsTaken: string[],
): EffectiveExitRung | null {
  for (const rung of ladder) {
    if (!rungsTaken.includes(rung.id)) return rung;
  }
  return null;
}
