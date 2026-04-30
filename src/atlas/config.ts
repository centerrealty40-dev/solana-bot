import { z } from 'zod';

function parseEnvBool(v: unknown, defaultVal: boolean): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '' || v === undefined || v === null) return defaultVal;
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return defaultVal;
}

const AtlasEnvSchema = z.object({
  batchSize: z.coerce.number().int().min(1).max(5000).default(200),
  tickMs: z.coerce.number().int().min(100).max(60_000).default(1500),
  lookbackHours: z.coerce.number().int().min(1).max(168).default(12),
  dryRun: z.coerce.boolean().default(false),
  logEveryN: z.coerce.number().int().min(1).max(100_000).default(1000),
  tagWindowHours: z.coerce.number().int().min(1).max(168).default(24),
});

export type AtlasConfig = z.infer<typeof AtlasEnvSchema> & {
  flowsEnabled: boolean;
  tagsEnabled: boolean;
};

export function loadAtlasConfig(): AtlasConfig {
  const dry =
    String(process.env.SA_ATLAS_DRY_RUN ?? '')
      .trim()
      .toLowerCase() === 'true' ||
    process.env.SA_ATLAS_DRY_RUN === '1';

  const parsed = AtlasEnvSchema.safeParse({
    batchSize: process.env.SA_ATLAS_BATCH_SIZE,
    tickMs: process.env.SA_ATLAS_TICK_MS,
    lookbackHours: process.env.SA_ATLAS_LOOKBACK_HOURS,
    dryRun: dry,
    logEveryN: process.env.SA_ATLAS_LOG_EVERY_N,
    tagWindowHours: process.env.SA_ATLAS_TAG_WINDOW_HOURS,
  });

  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`sa-atlas env: ${msg}`);
  }

  return {
    ...parsed.data,
    flowsEnabled: parseEnvBool(process.env.SA_ATLAS_FLOWS_ENABLED, true),
    tagsEnabled: parseEnvBool(process.env.SA_ATLAS_TAGS_ENABLED, true),
  };
}
