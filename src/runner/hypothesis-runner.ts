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
import {
  notifyDailyReport,
  notifyHeartbeat,
  notifyStartup,
  type DailyHypothesisRow,
} from './telegram.js';
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
  /** Counters reset on each heartbeat; used for "last 6h" stats. */
  private heartbeat = {
    swapsProcessed: 0,
    signalsRaised: 0,
    positionsOpened: 0,
    windowStart: Date.now(),
  };

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

    // Heartbeat to Telegram every 6 hours
    cron.schedule('0 */6 * * *', () => void this.sendHeartbeat());

    // Daily report at 21:00 UTC (= 00:00 MSK / 23:00 CET / 17:00 EST)
    cron.schedule('0 21 * * *', () => void this.sendDailyReport());

    void notifyStartup(Array.from(this.hypotheses.keys()));
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      const windowMs = Date.now() - this.heartbeat.windowStart;
      const windowHours = Math.max(1, Math.round(windowMs / 3600_000));
      const sinceTs = new Date(this.heartbeat.windowStart);
      const closedRows = await db.execute(dsql`
        SELECT
          COUNT(*)::int AS closed,
          COALESCE(SUM(realized_pnl_usd), 0)::float AS pnl
        FROM positions
        WHERE mode = ${config.executorMode}
          AND status = 'closed'
          AND closed_at >= ${sinceTs}
      `);
      const closedRow = (closedRows as unknown as Array<{ closed: number; pnl: number }>)[0];
      const openRows = await db.execute(dsql`
        SELECT COUNT(*)::int AS n FROM positions
        WHERE mode = ${config.executorMode} AND status = 'open'
      `);
      const openCount = Number((openRows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
      await notifyHeartbeat({
        windowHours,
        swapsProcessed: this.heartbeat.swapsProcessed,
        signalsRaised: this.heartbeat.signalsRaised,
        positionsOpened: this.heartbeat.positionsOpened,
        positionsClosed: Number(closedRow?.closed ?? 0),
        openCount,
        realizedPnlWindow: Number(closedRow?.pnl ?? 0),
      });
      this.heartbeat = {
        swapsProcessed: 0,
        signalsRaised: 0,
        positionsOpened: 0,
        windowStart: Date.now(),
      };
    } catch (err) {
      log.warn({ err: String(err) }, 'heartbeat failed');
    }
  }

  private async sendDailyReport(): Promise<void> {
    try {
      const day = new Date().toISOString().slice(0, 10);
      const rows = await db.execute(dsql`
        SELECT
          hypothesis_id,
          COALESCE(SUM(trades_count), 0)::int AS trades,
          COALESCE(SUM(wins_count), 0)::int AS wins,
          COALESCE(SUM(realized_pnl_usd), 0)::float AS pnl
        FROM daily_pnl
        WHERE day = ${day} AND mode = ${config.executorMode}
        GROUP BY hypothesis_id
      `);
      const dataMap = new Map<string, { trades: number; wins: number; pnl: number }>();
      for (const r of rows as unknown as Array<{
        hypothesis_id: string;
        trades: number;
        wins: number;
        pnl: number;
      }>) {
        dataMap.set(r.hypothesis_id, { trades: r.trades, wins: r.wins, pnl: r.pnl });
      }
      const reportRows: DailyHypothesisRow[] = Array.from(this.hypotheses.keys()).map((id) => ({
        hypothesisId: id,
        trades: dataMap.get(id)?.trades ?? 0,
        wins: dataMap.get(id)?.wins ?? 0,
        realizedPnlUsd: dataMap.get(id)?.pnl ?? 0,
      }));
      const openRows = await db.execute(dsql`
        SELECT COUNT(*)::int AS n FROM positions
        WHERE mode = ${config.executorMode} AND status = 'open'
      `);
      const openCount = Number((openRows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
      await notifyDailyReport({ day, rows: reportRows, openPositionsCount: openCount });
    } catch (err) {
      log.warn({ err: String(err) }, 'daily report failed');
    }
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
      this.heartbeat.swapsProcessed += rows.length;
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
      log.error(
        {
          err: err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : String(err),
        },
        'pollSwaps failed',
      );
    }
  }

  private async handleSignal(sig: import('../hypotheses/base.js').HypothesisSignal, midPrice: number): Promise<void> {
    this.heartbeat.signalsRaised += 1;
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
    let positionId: bigint | null;
    if (config.executorMode === 'live') {
      positionId = await executeLiveEntry(sig, midPrice, decision.adjustedSizeUsd);
    } else {
      positionId = await executePaperEntry(sig, midPrice, decision.adjustedSizeUsd);
    }
    if (positionId) this.heartbeat.positionsOpened += 1;
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
