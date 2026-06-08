import { getBtcContext } from '../../papertrader/pricing.js';
import type { TwapSide } from './types.js';

export type HlTwapBtcAlignedGateStatus =
  | { kind: 'disabled' }
  | { kind: 'stale' }
  | { kind: 'ok'; ret1h_pct: number };

function envBool(name: string, defaultOn: boolean): boolean {
  const v = process.env[name]?.trim();
  if (v == null || v === '') return defaultOn;
  return v === '1' || v.toLowerCase() === 'true' || v === 'yes';
}

export function hlTwapBtcAlignedGateEnabled(): boolean {
  return envBool('HL_TWAP_BTC_ALIGNED_GATE', false);
}

export function hlTwapBtcGateMaxStaleMs(): number {
  const v = process.env.HL_TWAP_BTC_GATE_MAX_STALE_MS?.trim();
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 60_000) return Math.round(n);
  }
  return 900_000;
}

export function resolveHlTwapBtcAlignedGateStatus(): HlTwapBtcAlignedGateStatus {
  if (!hlTwapBtcAlignedGateEnabled()) return { kind: 'disabled' };

  const btc = getBtcContext();
  const ts = btc.updated_ts;
  const staleMs = hlTwapBtcGateMaxStaleMs();
  const fresh = typeof ts === 'number' && ts > 0 && Date.now() - ts <= staleMs;
  if (!fresh || btc.ret1h_pct == null) return { kind: 'stale' };

  return { kind: 'ok', ret1h_pct: btc.ret1h_pct };
}

/**
 * Side-aware BTC 1h gate: no long when BTC 1h < 0, no short when BTC 1h > 0.
 * Returns skip reason or null when entry is allowed.
 */
export function hlTwapBtcAlignedBlockReason(side: TwapSide): string | null {
  const st = resolveHlTwapBtcAlignedGateStatus();
  if (st.kind === 'disabled') return null;
  if (st.kind === 'stale') return 'btc_gate_stale';
  if (side === 'buy' && st.ret1h_pct < 0) return 'btc_aligned_gate_long';
  if (side === 'sell' && st.ret1h_pct > 0) return 'btc_aligned_gate_short';
  return null;
}
