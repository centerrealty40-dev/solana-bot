/**
 * Read copy-trader state so live-oscar treats copy-leader legs as invisible for discovery gates.
 * Copy positions live in a separate journal/state; only wallet-holdings attribution is shared.
 */
import fs from 'node:fs';
import path from 'node:path';

export const COPY_LEADER_POSITION_SOURCE = 'copy_leader' as const;

export type CopyLeaderMintAttribution = {
  mint: string;
  costBasisUsd: number;
  sizeUsd: number;
  tokenRaw?: string;
  positionSource: typeof COPY_LEADER_POSITION_SOURCE;
  /** Set when live-oscar promoted copy leg → Oscar-managed (copy-trader stops mirror sells). */
  oscarPromotedAt?: number;
  entryPriceUsd?: number;
};

function envBool(v: unknown, def: boolean): boolean {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return def;
}

/** Path to copy-trader state (sidecar read from live-oscar process). */
export function copyLeaderStatePathFromEnv(): string | null {
  if (!envBool(process.env.LIVE_COPY_LEADER_ATTRIBUTION_ENABLED, true)) return null;
  const p =
    process.env.LIVE_COPY_LEADER_STATE_PATH?.trim() ||
    process.env.COPY_TRADER_STATE_PATH?.trim() ||
    path.join('data', 'copytrader', 'state.json');
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

type CopyStateRow = {
  mint: string;
  sizeUsd?: number;
  entryDeployedCostUsd?: number;
  tokenRaw?: string;
  positionSource?: string;
  entryPriceUsd?: number;
  oscarPromotedAt?: number;
};

type CopyStateFile = {
  positions?: Record<string, CopyStateRow>;
};

/** Cost basis attributed to copy-leader for a mint (0 when none / unreadable). */
export function readCopyLeaderCostBasisUsd(mint: string, statePath?: string): number {
  const row = readCopyLeaderMintAttribution(mint, statePath);
  return row?.costBasisUsd ?? 0;
}

export function readCopyLeaderMintAttribution(
  mint: string,
  statePath?: string,
): CopyLeaderMintAttribution | null {
  const fp = statePath ?? copyLeaderStatePathFromEnv();
  if (!fp) return null;
  const key = mint.trim();
  if (!key) return null;

  let parsed: CopyStateFile;
  try {
    parsed = JSON.parse(fs.readFileSync(fp, 'utf8')) as CopyStateFile;
  } catch {
    return null;
  }

  const pos = parsed.positions?.[key];
  if (!pos) return null;

  const deployed =
    typeof pos.entryDeployedCostUsd === 'number' && pos.entryDeployedCostUsd > 0
      ? pos.entryDeployedCostUsd
      : typeof pos.sizeUsd === 'number' && pos.sizeUsd > 0
        ? pos.sizeUsd
        : 0;
  if (!(deployed > 0)) return null;

  const row = pos as CopyStateRow;

  return {
    mint: key,
    costBasisUsd: deployed,
    sizeUsd: typeof pos.sizeUsd === 'number' && pos.sizeUsd > 0 ? pos.sizeUsd : deployed,
    tokenRaw: pos.tokenRaw,
    positionSource: COPY_LEADER_POSITION_SOURCE,
    oscarPromotedAt:
      typeof row.oscarPromotedAt === 'number' && row.oscarPromotedAt > 0
        ? row.oscarPromotedAt
        : undefined,
    entryPriceUsd:
      typeof row.entryPriceUsd === 'number' && row.entryPriceUsd > 0 ? row.entryPriceUsd : undefined,
  };
}

export function isCopyLeaderPromotedToOscar(mint: string, statePath?: string): boolean {
  const row = readCopyLeaderMintAttribution(mint, statePath);
  return row?.oscarPromotedAt != null && row.oscarPromotedAt > 0;
}

/** Mark copy position Oscar-managed so copy-trader stops proportional mirror sells. */
export function markCopyLeaderPromotedToOscar(args: {
  mint: string;
  statePath?: string;
  promotedAt?: number;
}): boolean {
  const fp = args.statePath ?? copyLeaderStatePathFromEnv();
  if (!fp) return false;
  const key = args.mint.trim();
  if (!key) return false;

  let parsed: CopyStateFile;
  try {
    parsed = JSON.parse(fs.readFileSync(fp, 'utf8')) as CopyStateFile;
  } catch {
    return false;
  }

  const pos = parsed.positions?.[key];
  if (!pos) return false;

  const promotedAt = args.promotedAt ?? Date.now();
  (pos as CopyStateRow).oscarPromotedAt = promotedAt;

  const dir = path.dirname(fp);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${fp}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
  return true;
}

/**
 * Subtract copy-leader cost basis from wallet mint USD estimate so oscar buy_open is not blocked.
 */
export function oscarWalletMintUsdExcludingCopyLeader(args: {
  walletMintUsd: number;
  mint: string;
  statePath?: string;
}): number {
  if (isCopyLeaderPromotedToOscar(args.mint, args.statePath)) {
    return args.walletMintUsd;
  }
  const attributed = readCopyLeaderCostBasisUsd(args.mint, args.statePath);
  if (!(attributed > 0)) return args.walletMintUsd;
  return Math.max(0, args.walletMintUsd - attributed);
}
