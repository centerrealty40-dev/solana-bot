/**
 * Rug risk at entry — a sizing input, not a quality filter.
 *
 * Live census (774 closed positions): 41 collapsed to −70% or worse. None of the
 * gates we run could see them coming — liquidity, market cap and the
 * liquidity/mcap ratio are statistically identical between the 41 rugs and the
 * other 733 trades (rug median liq $19.4k vs $19.5k, mcap $67.8k vs $66.3k,
 * liq/mcap 0.27 vs 0.29).
 *
 * The leaders we shadow do not avoid these names either — 10.7% of their closed
 * sessions end at −70% or worse, twice our 5.3%, and they run an explicit
 * `rug_knife` class. What they do differently is **size**: on entries with
 * pc5m < −35% and turnover > 0.8 their clip is $0.92–$4.32, while their
 * conviction names get $10–$27. We flat-sized both — average $6.10 on a rug
 * versus $6.32 on everything else.
 *
 * Which classes to price down is measured, not assumed. Size-weighted realized
 * outcome per position over the same 774:
 *
 * | slice              |   n | mean  | winrate |
 * |--------------------|-----|-------|---------|
 * | pc5m −60…−45       |  19 | −34.7 |    0.11 |
 * | pc5m below −60     |  14 | −13.4 |    0.36 |
 * | pc5m −45…−35       |  12 |  +3.7 |    0.33 |
 * | pc5m −35…−25       |  15 |  +1.9 |    0.53 |
 * | turnover ≥ 6       |   9 | −28.4 |    0.33 |
 * | turnover 3…6       |  32 | −14.6 |    0.34 |
 * | turnover 1.5…3     |  63 |  −1.3 |    0.44 |
 *
 * So a −35% dump is not the problem and a 1.5 turnover is not either — the
 * damage sits below −45% and above 3.0. Clipping those two to $2 is worth about
 * +470 pct-of-clip units over the sample, and the whole neighbourhood of the
 * thresholds is positive (turn 3 → +472, turn 4 → +505, turn 6 → +405), so this
 * is not balanced on one setting.
 *
 * Refusing outright is deliberately off by default: entries below −85% were 6
 * positions with **zero** rugs and 4 that reached +15%. The deepest dumps are
 * not the scams — they are the hardest bounces.
 */

export type RugRiskTier = 'normal' | 'knife' | 'blocked';

export type RugRiskGates = {
  /** pc5m at or below this is knife-sized. 0 disables the dump leg. */
  knifeDumpPct: number;
  /** vol5m/liquidity at or above this is knife-sized. 0 disables the turn leg. */
  knifeTurn: number;
  /** pc5m at or below this is refused. 0 disables — see the note above. */
  blockDumpPct: number;
};

export type RugRiskAssessment = {
  tier: RugRiskTier;
  reasons: string[];
  /** vol5m / liquidity, when both are known. */
  turn: number | null;
};

export function assessRugRisk(args: {
  pc5mPct: number | null | undefined;
  volume5mUsd: number | null | undefined;
  liquidityUsd: number | null | undefined;
  gates: RugRiskGates;
}): RugRiskAssessment {
  const { gates } = args;
  const pc = num(args.pc5mPct);
  const vol = num(args.volume5mUsd);
  const liq = num(args.liquidityUsd);
  const turn = vol != null && liq != null && liq > 0 ? vol / liq : null;

  const reasons: string[] = [];

  if (gates.blockDumpPct < 0 && pc != null && pc <= gates.blockDumpPct) {
    return { tier: 'blocked', reasons: [`dump_spent=${pc.toFixed(1)}%`], turn };
  }

  if (gates.knifeDumpPct < 0 && pc != null && pc <= gates.knifeDumpPct) {
    reasons.push(`deep_dump=${pc.toFixed(1)}%`);
  }
  if (gates.knifeTurn > 0 && turn != null && turn >= gates.knifeTurn) {
    reasons.push(`hot_turn=${turn.toFixed(2)}`);
  }

  return { tier: reasons.length > 0 ? 'knife' : 'normal', reasons, turn };
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
