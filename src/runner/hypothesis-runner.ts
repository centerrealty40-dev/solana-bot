import { sql as dsql } from 'drizzle-orm';
import cron from 'node-cron';
import { db, schema } from '../core/db/client.js';
import { config } from '../core/config.js';
import { child } from '../core/logger.js';
import type { Hypothesis } from '../hypotheses/base.js';
import { evaluate as riskEvaluate } from './risk-manager.js';
import { executePaperEntry, executePaperExit } from './paper-executor.js';
import { executeLiveEntry, executeLiveExit } from './live-executor.js';
import { buildMarketCtx, getCurrentPrice, loadAllScores } from './market-ctx.js';
import { loadOpenPositionViews } from './position-store.js';
import type { NormalizedSwap, WalletScore } from '../core/types.js';

const log = child('hypothesis-runner');

/**
 * The runner orchestrates: scoring snapshot -> swap event loop -> exit polling.
 *
 * Two main loops:
 *   - Swap polling: every 5 seconds, query the swaps table for new rows since last
 *     watermark and dispatch each to all registered hypotheses' `onSwap`. The runner
 *     applies risk gates and executes via paper/live executor.
 *
 *   - Exit polling: every 10 seconds, for every open position, build MarketCtx and
 *     ask the owning hypothesis whether to exit.
 *
 * The runner is driven by *the swaps table* (which is updated by the webhook receiver
 * out-of-process) so we never lose events even if the runner restarts.
 */
export class HypothesisRunner {
  private hypotheses: Map<string, Hypothesis> = new Map();
  private lastSwapId = 0n;
  private scoresCache: Map<string, WalletScore> = new Map();
  private pollSwapHandle: NodeJS.Timeout | null = null;
  private pollExitHandle: NodeJS.Timeout | null = null;

  register(h: Hypothesis): void {
    if (this.hypotheses.has(h.id)) {
      throw new Error(`hypothesis already registered: ${h.id}`);
    }
    this.hypotheses.set(h.id, h);
    log.info({ id: h.id }, 'hypothesis registered');
  }

  async start(): Promise<void> {
    log.info({ mode: config.executorMode, count: this.hypotheses.size }, 'runner starting');
    for (const h of this.hypotheses.values()) {
      await h.init?.();
    }
    this.scoresCache = await loadAllScores();
    log.info({ scores: this.scoresCache.size }, 'wallet scores loaded');

    // initialize watermark to current max id so we don't dispatch backlog on first start
    const maxRow = await db.execute(dsql`SELECT COALESCE(MAX(id), 0) AS max_id FROM swaps`);
    const m = (maxRow as unknown as Array<{ max_id: bigint | string | null }>)[0]?.max_id;
    this.lastSwapId = BigInt(m ?? 0);
    log.info({ lastSwapId: String(this.lastSwapId) }, 'swap watermark set');

    // refresh scores cache hourly
    cron.schedule('11 * * * *', async () => {
      try {
        this.scoresCache = await loadAllScores();
        log.info({ scores: this.scoresCache.size }, 'scores cache refreshed');
      } catch (err) {
        log.error({ err: String(err) }, 'scores refresh failed');
      }
    });

    this.pollSwapHandle = setInterval(() => void this.pollSwaps(), 5000);
    this.pollExitHandle = setInterval(() => void this.pollExits(), 10_000);
  }

  stop(): void {
    if (this.pollSwapHandle) clearInterval(this.pollSwapHandle);
    if (this.pollExitHandle) clearInterval(this.pollExitHandle);
    this.pollSwapHandle = null;
    this.pollExitHandle = null;
  }

  private async pollSwaps(): Promise<void> {
    try {
      const rows = await db
        .select()
        .from(schema.swaps)
        .where(dsql`${schema.swaps.id} > ${this.lastSwapId}`)
        .orderBy(dsql`${schema.swaps.id} ASC`)
        .limit(500);
      if (rows.length === 0) return;
      this.lastSwapId = rows[rows.length - 1]!.id;
      for (const r of rows) {
        const swap: NormalizedSwap = {
          signature: r.signature,
          slot: Number(r.slot),
          blockTime: r.blockTime,
          wallet: r.wallet,
          baseMint: r.baseMint,
          quoteMint: r.quoteMint,
          side: r.side as 'buy' | 'sell',
          baseAmountRaw: r.baseAmountRaw,
          quoteAmountRaw: r.quoteAmountRaw,
          priceUsd: r.priceUsd,
          amountUsd: r.amountUsd,
          dex: r.dex as NormalizedSwap['dex'],
          source: r.source as NormalizedSwap['source'],
        };
        const ctx = await buildMarketCtx(swap.baseMint, this.scoresCache);
        for (const h of this.hypotheses.values()) {
          let signals;
          try {
            signals = h.onSwap(swap, ctx);
          } catch (err) {
            log.error({ id: h.id, err: String(err) }, 'hypothesis onSwap threw');
            continue;
          }
          if (!signals || signals.length === 0) continue;
          for (const sig of signals) {
            await this.handleSignal(sig, swap.priceUsd);
          }
        }
      }
    } catch (err) {
      log.error({ err: String(err) }, 'pollSwaps failed');
    }
  }

  private async handleSignal(sig: import('../hypotheses/base.js').HypothesisSignal, midPrice: number): Promise<void> {
    const decision = await riskEvaluate(sig);
    await db.insert(schema.signals).values({
      hypothesisId: sig.hypothesisId,
      ts: sig.ts,
      baseMint: sig.baseMint,
      side: sig.side,
      sizeUsd: sig.sizeUsd,
      reason: sig.reason,
      meta: sig.meta,
      accepted: decision.approved,
      rejectReason: decision.reason ?? null,
    });
    if (!decision.approved) {
      log.debug({ sig, reason: decision.reason }, 'signal rejected by risk');
      return;
    }
    if (sig.side !== 'buy') {
      // sell-side signals on tokens we don't hold are ignored at the entry stage;
      // exit decisions live in `shouldExit`.
      return;
    }
    if (config.executorMode === 'live') {
      await executeLiveEntry(sig, midPrice, decision.adjustedSizeUsd);
    } else {
      await executePaperEntry(sig, midPrice, decision.adjustedSizeUsd);
    }
  }

  private async pollExits(): Promise<void> {
    try {
      // Build a price snapshot for all open mints first
      const openMints = await db.execute(dsql`
        SELECT DISTINCT base_mint FROM positions WHERE status = 'open' AND mode = ${config.executorMode}
      `);
      const mints = (openMints as unknown as Array<{ base_mint: string }>).map((r) => r.base_mint);
      const priceMap = new Map<string, number>();
      for (const m of mints) {
        const p = await getCurrentPrice(m);
        if (p) priceMap.set(m, p);
      }
      for (const h of this.hypotheses.values()) {
        const positions = await loadOpenPositionViews(h.id, (m) => priceMap.get(m));
        for (const pos of positions) {
          const ctx = await buildMarketCtx(pos.baseMint, this.scoresCache);
          let exit;
          try {
            exit = h.shouldExit(pos, ctx);
          } catch (err) {
            log.error({ id: h.id, err: String(err) }, 'hypothesis shouldExit threw');
            continue;
          }
          if (!exit) continue;
          if (config.executorMode === 'live') {
            await executeLiveExit(pos, exit, pos.currentPriceUsd);
          } else {
            await executePaperExit(pos, exit, pos.currentPriceUsd);
          }
        }
      }
    } catch (err) {
      log.error({ err: String(err) }, 'pollExits failed');
    }
  }
}
