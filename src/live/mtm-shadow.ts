/**
 * MTM shadow — фоновый второй Jupiter-probe на открытых позициях (трекер).
 * Не меняет curMetric, гейты, scale-in / выходы — только JSONL для последующего анализа.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { z } from 'zod';
import type { LiveOscarConfig } from './config.js';
import { liveFetchBuyQuote, liveQuoteSnapshotFromResponse } from './jupiter.js';
import { tokenUsdFromBuyQuoteFitDecimals } from './phase5-gates.js';
import { solanaRpcMeterCounters } from '../core/rpc/solana-rpc-meter.js';
import type { OpenTrade } from '../papertrader/types.js';

const log = pino({ name: 'mtm-shadow' });

let storePath = '';
let strategyId = 'live-oscar';

export function configureMtmShadowStore(opts: { storePath: string; strategyId: string }): void {
  storePath = opts.storePath.trim();
  strategyId = opts.strategyId.trim() || 'live-oscar';
}

const EnvelopeSchema = z.object({
  ts: z.number(),
  strategyId: z.string(),
  channel: z.literal('mtm_shadow'),
  correlationId: z.string(),
  kind: z.literal('mtm_shadow_probe'),
  phase: z.literal('open_tracker_tick'),
  payload: z.record(z.string(), z.unknown()),
});

function shadowSample(pct: number): boolean {
  if (!(pct > 0)) return false;
  if (pct >= 100) return true;
  return Math.random() * 100 < pct;
}

async function appendLine(record: unknown): Promise<void> {
  if (!storePath) return;
  const parsed = EnvelopeSchema.safeParse(record);
  if (!parsed.success) {
    log.warn({ err: parsed.error.flatten() }, 'mtm-shadow envelope validation failed');
    return;
  }
  const dir = path.dirname(storePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(storePath, `${JSON.stringify(parsed.data)}\n`, 'utf8');
}

/** Пороги только для полей в журнале (не для торговых решений). */
const WIDE_PRIMARY_ALT_BPS = 150;
const WIDE_PG_PRIMARY_BPS = 75;

export function scheduleMtmShadowTrackerProbe(args: {
  liveCfg: LiveOscarConfig;
  paperStrategyId: string;
  ot: OpenTrade;
  mint: string;
  snapshotPgUsd: number;
  probeUsdPrimary: number;
  solUsd: number;
  decimalsHint: number;
  anchorPx: number;
  primaryJupiterUsd: number;
  primaryQuoteResponse: Record<string, unknown>;
}): void {
  const { liveCfg } = args;
  if (!liveCfg.mtmShadowEnabled) return;
  if (liveCfg.executionMode !== 'live' && liveCfg.executionMode !== 'simulate') return;
  if (!(liveCfg.mtmShadowAltFraction > 0)) return;
  if (!shadowSample(liveCfg.mtmShadowSamplePct)) return;

  void runMtmShadowProbe(args).catch((e) =>
    log.warn({ err: (e as Error)?.message, mint: args.mint.slice(0, 8) }, 'mtm-shadow task failed'),
  );
}

async function runMtmShadowProbe(args: {
  liveCfg: LiveOscarConfig;
  paperStrategyId: string;
  ot: OpenTrade;
  mint: string;
  snapshotPgUsd: number;
  probeUsdPrimary: number;
  solUsd: number;
  decimalsHint: number;
  anchorPx: number;
  primaryJupiterUsd: number;
  primaryQuoteResponse: Record<string, unknown>;
}): Promise<void> {
  const {
    liveCfg,
    paperStrategyId,
    ot,
    mint,
    snapshotPgUsd,
    probeUsdPrimary,
    solUsd,
    decimalsHint,
    anchorPx,
    primaryJupiterUsd,
    primaryQuoteResponse,
  } = args;

  const correlationId = randomUUID();
  const ts = Date.now();
  const rpcBefore = solanaRpcMeterCounters();

  let altUsd = Math.max(5, Math.min(45, probeUsdPrimary * liveCfg.mtmShadowAltFraction));
  if (Math.abs(altUsd - probeUsdPrimary) < 0.75) {
    altUsd = Math.max(5, Math.min(45, probeUsdPrimary * 0.72));
    if (Math.abs(altUsd - probeUsdPrimary) < 0.5) {
      altUsd = Math.max(5, Math.min(45, probeUsdPrimary + 3));
    }
  }

  const primarySnap = liveQuoteSnapshotFromResponse(primaryQuoteResponse, {
    slippageBps: liveCfg.liveDefaultSlippageBps,
    quoteAgeMs: 0,
  });

  const divergePgVsPrimaryBps =
    snapshotPgUsd > 0 && primaryJupiterUsd > 0
      ? Math.round(
          (Math.abs(snapshotPgUsd - primaryJupiterUsd) / Math.max(primaryJupiterUsd, 1e-18)) * 10_000,
        )
      : null;

  let altJupiterUsd: number | null = null;
  let altSnap: Record<string, unknown> | null = null;
  let wallMsAlt = 0;
  let errorAlt: string | undefined;

  try {
    const t0 = Date.now();
    const fq2 = await liveFetchBuyQuote({
      cfg: liveCfg,
      outputMint: mint,
      sizeUsd: altUsd,
      solUsd,
    });
    wallMsAlt = Date.now() - t0;
    if (!fq2) {
      errorAlt = 'quote-null';
    } else {
      altSnap = liveQuoteSnapshotFromResponse(fq2.quoteResponse, {
        slippageBps: liveCfg.liveDefaultSlippageBps,
        quoteAgeMs: wallMsAlt,
      });
      const fit2 = tokenUsdFromBuyQuoteFitDecimals(
        fq2.quoteResponse,
        solUsd,
        decimalsHint,
        anchorPx,
      );
      altJupiterUsd = fit2?.px ?? null;
      if (!(altJupiterUsd != null && altJupiterUsd > 0)) {
        errorAlt = 'jupiter-price-null';
      }
    }
  } catch (e) {
    errorAlt = (e as Error)?.message ?? String(e);
  }

  const divergePrimaryVsAltBps =
    altJupiterUsd != null && altJupiterUsd > 0 && primaryJupiterUsd > 0
      ? Math.round(
          (Math.abs(primaryJupiterUsd - altJupiterUsd) / Math.max(primaryJupiterUsd, 1e-18)) * 10_000,
        )
      : null;

  const divergePgVsAltBps =
    snapshotPgUsd > 0 && altJupiterUsd != null && altJupiterUsd > 0
      ? Math.round(
          (Math.abs(snapshotPgUsd - altJupiterUsd) / Math.max(altJupiterUsd, 1e-18)) * 10_000,
        )
      : null;

  const shadowFlags: string[] = [];
  if (
    divergePrimaryVsAltBps != null &&
    divergePrimaryVsAltBps > WIDE_PRIMARY_ALT_BPS &&
    divergePgVsPrimaryBps != null &&
    divergePgVsPrimaryBps > WIDE_PG_PRIMARY_BPS
  ) {
    shadowFlags.push('primary_alt_wide_and_pg_primary_wide');
  } else {
    if (divergePrimaryVsAltBps != null && divergePrimaryVsAltBps > WIDE_PRIMARY_ALT_BPS) {
      shadowFlags.push('primary_vs_alt_wide');
    }
    if (divergePgVsPrimaryBps != null && divergePgVsPrimaryBps > WIDE_PG_PRIMARY_BPS) {
      shadowFlags.push('pg_vs_primary_wide');
    }
  }

  const priceDisagreement =
    shadowFlags.includes('primary_alt_wide_and_pg_primary_wide') ||
    (divergePrimaryVsAltBps != null &&
      divergePrimaryVsAltBps > WIDE_PRIMARY_ALT_BPS &&
      divergePgVsAltBps != null &&
      divergePgVsAltBps > WIDE_PG_PRIMARY_BPS);

  const rpcAfter = solanaRpcMeterCounters();

  const payload: Record<string, unknown> = {
    correlationId,
    paperStrategyId,
    mint,
    symbol: ot.symbol,
    lane: ot.lane,
    dex: ot.dex,
    snapshotPgUsd,
    probeUsdPrimary,
    probeUsdAlt: altUsd,
    anchorPx,
    decimalsHint,
    primaryJupiterUsd,
    altJupiterUsd,
    divergePgVsPrimaryBps,
    divergePrimaryVsAltBps,
    divergePgVsAltBps,
    primaryQuoteSnapshot: primarySnap,
    altQuoteSnapshot: altSnap,
    wallMsAlt,
    errorAlt,
    shadowFlags,
    priceDisagreement: !!priceDisagreement,
    rpcMeterDeltaMonthCredits: rpcAfter.monthCredits - rpcBefore.monthCredits,
  };

  const envelope = {
    ts,
    strategyId,
    channel: 'mtm_shadow' as const,
    correlationId,
    kind: 'mtm_shadow_probe' as const,
    phase: 'open_tracker_tick' as const,
    payload,
  };

  try {
    await appendLine(envelope);
  } catch (e) {
    log.warn({ err: (e as Error)?.message, mint: mint.slice(0, 8) }, 'mtm-shadow append failed');
  }
}
