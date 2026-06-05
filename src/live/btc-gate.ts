/**
 * Live Oscar — Binance BTC context gate for **new** positions (`buy_open` only).
 */
import { getBtcContext } from '../papertrader/pricing.js';
import type { LiveOscarConfig } from './config.js';

export type LiveBtcGateBlockLimit =
  | 'btc_dump_1h'
  | 'btc_dump_4h'
  | 'btc_dump_24h'
  | 'btc_dump_72h'
  | 'btc_dump_peak_72h';

export type LiveBtcGateMetrics = {
  ret1h_pct: number | null;
  ret4h_pct: number | null;
  ret24h_pct: number | null;
  ret72h_pct: number | null;
  retPeak72hDrawdown_pct: number | null;
};

export type LiveBtcGateStatus =
  | { kind: 'disabled' }
  | { kind: 'stale' }
  | ({ kind: 'ok' } & LiveBtcGateMetrics)
  | ({
      kind: 'blocked';
      limit: LiveBtcGateBlockLimit;
      blockAtDrawdownPct: number;
    } & LiveBtcGateMetrics);

function btcMetricsFromContext(): LiveBtcGateMetrics {
  const btc = getBtcContext();
  return {
    ret1h_pct: btc.ret1h_pct,
    ret4h_pct: btc.ret4h_pct,
    ret24h_pct: btc.ret24h_pct,
    ret72h_pct: btc.ret72h_pct,
    retPeak72hDrawdown_pct: btc.retPeak72hDrawdown_pct,
  };
}

function blocked(
  limit: LiveBtcGateBlockLimit,
  blockAtDrawdownPct: number,
  metrics: LiveBtcGateMetrics,
): Extract<LiveBtcGateStatus, { kind: 'blocked' }> {
  return { kind: 'blocked', limit, blockAtDrawdownPct, ...metrics };
}

export function resolveLiveBtcGateStatus(liveCfg: LiveOscarConfig): LiveBtcGateStatus {
  if (liveCfg.executionMode !== 'live' || !liveCfg.liveBtcGateEnabled) {
    return { kind: 'disabled' };
  }
  const btc = getBtcContext();
  const staleMs = liveCfg.liveBtcGateMaxStaleMs;
  const ts = btc.updated_ts;
  const fresh = typeof ts === 'number' && ts > 0 && Date.now() - ts <= staleMs;
  if (!fresh) return { kind: 'stale' };

  const metrics = btcMetricsFromContext();
  const d1 = liveCfg.liveBtcBlockNewBuys1hDrawdownPct;
  const d4 = liveCfg.liveBtcBlockNewBuys4hDrawdownPct;
  const d24 = liveCfg.liveBtcBlockNewBuys24hDrawdownPct;
  const d72 = liveCfg.liveBtcBlockNewBuys72hDrawdownPct;
  const dPeak = liveCfg.liveBtcBlockNewBuysPeak72hDrawdownPct;

  if (d1 > 0 && metrics.ret1h_pct != null && metrics.ret1h_pct <= -d1) {
    return blocked('btc_dump_1h', d1, metrics);
  }
  if (d4 > 0 && metrics.ret4h_pct != null && metrics.ret4h_pct <= -d4) {
    return blocked('btc_dump_4h', d4, metrics);
  }
  if (d24 > 0 && metrics.ret24h_pct != null && metrics.ret24h_pct <= -d24) {
    return blocked('btc_dump_24h', d24, metrics);
  }
  if (d72 > 0 && metrics.ret72h_pct != null && metrics.ret72h_pct <= -d72) {
    return blocked('btc_dump_72h', d72, metrics);
  }
  if (
    dPeak > 0 &&
    metrics.retPeak72hDrawdown_pct != null &&
    metrics.retPeak72hDrawdown_pct <= -dPeak
  ) {
    return blocked('btc_dump_peak_72h', dPeak, metrics);
  }
  return { kind: 'ok', ...metrics };
}
