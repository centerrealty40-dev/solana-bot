import type { LiveOscarConfig } from '../live/config.js';
import { loadLiveKeypairFromSecretEnv } from '../live/wallet.js';
import type { PumpswapComboConfig } from './config.js';
import { comboRpcGap } from './metered-rpc.js';
import { quotePumpSwapExitPriceUsd } from './pumpswap-direct.js';
import type { ComboPosition } from './types.js';
import { fetchMintPoolAddress } from './watchlist.js';

export type ExitMark = { priceUsd: number; tokenRaw: bigint; at: number };

export class ComboExitMarkCache {
  private marks = new Map<string, ExitMark>();
  private cursor = 0;

  get(mint: string, cfg: PumpswapComboConfig, now = Date.now()): ExitMark | null {
    const m = this.marks.get(mint);
    if (!m) return null;
    if (now - m.at > cfg.exitMarkMaxStaleMs) return null;
    return m;
  }

  set(mint: string, mark: ExitMark): void {
    this.marks.set(mint, mark);
  }

  invalidate(mint: string): void {
    this.marks.delete(mint);
  }

  prune(closedMints: Set<string>): void {
    for (const mint of closedMints) this.marks.delete(mint);
  }

  async refreshDue(
    cfg: PumpswapComboConfig,
    liveCfg: LiveOscarConfig,
    positions: ComboPosition[],
    balances: Map<string, bigint> | null,
    now = Date.now(),
  ): Promise<number> {
    if (!positions.length) return 0;
    const maxPerTick = Math.max(1, cfg.exitQuotesPerTick);
    const ttl = cfg.exitMarkTtlMs;
    const sorted = [...positions].sort((a, b) => {
      const ma = this.marks.get(a.mint)?.at ?? 0;
      const mb = this.marks.get(b.mint)?.at ?? 0;
      return ma - mb;
    });

    let refreshed = 0;
    const start = this.cursor % sorted.length;
    for (let i = 0; i < sorted.length && refreshed < maxPerTick; i++) {
      const pos = sorted[(start + i) % sorted.length]!;
      const existing = this.marks.get(pos.mint);
      if (existing && now - existing.at < ttl) continue;
      const mark = await fetchExitMark(cfg, liveCfg, pos, balances);
      if (mark) {
        this.marks.set(pos.mint, mark);
        refreshed++;
      }
    }
    if (sorted.length) this.cursor = (start + refreshed) % sorted.length;
    return refreshed;
  }
}

export async function fetchExitMark(
  cfg: PumpswapComboConfig,
  liveCfg: LiveOscarConfig,
  pos: ComboPosition,
  balances: Map<string, bigint> | null,
): Promise<ExitMark | null> {
  const secret = liveCfg.walletSecret?.trim();
  if (!secret) return null;
  const user = loadLiveKeypairFromSecretEnv(secret).publicKey;
  const raw = balances?.get(pos.mint) ?? 0n;
  if (raw <= 0n) return null;

  const pool = pos.poolAddress?.trim() || (await fetchMintPoolAddress(pos.mint));
  if (!pool) return null;

  await comboRpcGap(cfg);
  const q = await quotePumpSwapExitPriceUsd({
    rpcUrl: cfg.rpcUrl,
    poolAddress: pool,
    tokenRaw: raw,
    user,
  });
  if (!(q.priceUsd != null && q.priceUsd > 0)) return null;
  return { priceUsd: q.priceUsd, tokenRaw: raw, at: Date.now() };
}
