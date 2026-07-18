/**
 * Live holder gate: QuickNode GPA resolve → optional Shyft fallback → block/warn policy.
 */
import type { PaperTraderConfig } from '../config.js';
import type { HoldersDecisionMeta } from './holder-types.js';
import { resolveHolderCount } from './holders-resolve.js';
import { resolveShyftHolderCount } from './shyft-holder-resolve.js';

export interface HolderGateEvalInput {
  cfg: PaperTraderConfig;
  mint: string;
  dbHolders: number;
  cheapPass: boolean;
  liveHoldersForObservability: boolean;
  liveHoldersForGate: boolean;
  liveHoldersThisTick: number;
}

export interface HolderGateEvalResult {
  holderReasons: string[];
  holdersMeta?: HoldersDecisionMeta;
  liveHoldersThisTick: number;
}

async function tryShyftHolderCount(
  cfg: PaperTraderConfig,
  mint: string,
): Promise<{ count: number } | { failReason: string }> {
  if (!cfg.shyftHoldersEnabled) return { failReason: 'shyft_disabled' };
  const shyft = await resolveShyftHolderCount(mint, {
    ttlMs: cfg.shyftHoldersTtlMs,
    timeoutMs: cfg.shyftHoldersTimeoutMs,
  });
  if (shyft.ok) return { count: shyft.count };
  return { failReason: `shyft_${shyft.reason}` };
}

function applyGateFailure(
  cfg: PaperTraderConfig,
  dbHolders: number,
  failReason: string,
  liveHoldersForGate: boolean,
  cheapPass: boolean,
): { holderReasons: string[]; holdersMeta: HoldersDecisionMeta } {
  const holderReasons: string[] = [];
  const holdersMeta: HoldersDecisionMeta = {
    holders_db: dbHolders,
    holders_live: null,
    holders_source: 'none',
    holders_age_ms: null,
    holders_fail_reason: failReason,
    holders_used_for_gate: dbHolders,
  };
  if (liveHoldersForGate) {
    if (cfg.holdersOnFail === 'block') {
      holderReasons.push(`holders_unknown:${failReason}`);
      if (cheapPass) holdersMeta.holders_unknown_after_cheap_pass = true;
    } else if (cfg.holdersOnFail === 'warn') {
      /** Unknown count — do not block; observability + optional Telegram ADVICE. */
      if (cheapPass) holdersMeta.holders_unknown_after_cheap_pass = true;
    } else if (cfg.holdersOnFail === 'db_fallback') {
      holdersMeta.holders_source = 'db';
      if (dbHolders < cfg.globalMinHolderCount) {
        holderReasons.push(`holders<${cfg.globalMinHolderCount}:db_fallback`);
      }
    }
  }
  return { holderReasons, holdersMeta };
}

/**
 * Evaluate holder count for a discovery candidate that passed all pre-holder gates.
 */
export async function evaluateHolderGate(input: HolderGateEvalInput): Promise<HolderGateEvalResult> {
  const {
    cfg,
    mint,
    dbHolders,
    cheapPass,
    liveHoldersForObservability,
    liveHoldersForGate,
    liveHoldersThisTick: tickIn,
  } = input;

  if (!liveHoldersForObservability || !cheapPass) {
    return { holderReasons: [], holdersMeta: undefined, liveHoldersThisTick: tickIn };
  }

  let liveHoldersThisTick = tickIn;
  const qnBudgetOk = liveHoldersThisTick < cfg.holdersMaxPerTick;

  if (qnBudgetOk && cfg.holdersLiveEnabled) {
    liveHoldersThisTick += 1;
    const r = await resolveHolderCount(cfg, mint);
    if (r.ok) {
      const holderReasons: string[] = [];
      const holdersMeta: HoldersDecisionMeta = {
        holders_db: dbHolders,
        holders_live: r.count,
        holders_source: r.source,
        holders_age_ms: r.ageMs,
        holders_used_for_gate: r.count,
      };
      if (liveHoldersForGate && r.count < cfg.globalMinHolderCount) {
        holderReasons.push(`holders<${cfg.globalMinHolderCount}`);
      }
      return { holderReasons, holdersMeta, liveHoldersThisTick };
    }

    const shyft = cfg.shyftHoldersEnabled ? await tryShyftHolderCount(cfg, mint) : null;
    if (shyft != null && 'count' in shyft) {
      const holderReasons: string[] = [];
      const holdersMeta: HoldersDecisionMeta = {
        holders_db: dbHolders,
        holders_live: shyft.count,
        holders_source: 'shyft',
        holders_age_ms: 0,
        holders_fail_reason: r.reason,
        holders_used_for_gate: shyft.count,
      };
      if (liveHoldersForGate && shyft.count < cfg.globalMinHolderCount) {
        holderReasons.push(`holders<${cfg.globalMinHolderCount}`);
      }
      return { holderReasons, holdersMeta, liveHoldersThisTick };
    }

    const failReason =
      shyft != null && 'failReason' in shyft ? `${r.reason}+${shyft.failReason}` : r.reason;
    const blocked = applyGateFailure(cfg, dbHolders, failReason, liveHoldersForGate, cheapPass);
    return { ...blocked, liveHoldersThisTick };
  }

  if (!qnBudgetOk) {
    const shyft = cfg.shyftHoldersEnabled ? await tryShyftHolderCount(cfg, mint) : null;
    if (shyft != null && 'count' in shyft) {
      const holderReasons: string[] = [];
      const holdersMeta: HoldersDecisionMeta = {
        holders_db: dbHolders,
        holders_live: shyft.count,
        holders_source: 'shyft',
        holders_age_ms: 0,
        holders_fail_reason: 'budget_per_tick',
        holders_used_for_gate: shyft.count,
      };
      if (liveHoldersForGate && shyft.count < cfg.globalMinHolderCount) {
        holderReasons.push(`holders<${cfg.globalMinHolderCount}`);
      }
      return { holderReasons, holdersMeta, liveHoldersThisTick };
    }
    const failReason =
      shyft != null && 'failReason' in shyft
        ? shyft.failReason === 'shyft_disabled'
          ? 'budget_per_tick'
          : `budget_per_tick+${shyft.failReason}`
        : 'budget_per_tick';
    const blocked = applyGateFailure(cfg, dbHolders, failReason, liveHoldersForGate, cheapPass);
    return { ...blocked, liveHoldersThisTick };
  }

  if (cfg.shyftHoldersEnabled) {
    const shyftOnly = await tryShyftHolderCount(cfg, mint);
    if ('count' in shyftOnly) {
      const holderReasons: string[] = [];
      const holdersMeta: HoldersDecisionMeta = {
        holders_db: dbHolders,
        holders_live: shyftOnly.count,
        holders_source: 'shyft',
        holders_age_ms: 0,
        holders_used_for_gate: shyftOnly.count,
      };
      if (liveHoldersForGate && shyftOnly.count < cfg.globalMinHolderCount) {
        holderReasons.push(`holders<${cfg.globalMinHolderCount}`);
      }
      return { holderReasons, holdersMeta, liveHoldersThisTick };
    }

    const blocked = applyGateFailure(
      cfg,
      dbHolders,
      shyftOnly.failReason,
      liveHoldersForGate,
      cheapPass,
    );
    return { ...blocked, liveHoldersThisTick };
  }

  const blocked = applyGateFailure(
    cfg,
    dbHolders,
    'holders_live_disabled',
    liveHoldersForGate,
    cheapPass,
  );
  return { ...blocked, liveHoldersThisTick };
}
