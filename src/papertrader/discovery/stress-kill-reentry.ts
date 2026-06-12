import type { PaperTraderConfig } from '../config.js';
import type { DipContextByWindows } from '../dip-detector.js';
import type { SnapshotCandidateRow } from '../types.js';

const STRESS_EXIT_REASONS = new Set(['FLASH_CRASH_KILL', 'SL', 'KILLSTOP', 'LIQ_DRAIN']);

export type StressExitSnapshot = {
  exitTs: number;
  marketUsd: number;
  netPnlUsd?: number;
  exitReason?: string;
};

export function isStressExitSnapshot(snap: StressExitSnapshot): boolean {
  if ((snap.netPnlUsd ?? 0) < 0) return true;
  const r = snap.exitReason ?? '';
  return STRESS_EXIT_REASONS.has(r);
}

function isReentryGateExpired(
  cfg: PaperTraderConfig,
  snap: StressExitSnapshot,
  nowMs: number,
): boolean {
  const maxAgeH = cfg.liveReentryGateMaxAgeHours;
  if (!(maxAgeH > 0)) return false;
  return nowMs - snap.exitTs > maxAgeH * 3_600_000;
}

export type StressKillReentryContext = {
  snap: StressExitSnapshot;
  dropFromExitPct: number;
  maxBouncePct: number;
  maxWindowMin: number;
};

/** Recent stress exit + deep drop from last exit — eligible for stress kill re-entry relaxations. */
export function getStressKillReentryContext(
  cfg: PaperTraderConfig,
  snap: StressExitSnapshot | undefined,
  priceUsd: number,
  nowMs = Date.now(),
): StressKillReentryContext | null {
  if (!cfg.liveStressReentryEnabled) return null;
  if (!snap || !(snap.marketUsd > 0) || !(priceUsd > 0)) return null;
  if (isReentryGateExpired(cfg, snap, nowMs)) return null;
  if (!isStressExitSnapshot(snap)) return null;

  const dropFromExitPct = ((snap.marketUsd - priceUsd) / snap.marketUsd) * 100;
  const minDrop = cfg.liveStressReentryMinDropFromLastExitPct;
  if (minDrop > 0 && dropFromExitPct < minDrop) return null;

  return {
    snap,
    dropFromExitPct,
    maxBouncePct: cfg.liveStressReentryRecoveryVetoMaxBouncePct,
    maxWindowMin: cfg.liveStressReentryRecoveryVetoMaxWindowMin,
  };
}

export type StressKillReentryEval = {
  pass: boolean;
  reasons: string[];
  bounces: Record<number, number>;
};

/** Bounce from short-window low since crash — allow modest rebound (e.g. 1.8M → 1.87M mcap). */
export function evaluateStressKillReentryBounce(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctxByWindow: DipContextByWindows | null | undefined,
  stressCtx: StressKillReentryContext,
): StressKillReentryEval {
  const price = Number(row.price_usd);
  const reasons: string[] = [];
  const bounces: Record<number, number> = {};
  if (!(price > 0) || !ctxByWindow || ctxByWindow.size === 0) {
    return { pass: false, reasons: ['stress_reentry_ctx_missing'], bounces };
  }

  const thr = stressCtx.maxBouncePct;
  const windows = cfg.dipRecoveryVetoWindowsMin.filter((w) => w <= stressCtx.maxWindowMin);
  if (windows.length === 0) {
    return { pass: true, reasons: [], bounces };
  }

  for (const v of windows) {
    const ctx = ctxByWindow.get(v);
    if (!ctx || !(ctx.low_px > 0)) continue;
    const bounce = (price / ctx.low_px - 1) * 100;
    bounces[v] = +bounce.toFixed(2);
    if (bounce >= thr) {
      reasons.push(`stress_reentry_bounce_${v}m_${bounces[v].toFixed(1)}%>=${thr}%`);
    }
  }

  return { pass: reasons.length === 0, reasons, bounces };
}

export function evaluateStressKillReentryPath(
  cfg: PaperTraderConfig,
  snap: StressExitSnapshot | undefined,
  row: SnapshotCandidateRow,
  ctxByWindow: DipContextByWindows | null | undefined,
  nowMs = Date.now(),
): StressKillReentryEval & { stressCtx: StressKillReentryContext | null } {
  const stressCtx = getStressKillReentryContext(cfg, snap, row.price_usd, nowMs);
  if (!stressCtx) {
    return { pass: false, reasons: [], bounces: {}, stressCtx: null };
  }
  const bounceEval = evaluateStressKillReentryBounce(cfg, row, ctxByWindow, stressCtx);
  return { ...bounceEval, stressCtx };
}
