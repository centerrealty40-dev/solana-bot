import {
  effectiveExitLadder,
  effectiveStopLossPct,
  nextExitRung,
  parseExitLadderSpec,
  type EffectiveExitRung,
} from './exit-ladder.js';
import { parseFollowSlMode, stopLossAllowed, type FollowSlMode } from './exit-policy.js';

export type SimLeg = { usd: number; fillPriceUsd: number; ts: number };

export type SimPosition = {
  mint: string;
  openedAt: number;
  legs: SimLeg[];
  rungsTaken: string[];
  remainingFrac: number;
  leaderSoldSinceOpen: boolean;
};

export type FollowSimParams = {
  legUsd: number;
  maxBuyLegs: number;
  minLeaderBuyUsd: number;
  exitLeadPct: number;
  exitLadderRaw: string;
  slSingleLegPct: number;
  slMultiLegPct: number;
  slPreDcaPct: number;
  slMode: FollowSlMode;
};

export type FollowSimEvent =
  | { kind: 'leader_buy'; ts: number; mint: string; priceUsd: number; amountUsd: number; baseRaw: bigint }
  | { kind: 'leader_sell'; ts: number; mint: string; priceUsd: number; baseRaw: bigint };

export type SimExitAction =
  | { action: 'stop_loss'; pnlPct: number; mark: number }
  | { action: 'tp'; rungId: string; sellFrac: number; pnlPct: number; mark: number; isFinal: boolean };

export type SimRoundTrip = {
  mint: string;
  legs: number;
  exitReason: string;
  pnlUsd: number;
  pnlPct: number;
  holdSec: number;
  slBlockedWhileLeaderHeld?: boolean;
};

export type FollowSimResult = {
  params: FollowSimParams;
  roundTrips: SimRoundTrip[];
  sumPnlUsd: number;
  winRatePct: number;
  stopLossCount: number;
  ladderCount: number;
  openLeaderHolds: number;
};

function avgFillPrice(legs: SimLeg[]): number {
  let w = 0;
  let t = 0;
  for (const l of legs) {
    if (l.fillPriceUsd > 0) {
      w += l.usd;
      t += l.usd / l.fillPriceUsd;
    }
  }
  return t > 0 ? w / t : 0;
}

function investedRemainingUsd(pos: SimPosition): number {
  const all = pos.legs.reduce((s, l) => s + l.usd, 0);
  return all * Math.max(0, pos.remainingFrac);
}

function pnlPctVsAvg(pos: SimPosition, mark: number): number {
  const avg = avgFillPrice(pos.legs);
  if (!(avg > 0) || !(mark > 0)) return 0;
  return ((mark - avg) / avg) * 100;
}

function absRaw(raw: bigint): bigint {
  return raw < 0n ? -raw : raw;
}

export function evaluateSimExit(
  pos: SimPosition,
  mark: number,
  params: FollowSimParams,
  ladder: EffectiveExitRung[],
  leaderHolds: boolean,
): SimExitAction | null {
  if (pos.remainingFrac <= 1e-6 || !(mark > 0)) return null;

  const pnlPct = pnlPctVsAvg(pos, mark);
  const multiLeg = pos.legs.length > 1;
  const slPct = effectiveStopLossPct(
    params.slSingleLegPct,
    params.exitLeadPct,
    multiLeg,
    params.slMultiLegPct,
    {
      legs: pos.legs.length,
      maxBuyLegs: params.maxBuyLegs,
      slPreDcaPct: params.slPreDcaPct,
    },
  );

  if (
    pnlPct <= -slPct &&
    stopLossAllowed({
      slMode: params.slMode,
      leaderHolds,
      leaderSoldSinceOpen: pos.leaderSoldSinceOpen,
    })
  ) {
    return { action: 'stop_loss', pnlPct, mark };
  }

  const rung = nextExitRung(ladder, pos.rungsTaken);
  if (!rung || pnlPct < rung.effectiveTpPct) return null;

  return {
    action: 'tp',
    rungId: rung.id,
    sellFrac: rung.sellFracOfRemaining,
    pnlPct,
    mark,
    isFinal: rung.isFinal,
  };
}

function applyTp(pos: SimPosition, sellFrac: number, rungId: string, isFinal: boolean): void {
  pos.rungsTaken.push(rungId);
  if (isFinal) {
    pos.remainingFrac = 0;
  } else {
    pos.remainingFrac = Math.max(0, pos.remainingFrac * (1 - sellFrac));
  }
}

function firstTriggerInRange(
  pos: SimPosition,
  params: FollowSimParams,
  ladder: EffectiveExitRung[],
  leaderHoldsAt: (ts: number) => boolean,
  tsMs: number[],
  px: number[],
  t0: number,
  t1: number,
): { ts: number; mark: number; exit: SimExitAction } | null {
  const i0 = bisectLeft(tsMs, t0);
  const i1 = bisectLeft(tsMs, t1 + 1) - 1;
  if (i0 < 0 || i1 < 0 || i0 > i1) return null;

  for (let i = i0; i <= i1; i++) {
    const mark = px[i]!;
    if (!(mark > 0)) continue;
    const exit = evaluateSimExit(pos, mark, params, ladder, leaderHoldsAt(tsMs[i]!));
    if (exit) return { ts: tsMs[i]!, mark, exit };
  }
  return null;
}

function bisectLeft(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function simulateFollowExits(args: {
  events: FollowSimEvent[];
  snapshotsByMint: Map<string, { tsMs: number[]; px: number[] }>;
  params: FollowSimParams;
}): FollowSimResult {
  const { events, snapshotsByMint, params } = args;
  const ladder = effectiveExitLadder(parseExitLadderSpec(params.exitLadderRaw), params.exitLeadPct);

  const leaderBal = new Map<string, bigint>();
  const positions = new Map<string, SimPosition>();
  const roundTrips: SimRoundTrip[] = [];
  let sumPnlUsd = 0;

  const leaderHoldsMint = (mint: string): boolean => (leaderBal.get(mint) ?? 0n) > 0n;

  const leaderHoldsAt = (mint: string, ts: number): boolean => {
    void ts;
    return leaderHoldsMint(mint);
  };

  const closePosition = (pos: SimPosition, exitReason: string, pnlUsd: number, pnlPct: number, ts: number) => {
    roundTrips.push({
      mint: pos.mint,
      legs: pos.legs.length,
      exitReason,
      pnlUsd,
      pnlPct,
      holdSec: Math.max(0, Math.round((ts - pos.openedAt) / 1000)),
    });
    sumPnlUsd += pnlUsd;
    positions.delete(pos.mint);
  };

  const scanUntil = (mint: string, pos: SimPosition, t0: number, t1: number) => {
    const ser = snapshotsByMint.get(mint);
    if (!ser?.tsMs.length) return;
    while (pos.remainingFrac > 1e-6) {
      const hit = firstTriggerInRange(
        pos,
        params,
        ladder,
        (ts) => leaderHoldsAt(mint, ts),
        ser.tsMs,
        ser.px,
        t0,
        t1,
      );
      if (!hit) break;

      const inv = investedRemainingUsd(pos);
      if (hit.exit.action === 'stop_loss') {
        const realized = inv * (hit.exit.pnlPct / 100);
        closePosition(pos, 'stop_loss', realized, hit.exit.pnlPct, hit.ts);
        return;
      }

      const frac = hit.exit.sellFrac;
      const sliceInv = inv * frac;
      const realized = sliceInv * (hit.exit.pnlPct / 100);
      sumPnlUsd += realized;
      applyTp(pos, frac, hit.exit.rungId, hit.exit.isFinal);
      if (hit.exit.isFinal || pos.remainingFrac <= 1e-6) {
        closePosition(pos, hit.exit.rungId, realized, hit.exit.pnlPct, hit.ts);
        return;
      }
      t0 = hit.ts + 1;
    }
  };

  for (let ei = 0; ei < events.length; ei++) {
    const ev = events[ei]!;
    const nextTs = events[ei + 1]?.ts ?? ev.ts + 86_400_000;

    if (ev.kind === 'leader_buy') {
      const pre = leaderBal.get(ev.mint) ?? 0n;
      leaderBal.set(ev.mint, pre + absRaw(ev.baseRaw));

      let pos = positions.get(ev.mint);
      if (pos) {
        if (pos.legs.length < params.maxBuyLegs && ev.amountUsd >= params.minLeaderBuyUsd) {
          pos.legs.push({ usd: params.legUsd, fillPriceUsd: ev.priceUsd, ts: ev.ts });
          scanUntil(ev.mint, pos, ev.ts, nextTs);
        }
      } else if (pre === 0n && ev.amountUsd >= params.minLeaderBuyUsd) {
        pos = {
          mint: ev.mint,
          openedAt: ev.ts,
          legs: [{ usd: params.legUsd, fillPriceUsd: ev.priceUsd, ts: ev.ts }],
          rungsTaken: [],
          remainingFrac: 1,
          leaderSoldSinceOpen: false,
        };
        positions.set(ev.mint, pos);
        const mark = ev.priceUsd;
        const instant = evaluateSimExit(pos, mark, params, ladder, leaderHoldsMint(ev.mint));
        if (instant?.action === 'tp') {
          const inv = investedRemainingUsd(pos);
          const sliceInv = inv * instant.sellFrac;
          const realized = sliceInv * (instant.pnlPct / 100);
          sumPnlUsd += realized;
          applyTp(pos, instant.sellFrac, instant.rungId, instant.isFinal);
          if (instant.isFinal || pos.remainingFrac <= 1e-6) {
            closePosition(pos, instant.rungId, realized, instant.pnlPct, ev.ts);
          }
        }
        if (positions.has(ev.mint)) scanUntil(ev.mint, pos, ev.ts, nextTs);
      }
      continue;
    }

    if (ev.kind === 'leader_sell') {
      const pre = leaderBal.get(ev.mint) ?? 0n;
      const sold = absRaw(ev.baseRaw);
      leaderBal.set(ev.mint, pre > sold ? pre - sold : 0n);

      const pos = positions.get(ev.mint);
      if (pos) {
        pos.leaderSoldSinceOpen = true;
        const mark = ev.priceUsd;
        const instant = evaluateSimExit(pos, mark, params, ladder, leaderHoldsMint(ev.mint));
        if (instant?.action === 'stop_loss') {
          const inv = investedRemainingUsd(pos);
          const realized = inv * (instant.pnlPct / 100);
          closePosition(pos, 'stop_loss', realized, instant.pnlPct, ev.ts);
        } else if (instant?.action === 'tp') {
          const inv = investedRemainingUsd(pos);
          const sliceInv = inv * instant.sellFrac;
          const realized = sliceInv * (instant.pnlPct / 100);
          sumPnlUsd += realized;
          applyTp(pos, instant.sellFrac, instant.rungId, instant.isFinal);
          if (instant.isFinal || pos.remainingFrac <= 1e-6) {
            closePosition(pos, instant.rungId, realized, instant.pnlPct, ev.ts);
          }
        }
        if (positions.has(ev.mint)) scanUntil(ev.mint, pos, ev.ts, nextTs);
      }
    }
  }

  for (const pos of [...positions.values()]) {
    if (leaderHoldsMint(pos.mint)) continue;
    const ser = snapshotsByMint.get(pos.mint);
    const lastMark = ser?.px.at(-1) ?? avgFillPrice(pos.legs);
    const lastTs = ser?.tsMs.at(-1) ?? pos.openedAt;
    const inv = investedRemainingUsd(pos);
    const pnlPct = pnlPctVsAvg(pos, lastMark);
    closePosition(pos, 'eod_mark', inv * (pnlPct / 100), pnlPct, lastTs);
  }

  const wins = roundTrips.filter((r) => r.pnlUsd > 0).length;
  const openLeaderHolds = [...positions.values()].filter((p) => leaderHoldsMint(p.mint)).length;
  return {
    params,
    roundTrips,
    sumPnlUsd: +sumPnlUsd.toFixed(4),
    winRatePct: roundTrips.length ? +((wins / roundTrips.length) * 100).toFixed(1) : 0,
    stopLossCount: roundTrips.filter((r) => r.exitReason === 'stop_loss').length,
    ladderCount: roundTrips.filter((r) => r.exitReason.startsWith('tp')).length,
    openLeaderHolds,
  };
}

export function defaultSimParams(overrides: Partial<FollowSimParams> = {}): FollowSimParams {
  return {
    legUsd: 3,
    maxBuyLegs: 3,
    minLeaderBuyUsd: 20,
    exitLeadPct: 2,
    exitLadderRaw: '13:0.7,25:1',
    slSingleLegPct: 20,
    slMultiLegPct: 22,
    slPreDcaPct: 35,
    slMode: parseFollowSlMode(undefined),
    ...overrides,
  };
}
