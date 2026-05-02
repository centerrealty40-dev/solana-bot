/**
 * W7.6 — Impulse confirm entry path: PG delta trigger → QuickNode (Orca) → Jupiter corridor.
 */
import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import { qnCall } from '../../core/rpc/qn-client.js';
import { child } from '../../core/logger.js';
import type { PaperTraderConfig } from '../config.js';
import type { Lane, PriceVerifyVerdict } from '../types.js';
import { jupiterQuoteBuyPriceUsd } from './price-verify.js';
import {
  canSpendImpulseQnCredits,
  impulseFeatureAllowedByKillSwitch,
  impulseQnRollingSum,
  impulseRollingMaxCredits,
  recordImpulseQnCredits,
} from './impulse-qn-rolling.js';
import {
  decodeWhirlpoolSpotUsd,
  WHIRLPOOL_PROGRAM_ID,
} from './orca-whirlpool-spot.js';

const log = child('impulse-confirm');

function snapshotTable(source: string): string | null {
  if (source === 'raydium') return 'raydium_pair_snapshots';
  if (source === 'meteora') return 'meteora_pair_snapshots';
  if (source === 'orca') return 'orca_pair_snapshots';
  if (source === 'moonshot') return 'moonshot_pair_snapshots';
  if (source === 'pumpswap') return 'pumpswap_pair_snapshots';
  return null;
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

type PgSnap = { ts: Date; price_usd: number };

async function fetchLastTwoSnapshots(
  source: string,
  mint: string,
  pair: string,
): Promise<PgSnap[] | null> {
  const table = snapshotTable(source);
  if (!table) return null;
  const r = await db.execute(dsql.raw(`
    SELECT ts, COALESCE(price_usd, 0)::float AS price_usd
    FROM ${table}
    WHERE base_mint = ${sqlQuote(mint)}
      AND pair_address = ${sqlQuote(pair)}
    ORDER BY ts DESC
    LIMIT 2
  `));
  const rows = r as unknown as Array<{ ts: Date; price_usd: unknown }>;
  if (!Array.isArray(rows) || rows.length < 2) return null;
  return rows.map((row) => ({
    ts: row.ts instanceof Date ? row.ts : new Date(String(row.ts)),
    price_usd: Number(row.price_usd ?? 0),
  }));
}

export interface ImpulseConfirmStamp {
  verdict: 'pass' | 'fail' | 'skipped';
  reason?: string;
  dipPolicy?: string;
  trigger?: {
    ts_prev: string;
    ts_new: string;
    price_prev: number;
    price_new: number;
    delta_pg_pct: number;
    anchor_snapshot_price_usd: number;
  };
  onchainUsd?: number | null;
  onchainPath?: 'orca_qn' | 'none';
  jupiter?: PriceVerifyVerdict | null;
  corridor?: {
    anchorUsd: number;
    maxUpPct: number;
    maxDownPct: number;
    maxDisagreePct: number;
    deltaOnchainPct?: number;
    deltaJupiterPct?: number;
    disagreePct?: number;
  };
  qnCredits?: number;
  timingsMs?: { pg?: number; rpc?: number; jupiter?: number; total: number };
}

export interface ImpulseGateOk {
  blocksOpen: false;
  stamp: ImpulseConfirmStamp;
  /** When set, main may reuse this within ~2s to skip duplicate Jupiter call for W7.4. */
  jupiterVerdictForReuse: PriceVerifyVerdict | null;
}

export interface ImpulseGateBlock {
  blocksOpen: true;
  reason: string;
  stamp: ImpulseConfirmStamp;
}

export type ImpulseGateResult = ImpulseGateOk | ImpulseGateBlock;

const singleFlightUntil = new Map<string, number>();
const mintCooldownUntil = new Map<string, number>();
const rpcAttemptsMs: number[] = [];

/** Mint → latest Jupiter quote from impulse (short TTL). */
const jupiterReuse = new Map<string, { ts: number; verdict: PriceVerifyVerdict }>();

export function takeImpulseJupiterReuse(mint: string, maxAgeMs: number): PriceVerifyVerdict | null {
  const v = jupiterReuse.get(mint);
  if (!v) return null;
  if (Date.now() - v.ts > maxAgeMs) {
    jupiterReuse.delete(mint);
    return null;
  }
  jupiterReuse.delete(mint);
  return v.verdict;
}

function sfKey(cfg: PaperTraderConfig, mint: string, pair: string): string {
  return `${cfg.strategyId}:${mint}:${pair}`;
}

function pruneAttempts(now: number): void {
  const cut = now - 60_000;
  while (rpcAttemptsMs.length && rpcAttemptsMs[0]! < cut) rpcAttemptsMs.shift();
}

function corridorDeltaPct(anchor: number, spot: number): number {
  if (!(anchor > 0) || !(spot > 0)) return NaN;
  return ((spot - anchor) / anchor) * 100;
}

function disagreePct(a: number, b: number): number {
  const m = Math.min(a, b);
  if (!(m > 0)) return Infinity;
  return (Math.abs(a - b) / m) * 100;
}

function policyBlocksOnImpulseFail(policy: PaperTraderConfig['impulseDipPolicy']): boolean {
  return policy === 'parallel_and';
}

export async function runImpulseConfirmGate(args: {
  cfg: PaperTraderConfig;
  lane: Lane;
  mint: string;
  symbol: string;
  source: string;
  pairAddress: string | null;
  anchorPriceUsd: number;
  baseDecimals: number | null;
  solUsd: number;
}): Promise<ImpulseGateResult> {
  const { cfg, mint, source, pairAddress, anchorPriceUsd, baseDecimals, solUsd } = args;
  const t0 = Date.now();
  const idleStamp = (reason: string): ImpulseGateOk => ({
    blocksOpen: false,
    stamp: { verdict: 'skipped', reason, timingsMs: { total: Date.now() - t0 } },
    jupiterVerdictForReuse: null,
  });

  if (!cfg.impulseConfirmEnabled) return idleStamp('impulse:disabled');
  if (!impulseFeatureAllowedByKillSwitch()) return idleStamp('impulse:disabled_kill');

  if (!pairAddress || !pairAddress.trim()) {
    return idleStamp('impulse:no_pair_address');
  }
  const pair = pairAddress.trim();

  const tPg = Date.now();
  const snaps = await fetchLastTwoSnapshots(source, mint, pair);
  const pgMs = Date.now() - tPg;

  if (!snaps) return idleStamp('impulse:pg_insufficient_history');

  const sNew = snaps[0]!;
  const sPrev = snaps[1]!;
  const pNew = sNew.price_usd;
  const pPrev = sPrev.price_usd;
  if (!(pPrev > 0) || !(pNew > 0)) return idleStamp('impulse:pg_delta_below_threshold');

  const ageSec = (Date.now() - sNew.ts.getTime()) / 1000;
  if (ageSec < cfg.impulsePgMaxAgeSecMin || ageSec > cfg.impulsePgMaxAgeSecMax) {
    return idleStamp('impulse:pg_stale_or_too_fresh');
  }

  const deltaPgPct = ((pNew - pPrev) / pPrev) * 100;
  const absMode = cfg.impulsePgAbsMode;
  const triggered = absMode
    ? Math.abs(deltaPgPct) >= cfg.impulsePgMinAbsPct
    : deltaPgPct <= -cfg.impulsePgMinDropPct;

  if (!triggered) {
    return idleStamp('impulse:pg_delta_below_threshold');
  }

  const triggerCtx = {
    ts_prev: sPrev.ts.toISOString(),
    ts_new: sNew.ts.toISOString(),
    price_prev: pPrev,
    price_new: pNew,
    delta_pg_pct: +deltaPgPct.toFixed(4),
    anchor_snapshot_price_usd: pNew,
  };

  const anchor = pNew;

  const sfk = sfKey(cfg, mint, pair);
  const now = Date.now();
  if (singleFlightUntil.get(sfk)! > now) {
    const failStamp: ImpulseConfirmStamp = {
      verdict: 'fail',
      reason: 'impulse:busy',
      dipPolicy: cfg.impulseDipPolicy,
      trigger: triggerCtx,
      timingsMs: { pg: pgMs, total: Date.now() - t0 },
    };
    if (cfg.impulseDipPolicy === 'shadow' || cfg.impulseDipPolicy === 'parallel_or') {
      return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
    }
    if (policyBlocksOnImpulseFail(cfg.impulseDipPolicy)) {
      return { blocksOpen: true, reason: 'impulse:busy', stamp: failStamp };
    }
    return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
  }
  singleFlightUntil.set(sfk, now + cfg.impulseSingleFlightMs);

  if (cfg.impulseMintCooldownSec > 0) {
    const next = mintCooldownUntil.get(mint) ?? 0;
    if (next > now) {
      const failStamp: ImpulseConfirmStamp = {
        verdict: 'fail',
        reason: 'impulse:mint_cooldown',
        dipPolicy: cfg.impulseDipPolicy,
        trigger: triggerCtx,
        timingsMs: { pg: pgMs, total: Date.now() - t0 },
      };
      if (cfg.impulseDipPolicy === 'shadow' || cfg.impulseDipPolicy === 'parallel_or') {
        return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
      }
      if (policyBlocksOnImpulseFail(cfg.impulseDipPolicy)) {
        return { blocksOpen: true, reason: 'impulse:mint_cooldown', stamp: failStamp };
      }
      return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
    }
  }

  pruneAttempts(now);
  if (rpcAttemptsMs.length >= cfg.impulseRpcMaxPerMin) {
    const failStamp: ImpulseConfirmStamp = {
      verdict: 'fail',
      reason: 'impulse:rate_limit',
      dipPolicy: cfg.impulseDipPolicy,
      trigger: triggerCtx,
      timingsMs: { pg: pgMs, total: Date.now() - t0 },
    };
    if (cfg.impulseDipPolicy === 'shadow' || cfg.impulseDipPolicy === 'parallel_or') {
      return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
    }
    if (policyBlocksOnImpulseFail(cfg.impulseDipPolicy)) {
      return { blocksOpen: true, reason: 'impulse:rate_limit', stamp: failStamp };
    }
    return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
  }
  rpcAttemptsMs.push(now);

  const cost = cfg.impulseQnCreditsPerCall;
  if (!canSpendImpulseQnCredits(cost, cfg.strategyId, now)) {
    const sum = impulseQnRollingSum(now);
    const failStamp: ImpulseConfirmStamp = {
      verdict: 'fail',
      reason: 'impulse:budget_exceeded',
      dipPolicy: cfg.impulseDipPolicy,
      trigger: triggerCtx,
      timingsMs: { pg: pgMs, total: Date.now() - t0 },
      corridor: {
        anchorUsd: anchor,
        maxUpPct: cfg.impulseMaxUpPctFromAnchor,
        maxDownPct: cfg.impulseMaxDownPctFromAnchor,
        maxDisagreePct: cfg.impulseMaxDisagreePct,
      },
    };
    log.warn(
      { mint, sum, limit: impulseRollingMaxCredits() },
      'impulse QN rolling budget would exceed; skip rpc',
    );
    if (cfg.impulseDipPolicy === 'shadow' || cfg.impulseDipPolicy === 'parallel_or') {
      return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
    }
    if (policyBlocksOnImpulseFail(cfg.impulseDipPolicy)) {
      return { blocksOpen: true, reason: 'impulse:budget_exceeded', stamp: failStamp };
    }
    return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
  }

  let onchainUsd: number | null = null;
  let onchainPath: ImpulseConfirmStamp['onchainPath'] = 'none';
  let qnCredits = 0;
  const tRpc0 = Date.now();
  let rpcMs = 0;

  if (source === 'orca' && baseDecimals != null) {
    const res = await callAccountInfoWithRetry(pair, cost, cfg.strategyId, cfg);
    rpcMs = Date.now() - tRpc0;
    qnCredits = res.chargedCredits;
    if (res.account) {
      const acc = res.account;
      const owner = acc.owner ?? '';
      if (owner === WHIRLPOOL_PROGRAM_ID.toBase58()) {
        const data = acc.data;
        const b64 = Array.isArray(data) && typeof data[0] === 'string' ? data[0] : null;
        if (b64) {
          const dec = decodeWhirlpoolSpotUsd(b64, mint, baseDecimals, solUsd);
          if (dec.ok) {
            onchainUsd = dec.spotUsdPerBase;
            onchainPath = 'orca_qn';
          } else {
            log.debug({ mint, reason: dec.reason }, 'impulse whirlpool decode failed');
          }
        }
      } else {
        log.debug({ mint, owner }, 'impulse orca pair owner mismatch');
      }
    } else {
      log.debug({ mint }, 'impulse getAccountInfo empty account');
    }
  } else if (!cfg.impulseAllowJupiterOnlyUnsupported) {
    const failStamp: ImpulseConfirmStamp = {
      verdict: 'fail',
      reason: 'impulse:pool_layout_unsupported',
      dipPolicy: cfg.impulseDipPolicy,
      trigger: triggerCtx,
      onchainPath: 'none',
      timingsMs: { pg: pgMs, rpc: rpcMs, total: Date.now() - t0 },
    };
    if (cfg.impulseDipPolicy === 'shadow' || cfg.impulseDipPolicy === 'parallel_or') {
      return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
    }
    if (policyBlocksOnImpulseFail(cfg.impulseDipPolicy)) {
      return { blocksOpen: true, reason: 'impulse:pool_layout_unsupported', stamp: failStamp };
    }
    return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
  }

  const tJup = Date.now();
  const dec = baseDecimals ?? 6;
  let jup: PriceVerifyVerdict = await jupiterQuoteBuyPriceUsd({
    mint,
    outMintDecimals: dec,
    sizeUsd: cfg.positionUsd,
    solUsd,
    snapshotPriceUsd: anchorPriceUsd,
    slippageBps: cfg.priceVerifyMaxSlipBps,
    timeoutMs: cfg.impulseJupiterTimeoutMs,
  });
  const jupMs = Date.now() - tJup;
  jupiterReuse.set(mint, { ts: Date.now(), verdict: jup });

  if (cfg.impulseRequireJupiter && jup.kind !== 'ok' && !(cfg.impulseAllowOnchainOnly && onchainUsd != null)) {
    const failStamp: ImpulseConfirmStamp = {
      verdict: 'fail',
      reason: 'impulse:jupiter_required_failed',
      dipPolicy: cfg.impulseDipPolicy,
      trigger: triggerCtx,
      onchainUsd,
      onchainPath,
      jupiter: jup,
      qnCredits,
      timingsMs: { pg: pgMs, rpc: rpcMs, jupiter: jupMs, total: Date.now() - t0 },
    };
    if (cfg.impulseDipPolicy === 'shadow' || cfg.impulseDipPolicy === 'parallel_or') {
      return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
    }
    if (policyBlocksOnImpulseFail(cfg.impulseDipPolicy)) {
      return { blocksOpen: true, reason: 'impulse:jupiter_required_failed', stamp: failStamp };
    }
    return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
  }

  const jupiterUsd = jup.kind === 'ok' ? jup.jupiterPriceUsd : null;

  const corridorMeta = {
    anchorUsd: anchor,
    maxUpPct: cfg.impulseMaxUpPctFromAnchor,
    maxDownPct: cfg.impulseMaxDownPctFromAnchor,
    maxDisagreePct: cfg.impulseMaxDisagreePct,
  };

  const checks: Array<{ label: 'onchain' | 'jupiter'; spot: number }> = [];
  if (onchainUsd != null && Number.isFinite(onchainUsd)) checks.push({ label: 'onchain', spot: onchainUsd });
  if (jupiterUsd != null && jupiterUsd > 0) checks.push({ label: 'jupiter', spot: jupiterUsd });

  if (checks.length === 0) {
    const failStamp: ImpulseConfirmStamp = {
      verdict: 'fail',
      reason: 'impulse:jupiter_required_failed',
      dipPolicy: cfg.impulseDipPolicy,
      trigger: triggerCtx,
      onchainUsd,
      onchainPath,
      jupiter: jup,
      corridor: corridorMeta,
      qnCredits,
      timingsMs: { pg: pgMs, rpc: rpcMs, jupiter: jupMs, total: Date.now() - t0 },
    };
    if (cfg.impulseDipPolicy === 'shadow' || cfg.impulseDipPolicy === 'parallel_or') {
      return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
    }
    if (policyBlocksOnImpulseFail(cfg.impulseDipPolicy)) {
      return { blocksOpen: true, reason: 'impulse:jupiter_required_failed', stamp: failStamp };
    }
    return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
  }

  for (const c of checks) {
    const d = corridorDeltaPct(anchor, c.spot);
    if (!Number.isFinite(d) || d > cfg.impulseMaxUpPctFromAnchor || d < -cfg.impulseMaxDownPctFromAnchor) {
      const failStamp: ImpulseConfirmStamp = {
        verdict: 'fail',
        reason: 'impulse:corridor_fail',
        dipPolicy: cfg.impulseDipPolicy,
        trigger: triggerCtx,
        onchainUsd,
        onchainPath,
        jupiter: jup,
        corridor: {
          ...corridorMeta,
          deltaOnchainPct: onchainUsd != null ? corridorDeltaPct(anchor, onchainUsd) : undefined,
          deltaJupiterPct: jupiterUsd != null ? corridorDeltaPct(anchor, jupiterUsd) : undefined,
        },
        qnCredits,
        timingsMs: { pg: pgMs, rpc: rpcMs, jupiter: jupMs, total: Date.now() - t0 },
      };
      if (cfg.impulseDipPolicy === 'shadow' || cfg.impulseDipPolicy === 'parallel_or') {
        return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
      }
      if (policyBlocksOnImpulseFail(cfg.impulseDipPolicy)) {
        return { blocksOpen: true, reason: 'impulse:corridor_fail', stamp: failStamp };
      }
      return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
    }
  }

  if (
    onchainUsd != null &&
    jupiterUsd != null &&
    onchainUsd > 0 &&
    jupiterUsd > 0 &&
    disagreePct(onchainUsd, jupiterUsd) > cfg.impulseMaxDisagreePct
  ) {
    const dg = disagreePct(onchainUsd, jupiterUsd);
    const failStamp: ImpulseConfirmStamp = {
      verdict: 'fail',
      reason: 'impulse:corridor_fail',
      dipPolicy: cfg.impulseDipPolicy,
      trigger: triggerCtx,
      onchainUsd,
      onchainPath,
      jupiter: jup,
      corridor: {
        ...corridorMeta,
        deltaOnchainPct: corridorDeltaPct(anchor, onchainUsd),
        deltaJupiterPct: corridorDeltaPct(anchor, jupiterUsd),
        disagreePct: +dg.toFixed(4),
      },
      qnCredits,
      timingsMs: { pg: pgMs, rpc: rpcMs, jupiter: jupMs, total: Date.now() - t0 },
    };
    if (cfg.impulseDipPolicy === 'shadow' || cfg.impulseDipPolicy === 'parallel_or') {
      return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
    }
    if (policyBlocksOnImpulseFail(cfg.impulseDipPolicy)) {
      return { blocksOpen: true, reason: 'impulse:corridor_fail', stamp: failStamp };
    }
    return { blocksOpen: false, stamp: { ...failStamp, verdict: 'skipped' }, jupiterVerdictForReuse: null };
  }

  if (cfg.impulseMintCooldownSec > 0) {
    mintCooldownUntil.set(mint, Date.now() + cfg.impulseMintCooldownSec * 1000);
  }

  const passStamp: ImpulseConfirmStamp = {
    verdict: 'pass',
    dipPolicy: cfg.impulseDipPolicy,
    trigger: triggerCtx,
    onchainUsd,
    onchainPath,
    jupiter: jup,
    corridor: {
      ...corridorMeta,
      deltaOnchainPct: onchainUsd != null ? corridorDeltaPct(anchor, onchainUsd) : undefined,
      deltaJupiterPct: jupiterUsd != null ? corridorDeltaPct(anchor, jupiterUsd) : undefined,
    },
    qnCredits,
    timingsMs: { pg: pgMs, rpc: rpcMs, jupiter: jupMs, total: Date.now() - t0 },
  };

  log.info({ mint, deltaPgPct: triggerCtx.delta_pg_pct, onchainPath, qnCredits }, 'impulse confirm pass');

  return {
    blocksOpen: false,
    stamp: passStamp,
    jupiterVerdictForReuse: jup.kind === 'ok' ? jup : null,
  };
}

type RpcAcctInfo = {
  owner?: string;
  data?: [string, string] | unknown;
};

async function callAccountInfoWithRetry(
  pubkey: string,
  credits: number,
  strategyId: string,
  cfg: PaperTraderConfig,
): Promise<{ account: RpcAcctInfo | null; chargedCredits: number }> {
  const retries = Math.max(0, Math.min(3, cfg.impulseRpcRetryCount));
  let chargedCredits = 0;
  for (let i = 0; i <= retries; i++) {
    if (i > 0) {
      const jitter = 80 + Math.floor(Math.random() * 220);
      await new Promise((r) => setTimeout(r, cfg.impulseRpcRetryBackoffMs + jitter));
    }
    const r = await qnCall<{ context?: unknown; value: RpcAcctInfo | null }>(
      'getAccountInfo',
      [pubkey, { encoding: 'base64', commitment: 'processed' }],
      {
        feature: 'impulse_confirm',
        creditsPerCall: credits,
        timeoutMs: cfg.impulseRpcTimeoutMs,
      },
    );
    if (r.ok && r.value) {
      chargedCredits = credits;
      await recordImpulseQnCredits(credits, strategyId);
      return { account: r.value.value ?? null, chargedCredits };
    }
    if (!r.ok && (r.reason === 'budget' || r.reason === 'rate')) break;
  }
  return { account: null, chargedCredits };
}
