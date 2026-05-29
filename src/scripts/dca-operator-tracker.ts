/**
 * PG-backed DCA operator honesty tracking for dca-telegram-watch.
 * Graceful fallback if DB unavailable (alerts still send).
 */
import { sql as dsql } from 'drizzle-orm';
import { db, sql as pgSql } from '../core/db/client.js';

export type DcaOperatorStats = {
  wallet: string;
  opensTotal: number;
  closesTotal: number;
  earlyCloseCount: number;
  avgCompletionPct: number | null;
  honestyScorePct: number | null;
};

export type DcaTrackOpenInput = {
  operatorWallet: string;
  mint: string;
  source: string;
  openSig: string;
  openTsMs: number;
  plannedCycles: number;
  plannedCycleUsd: number;
  plannedTotalUsd: number;
  cycleFreqSec?: number;
  orderId?: string;
  seriesKey?: string;
};

export type DcaTrackFillInput = {
  operatorWallet: string;
  mint?: string;
  orderId?: string;
  seriesKey?: string;
  fillUsd?: number;
  eventTsMs: number;
};

export type DcaTrackCloseInput = {
  operatorWallet: string;
  mint?: string;
  orderId?: string;
  seriesKey?: string;
  closeSig: string;
  eventTsMs: number;
};

let tablesReady: 'unknown' | 'ok' | 'failed' = 'unknown';

function trackingEnabled(): boolean {
  return process.env.DCA_WATCH_OPERATOR_TRACK_ENABLED !== '0';
}

function earlyCloseMaxRatio(): number {
  const n = Number(process.env.DCA_WATCH_OPERATOR_EARLY_CLOSE_MAX_RATIO ?? 0.25);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.25;
}

function minPlannedCyclesForEarly(): number {
  const n = Number(process.env.DCA_WATCH_OPERATOR_EARLY_MIN_PLANNED_CYCLES ?? 5);
  return Number.isFinite(n) && n >= 2 ? Math.floor(n) : 5;
}

export async function ensureDcaOperatorTables(): Promise<void> {
  if (!trackingEnabled()) {
    tablesReady = 'failed';
    return;
  }
  if (tablesReady === 'ok' || tablesReady === 'failed') return;
  try {
    await db.execute(
      dsql.raw(`
CREATE TABLE IF NOT EXISTS dca_operators (
  wallet                TEXT PRIMARY KEY,
  opens_total           INT NOT NULL DEFAULT 0,
  closes_total          INT NOT NULL DEFAULT 0,
  fills_total           BIGINT NOT NULL DEFAULT 0,
  planned_cycles_total  BIGINT NOT NULL DEFAULT 0,
  completed_cycles_total BIGINT NOT NULL DEFAULT 0,
  early_close_count     INT NOT NULL DEFAULT 0,
  honesty_score_pct     DOUBLE PRECISION,
  avg_completion_pct    DOUBLE PRECISION,
  first_seen_ts         TIMESTAMPTZ,
  last_event_ts         TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dca_operator_orders (
  id                    BIGSERIAL PRIMARY KEY,
  operator_wallet       TEXT NOT NULL,
  order_id              TEXT,
  series_key            TEXT,
  mint                  TEXT NOT NULL,
  source                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'open',
  planned_cycles        INT NOT NULL,
  planned_cycle_usd     DOUBLE PRECISION,
  planned_total_usd     DOUBLE PRECISION,
  cycle_freq_sec        INT,
  observed_fills        INT NOT NULL DEFAULT 0,
  observed_spend_usd    DOUBLE PRECISION NOT NULL DEFAULT 0,
  completion_ratio      DOUBLE PRECISION,
  early_close           BOOLEAN NOT NULL DEFAULT false,
  open_sig              TEXT NOT NULL,
  close_sig             TEXT,
  open_ts               TIMESTAMPTZ NOT NULL,
  close_ts              TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dca_operator_orders_order_id
  ON dca_operator_orders (order_id)
  WHERE order_id IS NOT NULL AND order_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_dca_operator_orders_series_key
  ON dca_operator_orders (series_key)
  WHERE series_key IS NOT NULL AND series_key <> '';
CREATE INDEX IF NOT EXISTS idx_dca_operator_orders_wallet_open
  ON dca_operator_orders (operator_wallet, open_ts DESC);
CREATE INDEX IF NOT EXISTS idx_dca_operator_orders_mint_status
  ON dca_operator_orders (mint, status, open_ts DESC);
CREATE INDEX IF NOT EXISTS idx_dca_operators_honesty
  ON dca_operators (honesty_score_pct DESC NULLS LAST);
`),
    );
    tablesReady = 'ok';
    console.log('[dca-watch] operator track tables ready');
  } catch (e) {
    tablesReady = 'failed';
    console.warn('[dca-watch] operator track tables failed (graceful):', String(e).slice(0, 240));
  }
}

async function recomputeOperatorStats(wallet: string): Promise<void> {
  if (tablesReady !== 'ok') return;
  const rows = await pgSql<
    {
      cnt: number;
      avg_completion: number | null;
      early_cnt: number;
    }[]
  >`
    SELECT
      COUNT(*)::int AS cnt,
      AVG(completion_ratio) AS avg_completion,
      COUNT(*) FILTER (WHERE early_close)::int AS early_cnt
    FROM dca_operator_orders
    WHERE operator_wallet = ${wallet} AND status IN ('closed', 'complete')
  `;
  const closed = rows[0];
  const avgCompletion = closed?.avg_completion != null ? Number(closed.avg_completion) : null;
  const earlyCnt = Number(closed?.early_cnt || 0);
  const closeCnt = Number(closed?.cnt || 0);
  const opens = await pgSql<{ opens_total: number }[]>`
    SELECT opens_total FROM dca_operators WHERE wallet = ${wallet}
  `;
  const opensTotal = Number(opens[0]?.opens_total || 0);
  const avgPct = avgCompletion != null ? avgCompletion * 100 : null;
  const earlyRate = opensTotal > 0 ? earlyCnt / opensTotal : 0;
  const honesty =
    avgPct != null ? Math.max(0, Math.min(100, avgPct * (1 - 0.5 * earlyRate))) : null;

  await pgSql`
    UPDATE dca_operators SET
      closes_total = ${closeCnt},
      early_close_count = ${earlyCnt},
      avg_completion_pct = ${avgPct},
      honesty_score_pct = ${honesty},
      updated_at = now()
    WHERE wallet = ${wallet}
  `;
}

async function touchOperator(wallet: string, tsMs: number, opensDelta = 0, fillsDelta = 0, plannedCyclesDelta = 0): Promise<void> {
  if (tablesReady !== 'ok') return;
  const ts = new Date(tsMs);
  await pgSql`
    INSERT INTO dca_operators (wallet, opens_total, fills_total, planned_cycles_total, first_seen_ts, last_event_ts)
    VALUES (${wallet}, ${opensDelta}, ${fillsDelta}, ${plannedCyclesDelta}, ${ts}, ${ts})
    ON CONFLICT (wallet) DO UPDATE SET
      opens_total = dca_operators.opens_total + ${opensDelta},
      fills_total = dca_operators.fills_total + ${fillsDelta},
      planned_cycles_total = dca_operators.planned_cycles_total + ${plannedCyclesDelta},
      first_seen_ts = COALESCE(dca_operators.first_seen_ts, ${ts}),
      last_event_ts = GREATEST(COALESCE(dca_operators.last_event_ts, ${ts}), ${ts}),
      updated_at = now()
  `;
}

export async function recordDcaOpen(input: DcaTrackOpenInput): Promise<void> {
  if (!trackingEnabled() || tablesReady !== 'ok') return;
  const orderId = input.orderId?.trim() || null;
  const seriesKey = input.seriesKey?.trim() || null;
  const openTs = new Date(input.openTsMs);
  const planned = Math.max(1, Math.floor(input.plannedCycles || 1));

  try {
    if (orderId) {
      const existing = await pgSql<{ id: number }[]>`
        SELECT id FROM dca_operator_orders WHERE order_id = ${orderId} LIMIT 1
      `;
      if (existing.length > 0) return;
    } else if (seriesKey) {
      const existing = await pgSql<{ id: number; status: string }[]>`
        SELECT id, status FROM dca_operator_orders WHERE series_key = ${seriesKey} LIMIT 1
      `;
      if (existing[0]?.status === 'open') {
        await pgSql`
          UPDATE dca_operator_orders SET
            planned_cycles = GREATEST(planned_cycles, ${planned}),
            planned_total_usd = GREATEST(COALESCE(planned_total_usd, 0), ${input.plannedTotalUsd}),
            updated_at = now()
          WHERE id = ${existing[0].id}
        `;
        return;
      }
      if (existing.length > 0) return;
    }

    await pgSql`
      INSERT INTO dca_operator_orders (
        operator_wallet, order_id, series_key, mint, source, status,
        planned_cycles, planned_cycle_usd, planned_total_usd, cycle_freq_sec,
        open_sig, open_ts
      ) VALUES (
        ${input.operatorWallet}, ${orderId}, ${seriesKey}, ${input.mint}, ${input.source}, 'open',
        ${planned}, ${input.plannedCycleUsd}, ${input.plannedTotalUsd}, ${input.cycleFreqSec ?? null},
        ${input.openSig}, ${openTs}
      )
    `;
    await touchOperator(input.operatorWallet, input.openTsMs, 1, 0, planned);
  } catch (e) {
    console.warn('[dca-watch] recordDcaOpen failed:', String(e).slice(0, 200));
  }
}

async function findOpenOrder(input: { operatorWallet: string; mint?: string; orderId?: string; seriesKey?: string }) {
  const orderId = input.orderId?.trim();
  const seriesKey = input.seriesKey?.trim();
  if (orderId) {
    const rows = await pgSql<
      {
        id: number;
        planned_cycles: number;
        observed_fills: number;
      }[]
    >`
      SELECT id, planned_cycles, observed_fills
      FROM dca_operator_orders
      WHERE order_id = ${orderId} AND status = 'open'
      LIMIT 1
    `;
    if (rows[0]) return rows[0];
  }
  if (seriesKey) {
    const rows = await pgSql<
      {
        id: number;
        planned_cycles: number;
        observed_fills: number;
      }[]
    >`
      SELECT id, planned_cycles, observed_fills
      FROM dca_operator_orders
      WHERE series_key = ${seriesKey} AND status = 'open'
      LIMIT 1
    `;
    if (rows[0]) return rows[0];
  }
  if (input.mint) {
    const rows = await pgSql<
      {
        id: number;
        planned_cycles: number;
        observed_fills: number;
      }[]
    >`
      SELECT id, planned_cycles, observed_fills
      FROM dca_operator_orders
      WHERE operator_wallet = ${input.operatorWallet}
        AND mint = ${input.mint}
        AND status = 'open'
      ORDER BY open_ts DESC
      LIMIT 1
    `;
    if (rows[0]) return rows[0];
  }
  return null;
}

export async function recordDcaFill(input: DcaTrackFillInput): Promise<void> {
  if (!trackingEnabled() || tablesReady !== 'ok') return;
  try {
    const order = await findOpenOrder(input);
    if (!order) return;
    const fillUsd = Number(input.fillUsd || 0);
    await pgSql`
      UPDATE dca_operator_orders SET
        observed_fills = observed_fills + 1,
        observed_spend_usd = observed_spend_usd + ${fillUsd},
        updated_at = now()
      WHERE id = ${order.id}
    `;
    await touchOperator(input.operatorWallet, input.eventTsMs, 0, 1, 0);
  } catch (e) {
    console.warn('[dca-watch] recordDcaFill failed:', String(e).slice(0, 200));
  }
}

export async function recordDcaClose(input: DcaTrackCloseInput): Promise<void> {
  if (!trackingEnabled() || tablesReady !== 'ok') return;
  try {
    const order = await findOpenOrder(input);
    if (!order) return;
    const planned = Math.max(1, Number(order.planned_cycles || 1));
    const fills = Math.max(Number(order.observed_fills || 0), 0);
    const ratio = Math.min(1, fills / planned);
    const early =
      planned >= minPlannedCyclesForEarly() && ratio < earlyCloseMaxRatio();
    const status = ratio >= 0.95 ? 'complete' : 'closed';
    const closeTs = new Date(input.eventTsMs);

    await pgSql`
      UPDATE dca_operator_orders SET
        status = ${status},
        completion_ratio = ${ratio},
        early_close = ${early},
        close_sig = ${input.closeSig},
        close_ts = ${closeTs},
        updated_at = now()
      WHERE id = ${order.id}
    `;

    await pgSql`
      UPDATE dca_operators SET
        completed_cycles_total = completed_cycles_total + ${fills},
        last_event_ts = GREATEST(COALESCE(last_event_ts, ${closeTs}), ${closeTs}),
        updated_at = now()
      WHERE wallet = ${input.operatorWallet}
    `;
    await recomputeOperatorStats(input.operatorWallet);
  } catch (e) {
    console.warn('[dca-watch] recordDcaClose failed:', String(e).slice(0, 200));
  }
}

export async function fetchDcaOperatorStats(wallet: string): Promise<DcaOperatorStats | null> {
  if (!trackingEnabled() || tablesReady !== 'ok') return null;
  try {
    const rows = await pgSql<
      {
        wallet: string;
        opens_total: number;
        closes_total: number;
        early_close_count: number;
        avg_completion_pct: number | null;
        honesty_score_pct: number | null;
      }[]
    >`
      SELECT wallet, opens_total, closes_total, early_close_count, avg_completion_pct, honesty_score_pct
      FROM dca_operators
      WHERE wallet = ${wallet}
    `;
    const r = rows[0];
    if (!r || Number(r.opens_total) <= 0) return null;
    return {
      wallet: r.wallet,
      opensTotal: Number(r.opens_total),
      closesTotal: Number(r.closes_total),
      earlyCloseCount: Number(r.early_close_count),
      avgCompletionPct: r.avg_completion_pct != null ? Number(r.avg_completion_pct) : null,
      honestyScorePct: r.honesty_score_pct != null ? Number(r.honesty_score_pct) : null,
    };
  } catch {
    return null;
  }
}

export function formatOperatorTrustLine(stats: DcaOperatorStats | null): string | null {
  if (!stats || stats.opensTotal <= 0) return null;
  const score = stats.honestyScorePct ?? stats.avgCompletionPct;
  const earlyRate = stats.opensTotal > 0 ? Math.round((stats.earlyCloseCount / stats.opensTotal) * 100) : 0;
  const emoji = score == null ? '⚪' : score >= 80 ? '🟢' : score >= 50 ? '🟡' : '🔴';
  const completionStr = score != null ? `${Math.round(score)}% avg completion` : 'completion n/a (no closes yet)';
  const opensWord = stats.opensTotal === 1 ? 'time' : 'times';
  return (
    `${emoji} User history: seen creating DCA ${stats.opensTotal} ${opensWord} · ` +
    `${stats.earlyCloseCount} early cancels (${earlyRate}%) · ${completionStr}`
  );
}
