import { z } from 'zod';

const EnvSchema = z.object({
  lookbackDays: z.coerce.number().int().min(1).max(90).default(14),
  fundingWindowSec: z.coerce.number().int().min(30).max(3600).default(300),
  fundingMinTargets: z.coerce.number().int().min(2).default(3),
  fundingAmountRelTolerance: z.coerce.number().min(0.01).max(0.5).default(0.2),
  orchestrationMaxPairAgeHours: z.coerce.number().int().min(1).max(168).default(120),
  rugAnchorEarlyBuyersLimit: z.coerce.number().int().min(5).max(200).default(40),
  minLiquidityUsdRugHeuristic: z.coerce.number().min(0).default(500),
  /** High bar: auto-confirm + always eligible for atlas when score >= this */
  strongScore: z.coerce.number().min(0).max(200).default(80),
  /** Min score to allow Wallet Atlas write (when WRITE_ATLAS=1) */
  confirmWriteScore: z.coerce.number().min(0).max(200).default(75),
  /**
   * If true, also write atlas for `needs_evidence` / `open` when score >= confirmWriteScore
   * (not only `confirmed` or score >= strongScore). Server automation default: true.
   */
  atlasWriteBelowConfirmed: z.coerce.boolean().default(true),
  dismissStaleDays: z.coerce.number().int().min(1).max(90).default(14),
  /** Below this, stale candidates may be auto-dismissed */
  dismissMaxScore: z.coerce.number().min(0).default(15),
  dryRun: z.coerce.boolean().default(true),
  writeAtlas: z.coerce.boolean().default(false),
  updatePrimaryTag: z.coerce.boolean().default(false),
  enableRpc: z.coerce.boolean().default(false),
  rpcBudget: z.coerce.number().int().min(0).default(0),
  /**
   * HTTPS JSON-RPC (QuickNode, Alchemy, etc.). Prefer SOLANA_RPC_HTTP_URL on server.
   * @deprecated use solanaRpcHttpUrl — kept as alias in loadScamFarmConfig
   */
  solanaRpcHttpUrl: z.string().optional().default(''),
  logPath: z.string().default('data/logs/scam-farm-detective.log'),
  maxSqlRows: z.coerce.number().int().min(10).default(2000),
});

export type ScamFarmConfig = z.infer<typeof EnvSchema> & { source: string };

export const TAG_SOURCE = 'scam_farm_detective' as const;

/**
 * Load config from process.env. Safe defaults: DRY_RUN=1, WRITE_ATLAS=0, RPC=0.
 */
export function loadScamFarmConfig(): ScamFarmConfig {
  const parsed = EnvSchema.safeParse({
    lookbackDays: process.env.SCAM_FARM_LOOKBACK_DAYS,
    fundingWindowSec: process.env.SCAM_FARM_FUNDING_WINDOW_SEC,
    fundingMinTargets: process.env.SCAM_FARM_FUNDING_MIN_TARGETS,
    fundingAmountRelTolerance: process.env.SCAM_FARM_FUNDING_AMOUNT_TOLERANCE,
    orchestrationMaxPairAgeHours: process.env.SCAM_FARM_ORCH_MAX_AGE_H,
    rugAnchorEarlyBuyersLimit: process.env.SCAM_FARM_RUG_EARLY_BUYERS,
    minLiquidityUsdRugHeuristic: process.env.SCAM_FARM_RUG_MIN_LIQ_USD,
    strongScore: process.env.SCAM_FARM_STRONG_SCORE,
    confirmWriteScore: process.env.SCAM_FARM_CONFIRM_WRITE_SCORE,
    atlasWriteBelowConfirmed: (() => {
      const v = process.env.SCAM_FARM_ATLAS_WRITE_BELOW_CONFIRMED;
      if (v === undefined || v === '') {
        return true;
      }
      return isTruthy(v);
    })(),
    dismissStaleDays: process.env.SCAM_FARM_DISMISS_STALE_DAYS,
    dismissMaxScore: process.env.SCAM_FARM_DISMISS_MAX_SCORE,
    dryRun: isTruthy(process.env.SCAM_FARM_DRY_RUN ?? '1'),
    writeAtlas: isTruthy(process.env.SCAM_FARM_WRITE_ATLAS ?? '0'),
    updatePrimaryTag: isTruthy(process.env.SCAM_FARM_UPDATE_PRIMARY ?? '0'),
    enableRpc: isTruthy(process.env.SCAM_FARM_ENABLE_RPC ?? '0'),
    rpcBudget: process.env.SCAM_FARM_RPC_BUDGET,
    solanaRpcHttpUrl:
      process.env.SOLANA_RPC_HTTP_URL ||
      process.env.QUICKNODE_HTTP_URL ||
      process.env.ALCHEMY_HTTP_URL ||
      '',
    logPath: process.env.SCAM_FARM_LOG_PATH,
    maxSqlRows: process.env.SCAM_FARM_MAX_SQL_ROWS,
  });
  if (!parsed.success) {
    const m = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`scam-farm-detective env: ${m}`);
  }
  const c = parsed.data;
  if (c.enableRpc) {
    if (c.rpcBudget < 1 || !c.solanaRpcHttpUrl || !c.solanaRpcHttpUrl.startsWith('https://')) {
      throw new Error(
        'SCAM_FARM_ENABLE_RPC=1 requires SCAM_FARM_RPC_BUDGET>0 and SOLANA_RPC_HTTP_URL (or QUICKNODE_HTTP_URL, https URL)',
      );
    }
  }
  return { ...c, source: TAG_SOURCE };
}

function isTruthy(v: string | undefined): boolean {
  if (!v) {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}
