import { buildSignal, type Hypothesis, type HypothesisPositionView, type HypothesisSignal, type MarketCtx, type NormalizedSwap, type ExitSignal } from './base.js';
import { child } from '../core/logger.js';

const log = child('h7');

/**
 * H7 — Confluence Gate (meta-hypothesis)
 *
 * Idea: a single signal is noise; multiple INDEPENDENT signals on the same token
 * within a short window is a real edge. We sit on top of H1..H6 and only enter
 * when the cumulative weighted score crosses a threshold AND the negative-copy
 * filter (H5) has not flagged the token as "dumb money in".
 *
 * Tiering reflects how rare/strong each underlying signal is in practice:
 *   - Tier A (2 pts): h2 (wallet cluster), h3 (dev signal), h4 (pre-listing), h6 (snipe-then-hold)
 *   - Tier B (1 pt): h1 (confirmation gate)
 *   - Veto (any sell signal in window): h5 (negative copy)
 *
 * MIN_SCORE = 4 means at least one of:
 *   - 2 different Tier-A hypotheses                   (2 + 2)
 *   - 1 Tier-A + 2 Tier-B                              (2 + 1 + 1)  — not possible with current B set
 *   - 1 Tier-A + diversity bonus                       (2 + 2 if 3+ distinct hyps)
 *   - 4 Tier-B hypotheses                              (1 * 4)      — not possible with current B set
 * Diversity bonus: +2 if 3+ DISTINCT hypotheses fired in window.
 *
 * Position size: 3× base ($150) — this is the strongest conviction in the platform.
 * Exits: tight (high conviction = expect immediate follow-through). Any H5 sell signal
 * appearing post-entry forces an immediate full close.
 */
export class H7ConfluenceGate implements Hypothesis {
  id = 'h7';
  describe(): string {
    return 'Meta gate: enter only when 2+ independent hypotheses converge on same mint within 60min, no H5 veto';
  }

  private readonly TIER_WEIGHTS: Record<string, number> = {
    h1: 1,
    h2: 2,
    h3: 2,
    h4: 2,
    h6: 2,
  };
  private readonly VETO_HYP = 'h5';
  private readonly MIN_SCORE = 4;
  private readonly DIVERSITY_BONUS_THRESHOLD = 3;
  private readonly DIVERSITY_BONUS = 2;
  private readonly MIN_SWAP_USD = 200;
  private readonly POSITION_SIZE_USD = 150;
  private readonly COOLDOWN_MS = 12 * 3600_000;
  private readonly THROTTLE_MS = 10_000;
  private readonly HARD_STOP = -0.08;
  private readonly TRAIL_FROM_HWM = -0.12;
  private readonly TP_LEVEL = 0.30;
  private readonly TIMEOUT_MS = 18 * 3600_000;

  /** mint -> last evaluation ts (throttle expensive scoring) */
  private lastChecked = new Map<string, number>();
  /** mint -> last entry ts (cooldown to avoid re-entering) */
  private lastEntered = new Map<string, number>();

  onSwap(swap: NormalizedSwap, ctx: MarketCtx): HypothesisSignal[] | null {
    if (swap.side !== 'buy') return null;
    if (swap.amountUsd < this.MIN_SWAP_USD) return null;

    const mint = swap.baseMint;
    const now = Date.now();

    const lastCheck = this.lastChecked.get(mint) ?? 0;
    if (now - lastCheck < this.THROTTLE_MS) return null;
    this.lastChecked.set(mint, now);

    const lastEntry = this.lastEntered.get(mint) ?? 0;
    if (now - lastEntry < this.COOLDOWN_MS) return null;

    // Veto: any H5 sell signal in window kills the entry
    const veto = ctx.recentSignals.get(this.VETO_HYP);
    if (veto && veto.side === 'sell') {
      return null;
    }

    // Score buy-side signals from underlying hypotheses
    const fired: Array<{ id: string; weight: number; reason: string }> = [];
    let score = 0;
    for (const [hypId, agg] of ctx.recentSignals) {
      if (hypId === this.id) continue;
      if (agg.side !== 'buy') continue;
      const w = this.TIER_WEIGHTS[hypId];
      if (!w) continue;
      score += w;
      fired.push({ id: hypId, weight: w, reason: agg.lastReason });
    }
    if (fired.length === 0) return null;

    if (fired.length >= this.DIVERSITY_BONUS_THRESHOLD) {
      score += this.DIVERSITY_BONUS;
    }

    if (score < this.MIN_SCORE) return null;

    this.lastEntered.set(mint, now);

    const reasonText =
      `confluence score=${score} from [${fired.map((f) => `${f.id}(+${f.weight})`).join(', ')}]` +
      (fired.length >= this.DIVERSITY_BONUS_THRESHOLD ? ` +diversity` : '');
    log.info({ mint, score, fired }, 'H7 confluence triggered');

    return [
      buildSignal(this.id, mint, 'buy', this.POSITION_SIZE_USD, reasonText, {
        score,
        triggers: fired.map((f) => ({ id: f.id, weight: f.weight, reason: f.reason })),
        triggeredAt: now,
        hwmPrice: swap.priceUsd,
      }),
    ];
  }

  shouldExit(pos: HypothesisPositionView, ctx: MarketCtx): ExitSignal | null {
    const meta = pos.signalMeta as { hwmPrice?: number; triggeredAt?: number };
    const now = Date.now();
    const heldMs = now - pos.openedAt.getTime();

    // High-water mark tracking via meta (mutated in place between calls — same object)
    const prevHwm = typeof meta.hwmPrice === 'number' ? meta.hwmPrice : pos.entryPriceUsd;
    const hwm = Math.max(prevHwm, pos.currentPriceUsd);
    meta.hwmPrice = hwm;

    const pnlPct = pos.currentPriceUsd / pos.entryPriceUsd - 1;
    const drawFromHwm = pos.currentPriceUsd / hwm - 1;

    // Veto appearing AFTER entry → emergency exit
    const veto = ctx.recentSignals.get(this.VETO_HYP);
    if (veto && veto.side === 'sell' && veto.lastTs.getTime() > pos.openedAt.getTime()) {
      return { reason: `H5 veto post-entry: ${veto.lastReason}`, fraction: 1 };
    }

    if (pnlPct <= this.HARD_STOP) {
      return { reason: `hard stop ${(pnlPct * 100).toFixed(1)}%`, fraction: 1 };
    }
    if (drawFromHwm <= this.TRAIL_FROM_HWM && hwm > pos.entryPriceUsd * 1.05) {
      return { reason: `trailing ${(drawFromHwm * 100).toFixed(1)}% from HWM`, fraction: 1 };
    }
    if (pos.exitsCount === 0 && pnlPct >= this.TP_LEVEL) {
      return { reason: `take-profit 50% at +${(pnlPct * 100).toFixed(1)}%`, fraction: 0.5 };
    }
    if (heldMs >= this.TIMEOUT_MS) {
      return { reason: `timeout ${Math.floor(heldMs / 3600_000)}h`, fraction: 1 };
    }
    return null;
  }
}
