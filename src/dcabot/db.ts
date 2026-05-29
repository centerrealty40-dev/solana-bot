/**
 * dca_frontrun (paper) — persistence layer.
 * Tables are product-prefixed (dcabot_*) in the shared Postgres instance.
 * Timestamps are bound as epoch seconds + to_timestamp() because postgres.js cannot
 * serialize JS Date objects.
 */
import { sql as dsql } from 'drizzle-orm';
import { db, sql as pgSql } from '../core/db/client.js';

export type PositionState =
  | 'scoring' // signal ingested, computing legitimacy + waiting for cycle 1
  | 'armed' // scored, waiting for the entry condition (cycle 1 + est gain >= min)
  | 'managing' // entered, running avg-down / take-profit / pre-exit logic
  | 'closing' // partial early-cancel: half sold, waiting to dump the rest
  | 'closed'
  | 'skipped'; // never entered (e.g. gain below threshold)

export type DcabotPosition = {
  id: number;
  mint: string;
  symbol: string | null;
  operatorWallet: string;
  buyer: string;
  vault: string;
  source: string;
  openSig: string | null;
  plannedCycles: number;
  cycleUsd: number;
  cycleFreqSec: number;
  depositUsd: number;
  openTsMs: number;
  estGainPct: number | null;
  legitScore: number | null;
  state: PositionState;
  qtyToken: number;
  costUsd: number;
  avgEntryPrice: number;
  realizedUsd: number;
  maxCapitalUsd: number;
  ddStepsHit: number;
  tpStepsHit: number;
  exitFirstDone: boolean;
  pendingSellQty: number;
  pendingSellAtMs: number | null;
  closeReason: string | null;
};

let ready: 'unknown' | 'ok' | 'failed' = 'unknown';

export async function ensureDcabotTables(): Promise<void> {
  if (ready === 'ok' || ready === 'failed') return;
  try {
    await db.execute(
      dsql.raw(`
CREATE TABLE IF NOT EXISTS dcabot_positions (
  id                 BIGSERIAL PRIMARY KEY,
  mint               TEXT NOT NULL,
  symbol             TEXT,
  operator_wallet    TEXT NOT NULL,
  buyer              TEXT NOT NULL DEFAULT '',
  vault              TEXT NOT NULL DEFAULT '',
  source             TEXT NOT NULL,
  open_sig           TEXT,
  planned_cycles     INT NOT NULL DEFAULT 0,
  cycle_usd          DOUBLE PRECISION NOT NULL DEFAULT 0,
  cycle_freq_sec     INT NOT NULL DEFAULT 0,
  deposit_usd        DOUBLE PRECISION NOT NULL DEFAULT 0,
  open_ts            TIMESTAMPTZ,
  est_gain_pct       DOUBLE PRECISION,
  legit_score        DOUBLE PRECISION,
  state              TEXT NOT NULL DEFAULT 'scoring',
  qty_token          DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_usd           DOUBLE PRECISION NOT NULL DEFAULT 0,
  avg_entry_price    DOUBLE PRECISION NOT NULL DEFAULT 0,
  realized_usd       DOUBLE PRECISION NOT NULL DEFAULT 0,
  max_capital_usd    DOUBLE PRECISION NOT NULL DEFAULT 0,
  dd_steps_hit       INT NOT NULL DEFAULT 0,
  tp_steps_hit       INT NOT NULL DEFAULT 0,
  exit_first_done    BOOLEAN NOT NULL DEFAULT false,
  pending_sell_qty   DOUBLE PRECISION NOT NULL DEFAULT 0,
  pending_sell_at    TIMESTAMPTZ,
  close_reason       TEXT,
  entered_at         TIMESTAMPTZ,
  closed_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dcabot_positions_key
  ON dcabot_positions (vault, mint);
CREATE INDEX IF NOT EXISTS idx_dcabot_positions_state
  ON dcabot_positions (state, updated_at DESC);

CREATE TABLE IF NOT EXISTS dcabot_fills (
  id            BIGSERIAL PRIMARY KEY,
  position_id   BIGINT NOT NULL REFERENCES dcabot_positions(id),
  side          TEXT NOT NULL,
  reason        TEXT NOT NULL,
  price_usd     DOUBLE PRECISION NOT NULL,
  qty_token     DOUBLE PRECISION NOT NULL,
  usd           DOUBLE PRECISION NOT NULL,
  cycle_index   INT,
  realized_usd  DOUBLE PRECISION,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dcabot_fills_pos ON dcabot_fills (position_id, ts);

CREATE TABLE IF NOT EXISTS dcabot_equity (
  id                  BIGSERIAL PRIMARY KEY,
  ts                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  cash_usd            DOUBLE PRECISION NOT NULL,
  positions_value_usd DOUBLE PRECISION NOT NULL,
  equity_usd          DOUBLE PRECISION NOT NULL,
  realized_usd        DOUBLE PRECISION NOT NULL,
  unrealized_usd      DOUBLE PRECISION NOT NULL,
  open_positions      INT NOT NULL,
  max_capital_usd     DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dcabot_equity_ts ON dcabot_equity (ts DESC);

CREATE TABLE IF NOT EXISTS dcabot_token_score (
  mint            TEXT PRIMARY KEY,
  symbol          TEXT,
  score           DOUBLE PRECISION,
  mint_renounced  BOOLEAN,
  freeze_renounced BOOLEAN,
  lp_locked       BOOLEAN,
  top10_pct       DOUBLE PRECISION,
  liquidity_usd   DOUBLE PRECISION,
  age_min         DOUBLE PRECISION,
  flags           JSONB,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
`),
    );
    ready = 'ok';
    console.log('[dcabot] tables ready');
  } catch (e) {
    ready = 'failed';
    console.error('[dcabot] table init failed:', String(e).slice(0, 240));
    throw e;
  }
}

function rowToPosition(r: Record<string, unknown>): DcabotPosition {
  const openTs = r.open_ts ? new Date(String(r.open_ts)).getTime() : 0;
  const pendingAt = r.pending_sell_at ? new Date(String(r.pending_sell_at)).getTime() : null;
  return {
    id: Number(r.id),
    mint: String(r.mint),
    symbol: (r.symbol as string) ?? null,
    operatorWallet: String(r.operator_wallet),
    buyer: String(r.buyer ?? ''),
    vault: String(r.vault ?? ''),
    source: String(r.source),
    openSig: (r.open_sig as string) ?? null,
    plannedCycles: Number(r.planned_cycles || 0),
    cycleUsd: Number(r.cycle_usd || 0),
    cycleFreqSec: Number(r.cycle_freq_sec || 0),
    depositUsd: Number(r.deposit_usd || 0),
    openTsMs: openTs,
    estGainPct: r.est_gain_pct != null ? Number(r.est_gain_pct) : null,
    legitScore: r.legit_score != null ? Number(r.legit_score) : null,
    state: String(r.state) as PositionState,
    qtyToken: Number(r.qty_token || 0),
    costUsd: Number(r.cost_usd || 0),
    avgEntryPrice: Number(r.avg_entry_price || 0),
    realizedUsd: Number(r.realized_usd || 0),
    maxCapitalUsd: Number(r.max_capital_usd || 0),
    ddStepsHit: Number(r.dd_steps_hit || 0),
    tpStepsHit: Number(r.tp_steps_hit || 0),
    exitFirstDone: Boolean(r.exit_first_done),
    pendingSellQty: Number(r.pending_sell_qty || 0),
    pendingSellAtMs: pendingAt,
    closeReason: (r.close_reason as string) ?? null,
  };
}

export async function findPositionByKey(vault: string, mint: string): Promise<DcabotPosition | null> {
  const rows = await pgSql`SELECT * FROM dcabot_positions WHERE vault = ${vault} AND mint = ${mint} LIMIT 1`;
  return rows[0] ? rowToPosition(rows[0] as Record<string, unknown>) : null;
}

export async function listActivePositions(): Promise<DcabotPosition[]> {
  const rows = await pgSql`
    SELECT * FROM dcabot_positions
    WHERE state IN ('scoring','armed','managing','closing')
    ORDER BY created_at ASC
  `;
  return rows.map((r) => rowToPosition(r as Record<string, unknown>));
}

export async function insertPosition(input: {
  mint: string;
  symbol: string | null;
  operatorWallet: string;
  buyer: string;
  vault: string;
  source: string;
  openSig: string | null;
  plannedCycles: number;
  cycleUsd: number;
  cycleFreqSec: number;
  depositUsd: number;
  openTsMs: number;
}): Promise<DcabotPosition | null> {
  const openSec = Math.floor(input.openTsMs / 1000);
  const rows = await pgSql`
    INSERT INTO dcabot_positions (
      mint, symbol, operator_wallet, buyer, vault, source, open_sig,
      planned_cycles, cycle_usd, cycle_freq_sec, deposit_usd, open_ts, state
    ) VALUES (
      ${input.mint}, ${input.symbol}, ${input.operatorWallet}, ${input.buyer}, ${input.vault},
      ${input.source}, ${input.openSig}, ${input.plannedCycles}, ${input.cycleUsd},
      ${input.cycleFreqSec}, ${input.depositUsd}, to_timestamp(${openSec}), 'scoring'
    )
    ON CONFLICT (vault, mint) DO NOTHING
    RETURNING *
  `;
  return rows[0] ? rowToPosition(rows[0] as Record<string, unknown>) : null;
}

export async function savePosition(p: DcabotPosition): Promise<void> {
  const pendingAt = p.pendingSellAtMs != null ? Math.floor(p.pendingSellAtMs / 1000) : null;
  await pgSql`
    UPDATE dcabot_positions SET
      symbol = ${p.symbol},
      est_gain_pct = ${p.estGainPct},
      legit_score = ${p.legitScore},
      state = ${p.state},
      qty_token = ${p.qtyToken},
      cost_usd = ${p.costUsd},
      avg_entry_price = ${p.avgEntryPrice},
      realized_usd = ${p.realizedUsd},
      max_capital_usd = ${p.maxCapitalUsd},
      dd_steps_hit = ${p.ddStepsHit},
      tp_steps_hit = ${p.tpStepsHit},
      exit_first_done = ${p.exitFirstDone},
      pending_sell_qty = ${p.pendingSellQty},
      pending_sell_at = ${pendingAt != null ? pgSql`to_timestamp(${pendingAt})` : null},
      close_reason = ${p.closeReason},
      entered_at = CASE WHEN entered_at IS NULL AND ${p.state} <> 'scoring' AND ${p.state} <> 'armed'
                        THEN now() ELSE entered_at END,
      closed_at = CASE WHEN ${p.state} = 'closed' THEN now() ELSE closed_at END,
      updated_at = now()
    WHERE id = ${p.id}
  `;
}

export async function recordFill(input: {
  positionId: number;
  side: 'buy' | 'sell';
  reason: string;
  priceUsd: number;
  qtyToken: number;
  usd: number;
  cycleIndex?: number | null;
  realizedUsd?: number | null;
}): Promise<void> {
  await pgSql`
    INSERT INTO dcabot_fills (position_id, side, reason, price_usd, qty_token, usd, cycle_index, realized_usd)
    VALUES (${input.positionId}, ${input.side}, ${input.reason}, ${input.priceUsd}, ${input.qtyToken},
            ${input.usd}, ${input.cycleIndex ?? null}, ${input.realizedUsd ?? null})
  `;
}

export async function snapshotEquity(input: {
  cashUsd: number;
  positionsValueUsd: number;
  equityUsd: number;
  realizedUsd: number;
  unrealizedUsd: number;
  openPositions: number;
  maxCapitalUsd: number;
}): Promise<void> {
  await pgSql`
    INSERT INTO dcabot_equity (cash_usd, positions_value_usd, equity_usd, realized_usd, unrealized_usd, open_positions, max_capital_usd)
    VALUES (${input.cashUsd}, ${input.positionsValueUsd}, ${input.equityUsd}, ${input.realizedUsd},
            ${input.unrealizedUsd}, ${input.openPositions}, ${input.maxCapitalUsd})
  `;
}

export async function saveTokenScore(input: {
  mint: string;
  symbol: string | null;
  score: number | null;
  mintRenounced: boolean | null;
  freezeRenounced: boolean | null;
  lpLocked: boolean | null;
  top10Pct: number | null;
  liquidityUsd: number | null;
  ageMin: number | null;
  flags: unknown;
}): Promise<void> {
  await pgSql`
    INSERT INTO dcabot_token_score (mint, symbol, score, mint_renounced, freeze_renounced, lp_locked, top10_pct, liquidity_usd, age_min, flags)
    VALUES (${input.mint}, ${input.symbol}, ${input.score}, ${input.mintRenounced}, ${input.freezeRenounced},
            ${input.lpLocked}, ${input.top10Pct}, ${input.liquidityUsd}, ${input.ageMin},
            ${pgSql.json(input.flags as never)})
    ON CONFLICT (mint) DO UPDATE SET
      symbol = EXCLUDED.symbol, score = EXCLUDED.score, mint_renounced = EXCLUDED.mint_renounced,
      freeze_renounced = EXCLUDED.freeze_renounced, lp_locked = EXCLUDED.lp_locked,
      top10_pct = EXCLUDED.top10_pct, liquidity_usd = EXCLUDED.liquidity_usd, age_min = EXCLUDED.age_min,
      flags = EXCLUDED.flags, updated_at = now()
  `;
}

export { pgSql };
