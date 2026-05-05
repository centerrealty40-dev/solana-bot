import { sql } from 'drizzle-orm';
import type { DB } from '../../core/db/client.js';
import type { BotBucketConfig } from './config.js';
import { SOURCE_BOT_UMBRELLA_V0 } from './constants.js';
import { upsertBotTag } from './persist.js';

export type LayerARow = {
  wallet: string;
  maxConf: number;
  triggerTags: string[];
};

export async function queryLayerAUmbrellaCandidates(db: DB, c: BotBucketConfig): Promise<LayerARow[]> {
  const base = ['mev_bot', 'bot_farm_boss', 'bot_farm_distributor'];
  const tags = c.umbrellaIncludeSniper ? [...base, 'sniper'] : base;

  const rows = (await db.execute(sql`
    SELECT wt.wallet AS wallet,
           MAX(wt.confidence)::int AS max_conf,
           array_agg(DISTINCT wt.tag ORDER BY wt.tag) AS trigger_tags
    FROM wallet_tags wt
    WHERE wt.tag IN (${sql.join(
      tags.map((t) => sql`${t}`),
      sql`, `,
    )})
    GROUP BY wt.wallet
    HAVING MAX(wt.confidence) >= ${c.umbrellaMinTriggerConfidence}
  `)) as unknown as Array<{ wallet: string; max_conf: number; trigger_tags: string[] }>;

  return rows.map((r) => ({
    wallet: r.wallet,
    maxConf: r.max_conf,
    triggerTags: r.trigger_tags ?? [],
  }));
}

export async function applyLayerAUmbrella(
  db: DB,
  c: BotBucketConfig,
  dryRun: boolean,
): Promise<{ candidates: number; written: number }> {
  const rows = await queryLayerAUmbrellaCandidates(db, c);
  let written = 0;
  for (const r of rows) {
    const conf = Math.min(
      c.umbrellaConfidenceCap,
      Math.max(c.umbrellaConfidenceFloor, r.maxConf),
    );
    const context = {
      rule_set: c.ruleSet,
      layer: 'A',
      trigger_tags: r.triggerTags,
      source_rule: SOURCE_BOT_UMBRELLA_V0,
    };
    if (!dryRun) {
      await upsertBotTag(r.wallet, SOURCE_BOT_UMBRELLA_V0, conf, context);
      written += 1;
    }
  }
  return { candidates: rows.length, written };
}
