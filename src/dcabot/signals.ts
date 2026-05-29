/**
 * dca_frontrun — signal intake.
 * Reads qualified DCA opens that the watcher recorded into dca_operator_orders and creates
 * a paper position per new order. Read-only on the watcher's table.
 */
import { dcabotConfig as cfg } from './config.js';
import { pgSql, insertPosition } from './db.js';

type OrderRow = {
  operator_wallet: string;
  mint: string;
  source: string;
  planned_cycles: number;
  planned_cycle_usd: number | null;
  planned_total_usd: number | null;
  cycle_freq_sec: number | null;
  open_sig: string | null;
  series_key: string | null;
  open_ts_ms: number | null;
};

/** series_key is "<vault>|<mint>" (swapExecSeriesKey). */
function vaultFromSeriesKey(seriesKey: string | null, mint: string): string {
  if (!seriesKey) return '';
  const [vault, m] = seriesKey.split('|');
  if (m && m !== mint) return ''; // unexpected format
  return vault || '';
}

export async function ingestSignals(): Promise<number> {
  let rows: OrderRow[] = [];
  try {
    rows = (await pgSql`
      SELECT operator_wallet, mint, source, planned_cycles, planned_cycle_usd, planned_total_usd,
             cycle_freq_sec, open_sig, series_key,
             (EXTRACT(EPOCH FROM open_ts) * 1000)::bigint AS open_ts_ms
      FROM dca_operator_orders
      WHERE source = ${cfg.signalSource}
        AND status = 'open'
        AND open_ts > now() - (${cfg.signalLookbackMin} || ' minutes')::interval
      ORDER BY open_ts DESC
      LIMIT 200
    `) as unknown as OrderRow[];
  } catch (e) {
    console.warn('[dcabot] ingestSignals query failed', String(e).slice(0, 160));
    return 0;
  }

  let created = 0;
  for (const r of rows) {
    const vault = vaultFromSeriesKey(r.series_key, r.mint);
    if (!vault) continue;
    const pos = await insertPosition({
      mint: r.mint,
      symbol: null,
      operatorWallet: r.operator_wallet,
      buyer: r.operator_wallet,
      vault,
      source: r.source,
      openSig: r.open_sig,
      plannedCycles: Number(r.planned_cycles || 0),
      cycleUsd: Number(r.planned_cycle_usd || 0),
      cycleFreqSec: Number(r.cycle_freq_sec || 0),
      depositUsd: Number(r.planned_total_usd || 0),
      openTsMs: Number(r.open_ts_ms || Date.now()),
    });
    if (pos) {
      created += 1;
      console.log('[dcabot] new signal → position', { mint: pos.mint, vault, cycleUsd: pos.cycleUsd, planned: pos.plannedCycles });
    }
  }
  return created;
}
