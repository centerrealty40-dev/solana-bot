/**
 * Live Oscar — Binance BTC context gate for **new** positions (`buy_open` only).
 */
import { getBtcContext } from '../papertrader/pricing.js';
import type { LiveOscarConfig } from './config.js';

export type LiveBtcGateBlockLimit = 'btc_dump_1h' | 'btc_dump_4h';

export type LiveBtcGateStatus =
  | { kind: 'disabled' }
  | { kind: 'stale' }
  | { kind: 'ok'; ret1h_pct: number | null; ret4h_pct: number | null }
  | {
      kind: 'blocked';
      limit: LiveBtcGateBlockLimit;
      ret1h_pct: number | null;
      ret4h_pct: number | null;
      blockAtDrawdownPct: number;
    };

export function resolveLiveBtcGateStatus(liveCfg: LiveOscarConfig): LiveBtcGateStatus {
  if (liveCfg.executionMode !== 'live' || !liveCfg.liveBtcGateEnabled) {
    return { kind: 'disabled' };
  }
  const btc = getBtcContext();
  const staleMs = liveCfg.liveBtcGateMaxStaleMs;
  const ts = btc.updated_ts;
  const fresh = typeof ts === 'number' && ts > 0 && Date.now() - ts <= staleMs;
  if (!fresh) return { kind: 'stale' };

  const d1 = liveCfg.liveBtcBlockNewBuys1hDrawdownPct;
  const d4 = liveCfg.liveBtcBlockNewBuys4hDrawdownPct;
  if (btc.ret1h_pct != null && btc.ret1h_pct <= -d1) {
    return {
      kind: 'blocked',
      limit: 'btc_dump_1h',
      ret1h_pct: btc.ret1h_pct,
      ret4h_pct: btc.ret4h_pct,
      blockAtDrawdownPct: d1,
    };
  }
  if (btc.ret4h_pct != null && btc.ret4h_pct <= -d4) {
    return {
      kind: 'blocked',
      limit: 'btc_dump_4h',
      ret1h_pct: btc.ret1h_pct,
      ret4h_pct: btc.ret4h_pct,
      blockAtDrawdownPct: d4,
    };
  }
  return { kind: 'ok', ret1h_pct: btc.ret1h_pct, ret4h_pct: btc.ret4h_pct };
}
