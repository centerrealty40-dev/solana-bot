import { request } from 'undici';
import { config } from '../core/config.js';
import { child } from '../core/logger.js';
import { DEX_PROGRAMS } from '../core/constants.js';
import { insertSwapsBatch } from '../core/db/repository.js';
import { normalizeHeliusSwap, type HeliusEnhancedTx } from './normalizer.js';
import { getJupPrices } from './jupiter-price.js';
import { QUOTE_MINTS } from '../core/constants.js';

const log = child('helius-webhook');

/**
 * Programmatically register / update an enhanced webhook in Helius
 * pointing at our public webhook URL. Returns the webhook id.
 *
 * Helius docs: https://docs.helius.dev/webhooks-and-websockets/api-reference/edit-a-webhook
 */
export async function ensureHeliusWebhook(): Promise<string | null> {
  if (!config.heliusApiKey || !config.heliusWebhookUrl) {
    log.warn('HELIUS_API_KEY or HELIUS_WEBHOOK_URL missing; skipping webhook registration');
    return null;
  }
  const accountAddresses = Object.values(DEX_PROGRAMS);
  const body = {
    webhookURL: config.heliusWebhookUrl,
    transactionTypes: ['SWAP', 'TOKEN_MINT', 'TRANSFER'],
    accountAddresses,
    webhookType: 'enhanced',
    authHeader: config.heliusWebhookAuth || undefined,
  };
  const url = `https://api.helius.xyz/v0/webhooks?api-key=${config.heliusApiKey}`;

  try {
    const list = await request(url, { method: 'GET' });
    if (list.statusCode === 200) {
      const arr = (await list.body.json()) as Array<{ webhookID: string; webhookURL: string }>;
      const existing = arr.find((w) => w.webhookURL === config.heliusWebhookUrl);
      if (existing) {
        const upd = await request(
          `https://api.helius.xyz/v0/webhooks/${existing.webhookID}?api-key=${config.heliusApiKey}`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        if (upd.statusCode >= 200 && upd.statusCode < 300) {
          log.info({ id: existing.webhookID }, 'updated helius webhook');
          return existing.webhookID;
        }
        log.warn({ status: upd.statusCode }, 'failed to update existing webhook');
        return null;
      }
    }
    const create = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (create.statusCode >= 200 && create.statusCode < 300) {
      const json = (await create.body.json()) as { webhookID: string };
      log.info({ id: json.webhookID }, 'created helius webhook');
      return json.webhookID;
    }
    log.warn({ status: create.statusCode }, 'failed to create helius webhook');
    return null;
  } catch (err) {
    log.warn({ err: String(err) }, 'helius webhook ensure failed');
    return null;
  }
}

/**
 * Process a batch of enhanced transactions delivered by Helius webhook.
 *
 * Steps:
 *   1. Pre-fetch quote prices once (mostly SOL)
 *   2. Normalize each tx into 0..N swaps
 *   3. Filter dust (amountUsd < 50)
 *   4. Persist as a single batch
 *
 * Returns number of swaps inserted.
 */
export async function processHeliusBatch(txs: HeliusEnhancedTx[]): Promise<number> {
  if (txs.length === 0) return 0;
  const quotePrices = await getJupPrices([QUOTE_MINTS.SOL]);
  const allSwaps = txs
    .flatMap((tx) => normalizeHeliusSwap(tx, quotePrices))
    .filter((s) => s.amountUsd >= 50);
  if (allSwaps.length === 0) return 0;
  return insertSwapsBatch(allSwaps);
}

/**
 * Backfill helper: pull enhanced transactions for a wallet by signature pagination.
 * Used by scoring engine for initial wallet history backfill.
 *
 * Important: each call costs Helius credits. We cap at 1000 sigs by default to stay
 * within the Free tier 1M-credit budget.
 */
export async function fetchWalletHistory(
  wallet: string,
  limit = 1000,
): Promise<HeliusEnhancedTx[]> {
  if (!config.heliusApiKey) return [];
  const out: HeliusEnhancedTx[] = [];
  let before: string | undefined;
  while (out.length < limit) {
    const url =
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions` +
      `?api-key=${config.heliusApiKey}&limit=100${before ? `&before=${before}` : ''}`;
    try {
      const res = await request(url, { method: 'GET' });
      if (res.statusCode !== 200) {
        log.warn({ wallet, status: res.statusCode }, 'helius history non-200');
        break;
      }
      const batch = (await res.body.json()) as HeliusEnhancedTx[];
      if (batch.length === 0) break;
      out.push(...batch);
      before = batch[batch.length - 1]?.signature;
      if (!before) break;
      // be polite — 4 req/s
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      log.warn({ err: String(err), wallet }, 'helius history failed');
      break;
    }
  }
  return out.slice(0, limit);
}
