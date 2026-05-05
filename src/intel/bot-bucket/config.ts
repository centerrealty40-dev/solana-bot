import { z } from 'zod';

function isTruthy(v: string | undefined): boolean {
  if (v === undefined || v === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function envBool(key: string, defaultWhenUnset: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return defaultWhenUnset;
  return isTruthy(v);
}

const Schema = z.object({
  enabled: z.boolean().default(false),
  dryRun: z.boolean().default(true),

  ruleSet: z.string().min(4).max(32).default('2026-05-06'),

  sinceHours: z.coerce.number().int().min(1).max(168).default(24),

  umbrellaIncludeSniper: z.boolean().default(false),
  umbrellaMinTriggerConfidence: z.coerce.number().int().min(1).max(100).default(1),
  umbrellaConfidenceFloor: z.coerce.number().int().min(1).max(100).default(80),
  umbrellaConfidenceCap: z.coerce.number().int().min(1).max(100).default(95),

  layerBSwapBurst: z.boolean().default(true),
  swapCountMin: z.coerce.number().int().min(3).max(100_000).default(28),
  medianGapSecMax: z.coerce.number().min(1).max(86_400).default(120),

  layerBManyMints: z.boolean().default(true),
  distinctMintsMin: z.coerce.number().int().min(2).max(50_000).default(14),
  avgTradeUsdMax: z.coerce.number().min(1).max(1_000_000).default(280),
  manyMintsSwapMin: z.coerce.number().int().min(2).max(100_000).default(22),

  layerBFanout: z.boolean().default(true),
  fanoutDistinctTargetsMin: z.coerce.number().int().min(3).max(100_000).default(22),
  fanoutMinSolPerLeg: z.coerce.number().min(0).default(0.01),

  maxWalletsPerRule: z.coerce.number().int().min(1).max(50_000).default(4000),

  statementTimeoutMs: z.coerce.number().int().min(0).max(3_600_000).default(240_000),
});

export type BotBucketConfig = z.infer<typeof Schema>;

export function loadBotBucketConfig(): BotBucketConfig {
  const parsed = Schema.safeParse({
    enabled: isTruthy(process.env.BOT_BUCKET_ENABLED),
    dryRun: envBool('BOT_BUCKET_DRY_RUN', true),

    ruleSet: process.env.BOT_RULE_SET_VERSION,

    sinceHours: process.env.BOT_LAYER_B_SINCE_HOURS,

    umbrellaIncludeSniper: isTruthy(process.env.BOT_UMBRELLA_INCLUDE_SNIPER),
    umbrellaMinTriggerConfidence: process.env.BOT_UMBRELLA_MIN_TRIGGER_CONFIDENCE,
    umbrellaConfidenceFloor: process.env.BOT_UMBRELLA_CONFIDENCE_FLOOR,
    umbrellaConfidenceCap: process.env.BOT_UMBRELLA_CONFIDENCE_CAP,

    layerBSwapBurst: !isTruthy(process.env.BOT_RULE_SWAP_BURST_OFF ?? '0'),
    swapCountMin: process.env.BOT_SWAP_COUNT_24H_MIN,
    medianGapSecMax: process.env.BOT_MEDIAN_GAP_SEC_MAX,

    layerBManyMints: !isTruthy(process.env.BOT_RULE_MANY_MINTS_OFF ?? '0'),
    distinctMintsMin: process.env.BOT_DISTINCT_MINTS_MIN,
    avgTradeUsdMax: process.env.BOT_AVG_TRADE_USD_MAX,
    manyMintsSwapMin: process.env.BOT_MANY_MINTS_SWAP_MIN,

    layerBFanout: !isTruthy(process.env.BOT_RULE_FANOUT_OFF ?? '0'),
    fanoutDistinctTargetsMin: process.env.BOT_FANOUT_TARGETS_MIN,
    fanoutMinSolPerLeg: process.env.BOT_FANOUT_MIN_SOL_PER_LEG,

    maxWalletsPerRule: process.env.BOT_BUCKET_MAX_WALLETS_PER_RULE,

    statementTimeoutMs: process.env.BOT_BUCKET_STATEMENT_TIMEOUT_MS,
  });

  if (!parsed.success) {
    const m = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`bot-bucket env: ${m}`);
  }
  return parsed.data;
}
