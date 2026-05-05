import { z } from 'zod';

function isTruthy(v: string | undefined): boolean {
  if (v === undefined || v === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function parseCsvAddresses(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 32 && s.length <= 64);
}

const EnvSchema = z.object({
  enabled: z.boolean().default(false),
  dryRun: z.boolean().default(true),
  statementTimeoutMs: z.coerce.number().int().min(0).max(3_600_000).default(180_000),

  seedCap: z.coerce.number().int().min(100).max(500_000).default(25_000),

  sinkLookbackHours: z.coerce.number().int().min(1).max(720).default(72),
  sinkAsset: z.string().min(1).max(16).default('SOL'),
  sinkMinSources: z.coerce.number().int().min(2).max(10_000).default(8),
  treasuryMinSources: z.coerce.number().int().min(2).max(20_000).default(12),
  sinkMinTotalSol: z.coerce.number().min(0).default(0.05),
  sinkMaxTargetsPerRun: z.coerce.number().int().min(1).max(5000).default(500),

  sinkWideMode: z.boolean().default(false),
  sinkWideMinSources: z.coerce.number().int().min(3).max(50_000).default(15),

  excludeTargets: z.array(z.string()).default([]),

  metaMinWallets: z.coerce.number().int().min(2).max(50_000).default(4),
  metaFlowEdges: z.boolean().default(true),
  metaFlowEdgesLimit: z.coerce.number().int().min(0).max(100_000).default(8000),

  relayEnabled: z.boolean().default(true),
  relayMinIn: z.coerce.number().int().min(2).max(5000).default(4),
  relayMinOut: z.coerce.number().int().min(2).max(5000).default(4),
  relayHubCap: z.coerce.number().int().min(10).max(50_000).default(600),

  temporalEnabled: z.boolean().default(false),
  temporalLookbackHours: z.coerce.number().int().min(1).max(168).default(24),
  temporalMinWalletsPerMinute: z.coerce.number().int().min(3).max(5000).default(8),
  temporalMintRowsCap: z.coerce.number().int().min(1).max(5000).default(120),

  cexDepositAllowlist: z.array(z.string()).default([]),
  cexHintConfidence: z.coerce.number().int().min(1).max(100).default(30),

  confidenceSink: z.coerce.number().int().min(1).max(100).default(58),
  confidenceTreasury: z.coerce.number().int().min(1).max(100).default(74),
  confidenceRelay: z.coerce.number().int().min(1).max(100).default(52),
  confidenceTemporal: z.coerce.number().int().min(1).max(100).default(38),
  confidenceMetaMember: z.coerce.number().int().min(1).max(100).default(55),
});

export type ScamFarmGraphConfig = z.infer<typeof EnvSchema>;

export function loadScamFarmGraphConfig(): ScamFarmGraphConfig {
  const parsed = EnvSchema.safeParse({
    enabled: isTruthy(process.env.SCAM_FARM_GRAPH_ENABLED),
    dryRun: isTruthy(process.env.SCAM_FARM_GRAPH_DRY_RUN ?? '1'),
    statementTimeoutMs: process.env.SCAM_FARM_GRAPH_STATEMENT_TIMEOUT_MS,

    seedCap: process.env.SCAM_FARM_GRAPH_SEED_CAP,

    sinkLookbackHours: process.env.SCAM_FARM_SINK_LOOKBACK_HOURS,
    sinkAsset: process.env.SCAM_FARM_SINK_ASSET,
    sinkMinSources: process.env.SCAM_FARM_SINK_MIN_SOURCES,
    treasuryMinSources: process.env.SCAM_FARM_TREASURY_MIN_SOURCES,
    sinkMinTotalSol: process.env.SCAM_FARM_SINK_MIN_TOTAL_SOL,
    sinkMaxTargetsPerRun: process.env.SCAM_FARM_SINK_MAX_TARGETS_PER_RUN,

    sinkWideMode: isTruthy(process.env.SCAM_FARM_SINK_WIDE_MODE),
    sinkWideMinSources: process.env.SCAM_FARM_SINK_WIDE_MIN_SOURCES,

    excludeTargets: parseCsvAddresses(process.env.SCAM_FARM_SINK_EXCLUDE_WALLETS),

    metaMinWallets: process.env.SCAM_FARM_META_MIN_WALLETS,
    metaFlowEdges: !isTruthy(process.env.SCAM_FARM_META_FLOW_EDGES_OFF ?? '0'),
    metaFlowEdgesLimit: process.env.SCAM_FARM_META_FLOW_EDGES_LIMIT,

    relayEnabled: !isTruthy(process.env.SCAM_FARM_RELAY_OFF ?? '0'),
    relayMinIn: process.env.SCAM_FARM_RELAY_MIN_IN,
    relayMinOut: process.env.SCAM_FARM_RELAY_MIN_OUT,
    relayHubCap: process.env.SCAM_FARM_RELAY_HUB_CAP,

    temporalEnabled: isTruthy(process.env.SCAM_FARM_TEMPORAL_ENABLED),
    temporalLookbackHours: process.env.SCAM_FARM_TEMPORAL_LOOKBACK_HOURS,
    temporalMinWalletsPerMinute: process.env.SCAM_FARM_TEMPORAL_MIN_WALLETS,
    temporalMintRowsCap: process.env.SCAM_FARM_TEMPORAL_MINT_CAP,

    cexDepositAllowlist: parseCsvAddresses(process.env.SCAM_FARM_CEX_DEPOSIT_ALLOWLIST),
    cexHintConfidence: process.env.SCAM_FARM_CEX_HINT_CONFIDENCE,

    confidenceSink: process.env.SCAM_FARM_GRAPH_CONFIDENCE_SINK,
    confidenceTreasury: process.env.SCAM_FARM_GRAPH_CONFIDENCE_TREASURY,
    confidenceRelay: process.env.SCAM_FARM_GRAPH_CONFIDENCE_RELAY,
    confidenceTemporal: process.env.SCAM_FARM_GRAPH_CONFIDENCE_TEMPORAL,
    confidenceMetaMember: process.env.SCAM_FARM_GRAPH_CONFIDENCE_META,
  });

  if (!parsed.success) {
    const m = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`scam-farm-graph env: ${m}`);
  }
  return parsed.data;
}
