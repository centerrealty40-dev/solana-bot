import { z } from 'zod';

function boolEnv(v: string | undefined, defaultVal: boolean): boolean {
  if (v === undefined || v === '') return defaultVal;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

const Schema = z.object({
  policyWalletLimit: z.coerce.number().int().min(1).max(500_000).default(20_000),
  entityLookbackHours: z.coerce.number().int().min(1).max(24 * 90).default(168),
  scamFarmBlockMinScore: z.coerce.number().min(0).max(200).default(55),
  scamFarmBlockStatuses: z
    .string()
    .default('confirmed,needs_evidence')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  botPrimarySuppressesSmart: z.boolean().default(true),
  requireSwapCoverage: z.boolean().default(false),
  earlyBuyersK: z.coerce.number().int().min(1).max(10_000).default(1000),
  earlyWindowMinutes: z.coerce.number().int().min(1).max(24 * 60).default(45),
  ruleSetVersionOverride: z.string().optional(),
  runTagger: z.boolean().default(false),
  taggerLookbackHours: z.coerce.number().int().min(1).max(24 * 90).default(168),
  /** При mint-check дописывать решения для покупателей без строки в wallet_intel_decisions */
  mintCheckMaterializeMissing: z.boolean().default(true),
});

export type WalletIntelEnv = z.infer<typeof Schema>;

export function loadWalletIntelEnv(): WalletIntelEnv {
  const parsed = Schema.safeParse({
    policyWalletLimit: process.env.WALLET_INTEL_POLICY_LIMIT,
    entityLookbackHours: process.env.WALLET_INTEL_ENTITY_LOOKBACK_HOURS,
    scamFarmBlockMinScore: process.env.WALLET_INTEL_SCAM_BLOCK_MIN_SCORE,
    scamFarmBlockStatuses: process.env.WALLET_INTEL_SCAM_BLOCK_STATUSES,
    botPrimarySuppressesSmart: boolEnv(process.env.WALLET_INTEL_BOT_PRIMARY_SUPPRESSES_SMART, true),
    requireSwapCoverage: boolEnv(process.env.WALLET_INTEL_REQUIRE_SWAP_COVERAGE, false),
    earlyBuyersK: process.env.WALLET_INTEL_EARLY_BUYERS_K,
    earlyWindowMinutes: process.env.WALLET_INTEL_T_EARLY_MINUTES,
    ruleSetVersionOverride: process.env.WALLET_INTEL_RULE_SET_VERSION,
    runTagger: boolEnv(process.env.WALLET_INTEL_RUN_TAGGER, false),
    taggerLookbackHours: process.env.WALLET_INTEL_TAGGER_LOOKBACK_HOURS,
    mintCheckMaterializeMissing: boolEnv(process.env.WALLET_INTEL_MINT_CHECK_MATERIALIZE, true),
  });
  if (!parsed.success) {
    throw new Error(`wallet-intel env: ${parsed.error.message}`);
  }
  return parsed.data;
}
