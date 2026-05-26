/**
 * Signal lab — фоновые снимки перед live `buy_open` в отдельный JSONL.
 * Не await-ится на горячем пути; не влияет на гейты и PnL.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { z } from 'zod';
import type { LiveOscarConfig } from './config.js';
import { liveFetchBuyQuote } from './jupiter.js';
import { tokenUsdFromBuyQuoteFitDecimals } from './phase5-gates.js';
import { solanaRpcMeterCounters } from '../core/rpc/solana-rpc-meter.js';
import { getSolUsd } from '../papertrader/pricing.js';
import type { PaperTraderConfig } from '../papertrader/config.js';
import type { EvalDecision } from '../papertrader/discovery/dip-clones.js';
import type { OpenTrade, PriceVerifyVerdict } from '../papertrader/types.js';

const log = pino({ name: 'signal-lab' });

let storePath = '';
let strategyId = 'live-oscar';

export function configureSignalLabStore(opts: { storePath: string; strategyId: string }): void {
  storePath = opts.storePath.trim();
  strategyId = opts.strategyId.trim() || 'live-oscar';
}

const SignalLabEnvelopeSchema = z.object({
  ts: z.number(),
  strategyId: z.string(),
  channel: z.literal('signal_lab'),
  correlationId: z.string(),
  kind: z.literal('signal_lab_eval'),
  phase: z.literal('pre_buy_open'),
  payload: z.record(z.string(), z.unknown()),
});

function signalLabFeaturesSubset(features: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'liq_usd',
    'vol5m_usd',
    'vol1h_usd',
    'pair_address',
    'token_age_min',
    'price_usd',
    'market_cap_usd',
    'holders',
    'buys5m',
    'sells5m',
  ] as const;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in features && features[k] !== undefined) out[k] = features[k];
  }
  return out;
}

function serializePriceVerify(pv: PriceVerifyVerdict | null): Record<string, unknown> | null {
  if (!pv) return null;
  if (pv.kind === 'ok' || pv.kind === 'blocked') {
    return {
      kind: pv.kind,
      snapshotPriceUsd: pv.snapshotPriceUsd,
      jupiterPriceUsd: pv.jupiterPriceUsd,
      slipPct: pv.slipPct,
      priceImpactPct: pv.priceImpactPct,
      routeHops: pv.routeHops,
      ageMs: pv.ageMs,
    };
  }
  return { kind: pv.kind, reason: pv.reason, ts: pv.ts };
}

export function signalLabShouldSample(samplePct: number): boolean {
  if (!(samplePct > 0)) return false;
  if (samplePct >= 100) return true;
  return Math.random() * 100 < samplePct;
}

async function appendSignalLabLine(record: unknown): Promise<void> {
  if (!storePath) return;
  const parsed = SignalLabEnvelopeSchema.safeParse(record);
  if (!parsed.success) {
    log.warn({ err: parsed.error.flatten() }, 'signal-lab envelope validation failed');
    return;
  }
  const dir = path.dirname(storePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(storePath, `${JSON.stringify(parsed.data)}\n`, 'utf8');
}

async function runSignalLabPreBuyOpenSnapshot(args: {
  liveCfg: LiveOscarConfig;
  paperCfg: PaperTraderConfig;
  ot: OpenTrade;
  decision: Pick<EvalDecision, 'lane' | 'source' | 'mint' | 'symbol' | 'features'>;
  snapshotEntryPriceUsd: number;
  tokenDecimals: number | null;
  priceVerify: PriceVerifyVerdict | null;
}): Promise<void> {
  const { liveCfg, paperCfg, ot, decision, snapshotEntryPriceUsd, tokenDecimals, priceVerify } = args;
  const correlationId = randomUUID();
  const ts = Date.now();
  const rpcBefore = solanaRpcMeterCounters();

  const probeUsd = Math.max(
    5,
    Math.min(45, paperCfg.positionUsd * paperCfg.entryFirstLegFraction * 0.12),
  );
  const solUsd = getSolUsd() ?? 0;
  const hintDec = tokenDecimals ?? 6;
  const anchorPx =
    ot.avgEntryMarket > 0
      ? ot.avgEntryMarket
      : ot.avgEntry > 0
        ? ot.avgEntry
        : snapshotEntryPriceUsd > 0
          ? snapshotEntryPriceUsd
          : 0;

  const feat = decision.features as unknown as Record<string, unknown>;

  const payload: Record<string, unknown> = {
    correlationId,
    mint: ot.mint,
    symbol: ot.symbol,
    lane: decision.lane,
    source: decision.source,
    dex: ot.dex,
    snapshotPgPriceUsd: snapshotEntryPriceUsd,
    signalLabFeatures: signalLabFeaturesSubset(feat),
    tpRegime: ot.tpRegime ?? null,
    liveExitProfileMode: ot.liveExitProfileMode ?? null,
    probePrimaryUsd: probeUsd,
    priceVerify: serializePriceVerify(priceVerify),
  };

  let wallMsPrimary = 0;
  let jupiterPrimaryUsd: number | null = null;
  let decimalsUsedPrimary: number | null = null;
  let altProbe: Record<string, unknown> | null = null;
  let error: string | undefined;

  try {
    if (!(solUsd > 0)) {
      error = 'solUsd missing — Jupiter probe skipped';
    } else {
      const t0 = Date.now();
      const fq = await liveFetchBuyQuote({
        cfg: liveCfg,
        outputMint: ot.mint,
        sizeUsd: probeUsd,
        solUsd,
      });
      wallMsPrimary = Date.now() - t0;
      if (!fq) {
        error = 'jupiter quote null';
      } else {
        const fit = tokenUsdFromBuyQuoteFitDecimals(fq.quoteResponse, solUsd, hintDec, anchorPx);
        jupiterPrimaryUsd = fit?.px ?? null;
        decimalsUsedPrimary = fit?.decimalsUsed ?? null;
        if (!(jupiterPrimaryUsd != null && jupiterPrimaryUsd > 0)) {
          error = 'jupiter implied price null';
        }

        const frac = liveCfg.signalLabAltProbeFraction;
        if (frac > 0 && jupiterPrimaryUsd != null && jupiterPrimaryUsd > 0) {
          const altUsd = Math.max(1, Math.min(45, probeUsd * frac));
          const t1 = Date.now();
          const fq2 = await liveFetchBuyQuote({
            cfg: liveCfg,
            outputMint: ot.mint,
            sizeUsd: altUsd,
            solUsd,
          });
          const wallMsAlt = Date.now() - t1;
          if (!fq2) {
            altProbe = { probeUsd: altUsd, error: 'quote-null', wallMs: wallMsAlt };
          } else {
            const fit2 = tokenUsdFromBuyQuoteFitDecimals(fq2.quoteResponse, solUsd, hintDec, anchorPx);
            const j2 = fit2?.px ?? null;
            altProbe = {
              probeUsd: altUsd,
              jupiterUsdPerToken: j2,
              decimalsUsed: fit2?.decimalsUsed ?? null,
              wallMs: wallMsAlt,
              divergeFromPrimaryBps:
                j2 != null && jupiterPrimaryUsd > 0
                  ? Math.round(
                      (Math.abs(j2 - jupiterPrimaryUsd) / Math.max(jupiterPrimaryUsd, 1e-18)) * 10_000,
                    )
                  : null,
            };
          }
        }
      }
    }
  } catch (e) {
    error = (e as Error)?.message ?? String(e);
  }

  const rpcAfter = solanaRpcMeterCounters();
  const divergePgVsPrimaryBps =
    snapshotEntryPriceUsd > 0 && jupiterPrimaryUsd != null && jupiterPrimaryUsd > 0
      ? Math.round(
          (Math.abs(snapshotEntryPriceUsd - jupiterPrimaryUsd) / Math.max(jupiterPrimaryUsd, 1e-18)) *
            10_000,
        )
      : null;

  payload.jupiterPrimaryUsdPerToken = jupiterPrimaryUsd;
  payload.decimalsUsedPrimary = decimalsUsedPrimary;
  payload.wallMsPrimary = wallMsPrimary;
  payload.divergePgVsPrimaryBps = divergePgVsPrimaryBps;
  payload.altProbe = altProbe;
  payload.error = error;
  payload.rpcMeterDeltaMonthCredits = rpcAfter.monthCredits - rpcBefore.monthCredits;
  payload.rpcMeterHourCreditsAfter = rpcAfter.hourCredits;

  const envelope = {
    ts,
    strategyId,
    channel: 'signal_lab' as const,
    correlationId,
    kind: 'signal_lab_eval' as const,
    phase: 'pre_buy_open' as const,
    payload,
  };

  try {
    await appendSignalLabLine(envelope);
  } catch (e) {
    log.warn({ err: (e as Error)?.message, mint: ot.mint.slice(0, 8) }, 'signal-lab append failed');
  }
}

export function scheduleSignalLabPreBuyOpen(args: {
  liveCfg: LiveOscarConfig;
  paperCfg: PaperTraderConfig;
  ot: OpenTrade;
  decision: Pick<EvalDecision, 'lane' | 'source' | 'mint' | 'symbol' | 'features'>;
  snapshotEntryPriceUsd: number;
  tokenDecimals: number | null;
  priceVerify: PriceVerifyVerdict | null;
}): void {
  const { liveCfg } = args;
  if (!liveCfg.signalLabEnabled) return;
  if (liveCfg.executionMode !== 'live' && liveCfg.executionMode !== 'simulate') return;
  if (!signalLabShouldSample(liveCfg.signalLabSamplePct)) return;
  void runSignalLabPreBuyOpenSnapshot(args).catch((e) =>
    log.warn({ err: (e as Error)?.message }, 'signal-lab snapshot task failed'),
  );
}
