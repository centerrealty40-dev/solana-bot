import { db, schema } from '../../core/db/client.js';
import { TAG_BOT } from './constants.js';

const CTX_MAX = 7900;

export async function upsertBotTag(
  wallet: string,
  source: string,
  confidence: number,
  context: Record<string, unknown>,
): Promise<void> {
  const raw = JSON.stringify(context);
  const contextStr = raw.length > CTX_MAX ? `${raw.slice(0, CTX_MAX - 1)}…` : raw;
  const now = new Date();
  await db
    .insert(schema.walletTags)
    .values({
      wallet,
      tag: TAG_BOT,
      source,
      confidence,
      context: contextStr,
    })
    .onConflictDoUpdate({
      target: [schema.walletTags.wallet, schema.walletTags.tag, schema.walletTags.source],
      set: {
        confidence,
        context: contextStr,
        addedAt: now,
      },
    });
}
