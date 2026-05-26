/**
 * W7.3 — Priority Fee monitor.
 *
 * One process-wide ticker polls getRecentPrioritizationFees through qn-client
 * (feature 'pri_fee'). Latest percentiles are cached in RAM and on disk so the
 * dashboard can read them without RPC.
 */
import fs from 'node:fs';
import path from 'node:path';
import { qnCall } from '../../core/rpc/qn-client.js';
import { child } from '../../core/logger.js';
import type { PaperTraderConfig } from '../config.js';
import type { PriorityFeeQuote } from '../types.js';

const log = child('priority-fee-monitor');

type RecentFee = { slot: number; prioritizationFee: number };

export type PercentileSnapshot = {
  p50: number | null;
  p75: number | null;
  p90: number | null;
  samples: number;
  ts: number;
};

interface State {
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  snap: PercentileSnapshot | null;
}

const state: State = { timer: null, inFlight: false, snap: null };

const CACHE_FILE_DEFAULT = path.join('data', 'priority-fee-cache.json');

function cachePath(): string {
  return process.env.PAPER_PRIORITY_FEE_CACHE_PATH?.trim() || CACHE_FILE_DEFAULT;
}

function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * (sorted.length - 1))),
  );
  return sorted[idx];
}

function persist(snap: PercentileSnapshot): void {
  try {
    const p = cachePath();
    const dir = path.dirname(p);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'priority-fee cache persist failed');
  }
}

export function readPriorityFeeCacheFromDisk(): PercentileSnapshot | null {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf8');
    const j = JSON.parse(raw) as Partial<PercentileSnapshot>;
    if (typeof j?.ts !== 'number') return null;
    return {
      p50: typeof j.p50 === 'number' ? j.p50 : null,
      p75: typeof j.p75 === 'number' ? j.p75 : null,
      p90: typeof j.p90 === 'number' ? j.p90 : null,
      samples: typeof j.samples === 'number' ? j.samples : 0,
      ts: j.ts,
    };
  } catch {
    return null;
  }
}

const LAMPORTS_PER_SIGNATURE = 5000;

/** USD for one swap-sized tx at given microLamports/CU (before rounding chain). */
export function priorityFeeUsdFromMicroLamportsPerCu(
  microLamportsPerCu: number,
  targetCu: number,
  solUsd: number,
): number {
  const baseUsd = solUsd > 0 ? (LAMPORTS_PER_SIGNATURE / 1e9) * solUsd : 0;
  const priorityUsd =
    solUsd > 0 ? ((microLamportsPerCu * targetCu) / 1e6 / 1e9) * solUsd : 0;
  return +(priorityUsd + baseUsd).toFixed(6);
}

/**
 * JSON for GET /api/paper2/priority-fee (dashboard reads disk even when traders down).
 */
export function buildPriorityFeeMonitorApiPayload(args: {
  solUsd: number;
  targetCu: number;
}): Record<string, unknown> {
  const snap = readPriorityFeeCacheFromDisk();
  if (!snap) {
    return { ok: false, reason: 'no-cache' };
  }
  const ageMs = Date.now() - snap.ts;
  const usdPerTxP75 =
    snap.p75 != null && args.solUsd > 0
      ? priorityFeeUsdFromMicroLamportsPerCu(snap.p75, args.targetCu, args.solUsd)
      : null;
  return {
    ok: true,
    microLamportsPerCu_p50: snap.p50,
    microLamportsPerCu_p75: snap.p75,
    microLamportsPerCu_p90: snap.p90,
    computeUnitsAssumed: args.targetCu,
    usdPerTx_p75: usdPerTxP75,
    samples: snap.samples,
    ageMs,
    ts: snap.ts,
    source: 'live',
  };
}

async function tick(cfg: PaperTraderConfig): Promise<void> {
  if (state.inFlight) return;
  state.inFlight = true;
  try {
    const r = await qnCall<RecentFee[]>(
      'getRecentPrioritizationFees',
      [[]],
      { feature: 'pri_fee', creditsPerCall: 30, timeoutMs: cfg.priorityFeeRpcTimeoutMs },
    );
    if (!r.ok) {
      log.debug({ reason: r.reason, message: r.message }, 'priority-fee tick failed (kept previous)');
      return;
    }
    const arr = Array.isArray(r.value) ? r.value : [];
    const withSlot = arr
      .map((x) => ({
        slot: Number(x?.slot ?? NaN),
        fee: Number(x?.prioritizationFee ?? 0),
      }))
      .filter((x) => Number.isFinite(x.slot) && Number.isFinite(x.fee) && x.fee >= 0);
    withSlot.sort((a, b) => a.slot - b.slot);
    const recent = withSlot.length > 150 ? withSlot.slice(-150) : withSlot;
    const fees = recent.map((x) => x.fee).filter((n) => Number.isFinite(n) && n >= 0);
    if (fees.length === 0) {
      log.debug({ raw: arr.length }, 'priority-fee tick returned 0 usable samples');
      return;
    }
    const snap: PercentileSnapshot = {
      p50: pct(fees, 50),
      p75: pct(fees, 75),
      p90: pct(fees, 90),
      samples: fees.length,
      ts: Date.now(),
    };
    state.snap = snap;
    persist(snap);
    log.debug({ p50: snap.p50, p75: snap.p75, p90: snap.p90, samples: snap.samples }, 'priority-fee tick ok');
  } finally {
    state.inFlight = false;
  }
}

export function startPriorityFeeTicker(cfg: PaperTraderConfig): void {
  if (!cfg.priorityFeeEnabled) return;
  if (state.timer) return;
  void tick(cfg);
  state.timer = setInterval(() => void tick(cfg), cfg.priorityFeeTickerMs);
  if (typeof state.timer.unref === 'function') state.timer.unref();
}

export function stopPriorityFeeTicker(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function selectPercentile(snap: PercentileSnapshot, key: 'p50' | 'p75' | 'p90'): number | null {
  return snap[key];
}

export function getPriorityFeeUsd(cfg: PaperTraderConfig, solUsd: number): PriorityFeeQuote {
  const fallback = (): PriorityFeeQuote => ({
    microLamportsPerCu: null,
    computeUnits: cfg.priorityFeeTargetCu,
    usd: cfg.networkFeeUsd,
    source: 'fallback',
    ageMs: null,
    ts: Date.now(),
  });
  if (!cfg.priorityFeeEnabled) return fallback();
  const snap = state.snap ?? readPriorityFeeCacheFromDisk();
  if (!snap) return fallback();
  const ageMs = Date.now() - snap.ts;
  if (ageMs > cfg.priorityFeeMaxAgeMs) return fallback();
  const sel = selectPercentile(snap, cfg.priorityFeePercentile);
  if (sel == null || !(sel >= 0)) return fallback();
  const usd = priorityFeeUsdFromMicroLamportsPerCu(sel, cfg.priorityFeeTargetCu, solUsd);
  return {
    microLamportsPerCu: sel,
    computeUnits: cfg.priorityFeeTargetCu,
    usd,
    source: 'live',
    ageMs,
    ts: Date.now(),
  };
}

/** Test seam — only used by vitest. */
export function _resetPriorityFeeStateForTests(): void {
  state.snap = null;
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.inFlight = false;
}
