import fs from 'node:fs';

import type { TwapSide } from '../types.js';
import { hlTwapUnrestrictedMode } from '../unrestricted.js';

export type ClosedTradeOutcome = {
  hash: string;
  coin: string;
  side: TwapSide;
  closeTs: number;
  pnlUsd: number;
};

function envInt(name: string, fallback: number, min = 0): number {
  const v = process.env[name]?.trim();
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.round(n));
}

function envBool(name: string, defaultOn: boolean): boolean {
  const v = process.env[name]?.trim();
  if (v == null || v === '') return defaultOn;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

/** Gate B: block long after any prior losing close on same coin+side (journal). Default on. */
export function coinPriorLossBlockEnabled(): boolean {
  return envBool('HL_TWAP_LIVE_COIN_PRIOR_LOSS_BLOCK', true);
}

/** Block re-entry after N consecutive losses on same coin+side. Default on. */
export function lossStreakCooldownEnabled(): boolean {
  return envBool('HL_TWAP_LIVE_LOSS_STREAK_COOLDOWN', true);
}

export function lossStreakCount(): number {
  return envInt('HL_TWAP_LIVE_LOSS_STREAK_COUNT', 2, 1);
}

export function lossStreakCooldownMs(): number {
  const hours = envInt('HL_TWAP_LIVE_LOSS_STREAK_COOLDOWN_HOURS', 2, 0);
  const ms = envInt('HL_TWAP_LIVE_LOSS_STREAK_COOLDOWN_MS', 0, 0);
  if (ms > 0) return ms;
  return hours * 60 * 60 * 1000;
}

/** Scan journal once: chronological closes with coin+side from open rows. */
export function loadClosedTradeOutcomes(journalPath: string): ClosedTradeOutcome[] {
  if (!fs.existsSync(journalPath)) return [];
  const opens = new Map<string, { coin: string; side: TwapSide }>();
  const out: ClosedTradeOutcome[] = [];
  for (const ln of fs.readFileSync(journalPath, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    let ev: { kind?: string; hash?: string; coin?: string; side?: TwapSide; ts?: number; pnlUsd?: number };
    try {
      ev = JSON.parse(ln) as typeof ev;
    } catch {
      continue;
    }
    if (ev.kind === 'open' && ev.hash && ev.coin && ev.side) {
      opens.set(ev.hash, { coin: ev.coin, side: ev.side });
    } else if (ev.kind === 'close' && ev.hash) {
      const op = opens.get(ev.hash);
      if (op) {
        out.push({
          hash: ev.hash,
          coin: op.coin,
          side: op.side,
          closeTs: Number(ev.ts) || 0,
          pnlUsd: Number(ev.pnlUsd) || 0,
        });
      }
      opens.delete(ev.hash);
    }
  }
  return out;
}

/** Gate B — any prior loss on coin+side blocks new long entries. */
export function liveCoinPriorLossBlockReason(
  coin: string,
  side: TwapSide,
  journalPath: string,
): string | null {
  if (hlTwapUnrestrictedMode()) return null;
  if (!coinPriorLossBlockEnabled() || side !== 'buy') return null;
  const history = loadClosedTradeOutcomes(journalPath).filter(
    (c) => c.coin === coin && c.side === side,
  );
  if (history.some((c) => c.pnlUsd < 0)) return 'coin_prior_loss';
  return null;
}

/**
 * After `lossStreakCount()` consecutive losses on same coin+side,
 * block new entries until `lossStreakCooldownMs()` after the last losing close.
 */
export function liveLossStreakBlockReason(
  coin: string,
  side: TwapSide,
  journalPath: string,
  nowMs = Date.now(),
): string | null {
  if (hlTwapUnrestrictedMode()) return null;
  if (!lossStreakCooldownEnabled()) return null;
  const need = lossStreakCount();
  const cooldownMs = lossStreakCooldownMs();
  if (need < 1 || cooldownMs <= 0) return null;

  const history = loadClosedTradeOutcomes(journalPath)
    .filter((c) => c.coin === coin && c.side === side)
    .sort((a, b) => a.closeTs - b.closeTs);

  if (history.length < need) return null;

  const tail = history.slice(-need);
  if (!tail.every((c) => c.pnlUsd < 0)) return null;

  const lastCloseTs = tail[tail.length - 1]!.closeTs;
  const untilMs = lastCloseTs + cooldownMs;
  if (nowMs >= untilMs) return null;

  const remainMin = Math.ceil((untilMs - nowMs) / 60_000);
  return `loss_streak_cooldown_${need}x_${remainMin}m`;
}
