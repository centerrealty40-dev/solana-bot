import { sql as dsql } from 'drizzle-orm';
import { config } from '../core/config.js';
import { child } from '../core/logger.js';
import { db, schema } from '../core/db/client.js';
import { insertSwapsBatch } from '../core/db/repository.js';
import { normalizeHeliusSwap, type HeliusEnhancedTx } from './normalizer.js';
import { getJupPrices } from './jupiter-price.js';
import { QUOTE_MINTS, DEX_PROGRAMS } from '../core/constants.js';
import { heliusFetch, HeliusGuardError } from '../core/helius-guard.js';

const log = child('helius-webhook');

/**
 * IMPORTANT — read this before changing how we register webhooks.
 *
 * Subscribing a Helius webhook to entire DEX program addresses (Raydium AMM,
 * Pumpfun, Jupiter, Orca, ...) generates ~hundreds of deliveries per second
 * and depletes the Free tier (1M credits/mo) in roughly an hour.
 *
 * This module enforces wallet-only subscriptions:
 *   - addresses are pulled from {@link schema.watchlistWallets} (curated).
 *   - the size is capped by `config.heliusMaxWatchlistSize`.
 *   - any address that matches a known DEX program is rejected outright.
 *
 * If you ever need program-level subscriptions, switch to `HELIUS_MODE=unsafe`
 * AND make sure you have a paid plan with high credit ceiling. The guard will
 * still cap you, just at a higher number.
 */

const DEX_PROGRAM_SET = new Set<string>(Object.values(DEX_PROGRAMS));
const HELIUS_API = 'https://api.helius.xyz';

async function loadWatchlistAddresses(): Promise<string[]> {
  const rows = await db
    .select({ wallet: schema.watchlistWallets.wallet })
    .from(schema.watchlistWallets)
    .where(dsql`${schema.watchlistWallets.removedAt} IS NULL`);
  return rows.map((r) => r.wallet);
}

function assertSafeAddressList(addresses: string[]): void {
  if (addresses.length === 0) {
    throw new Error(
      'watchlist_wallets is empty; refusing to register webhook (we will not subscribe to programs)',
    );
  }
  if (addresses.length > config.heliusMaxWatchlistSize) {
    throw new Error(
      `watchlist has ${addresses.length} addresses, exceeds HELIUS_MAX_WATCHLIST_SIZE=${config.heliusMaxWatchlistSize}; refusing`,
    );
  }
  const programLeak = addresses.find((a) => DEX_PROGRAM_SET.has(a));
  if (programLeak) {
    throw new Error(
      `address ${programLeak} is a known DEX program id; refusing to subscribe (this caused the 2026-04 burn)`,
    );
  }
}

/**
 * Programmatically register or update an enhanced webhook in Helius pointing at
 * our public webhook URL. Returns the webhook id.
 *
 * Behaviour:
 *   - HELIUS_MODE=off       -> no-op (returns null), logs at info level
 *   - HELIUS_MODE=wallets   -> subscribes to watchlist addresses only
 *   - HELIUS_MODE=unsafe    -> still requires explicit watchlist (no programs)
 *
 * Helius docs: https://docs.helius.dev/webhooks-and-websockets/api-reference/edit-a-webhook
 */
export async function ensureHeliusWebhook(): Promise<string | null> {
  if (config.heliusMode === 'off') {
    log.info('HELIUS_MODE=off; skipping webhook registration');
    return null;
  }
  if (!config.heliusApiKey || !config.heliusWebhookUrl) {
    log.warn('HELIUS_API_KEY or HELIUS_WEBHOOK_URL missing; skipping webhook registration');
    return null;
  }

  let accountAddresses: string[];
  try {
    accountAddresses = await loadWatchlistAddresses();
    assertSafeAddressList(accountAddresses);
  } catch (err) {
    log.error({ err: String(err) }, 'refusing to register webhook (safety check failed)');
    return null;
  }

  const body = {
    webhookURL: config.heliusWebhookUrl,
    transactionTypes: ['SWAP'],
    accountAddresses,
    webhookType: 'enhanced',
    authHeader: config.heliusWebhookAuth || undefined,
  };

  try {
    const list = await heliusFetch({
      url: `${HELIUS_API}/v0/webhooks?api-key=${config.heliusApiKey}`,
      kind: 'webhook_list',
      note: 'list existing',
    });
    if (list.statusCode !== 200) {
      log.warn({ status: list.statusCode }, 'helius list non-200');
      return null;
    }
    const arr = (await list.body.json()) as Array<{ webhookID: string; webhookURL: string }>;
    const existing = arr.find((w) => w.webhookURL === config.heliusWebhookUrl);

    if (existing) {
      const upd = await heliusFetch({
        url: `${HELIUS_API}/v0/webhooks/${existing.webhookID}?api-key=${config.heliusApiKey}`,
        method: 'PUT',
        body,
        kind: 'webhook_update',
        note: existing.webhookID,
      });
      if (upd.statusCode >= 200 && upd.statusCode < 300) {
        log.info(
          { id: existing.webhookID, addresses: accountAddresses.length },
          'updated helius webhook',
        );
        return existing.webhookID;
      }
      log.warn({ status: upd.statusCode }, 'failed to update existing webhook');
      return null;
    }

    const create = await heliusFetch({
      url: `${HELIUS_API}/v0/webhooks?api-key=${config.heliusApiKey}`,
      method: 'POST',
      body,
      kind: 'webhook_create',
      note: 'create new',
    });
    if (create.statusCode >= 200 && create.statusCode < 300) {
      const json = (await create.body.json()) as { webhookID: string };
      log.info(
        { id: json.webhookID, addresses: accountAddresses.length },
        'created helius webhook',
      );
      return json.webhookID;
    }
    log.warn({ status: create.statusCode }, 'failed to create helius webhook');
    return null;
  } catch (err) {
    if (err instanceof HeliusGuardError) {
      log.error({ reason: err.reason }, `helius guard blocked: ${err.message}`);
      return null;
    }
    log.warn({ err: String(err) }, 'helius webhook ensure failed');
    return null;
  }
}

/**
 * Delete every webhook currently registered for our API key. Used by the
 * `helius:wipe` script as an emergency stop-cock.
 */
export async function deleteAllHeliusWebhooks(): Promise<{ deleted: number }> {
  if (!config.heliusApiKey) return { deleted: 0 };

  const list = await heliusFetch({
    url: `${HELIUS_API}/v0/webhooks?api-key=${config.heliusApiKey}`,
    kind: 'webhook_list',
    note: 'wipe-list',
  });
  if (list.statusCode !== 200) {
    throw new Error(`helius list non-200: ${list.statusCode}`);
  }
  const arr = (await list.body.json()) as Array<{ webhookID: string; webhookURL: string }>;
  let deleted = 0;
  for (const w of arr) {
    const res = await heliusFetch({
      url: `${HELIUS_API}/v0/webhooks/${w.webhookID}?api-key=${config.heliusApiKey}`,
      method: 'DELETE',
      kind: 'webhook_delete',
      note: w.webhookID,
    });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      deleted++;
      log.info({ id: w.webhookID, url: w.webhookURL }, 'deleted webhook');
    } else {
      log.warn({ id: w.webhookID, status: res.statusCode }, 'failed to delete webhook');
    }
  }
  return { deleted };
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
 * Each page costs ~100 credits. We cap at 1000 sigs by default; the guard layer
 * will further short-circuit if the daily/monthly budget is approaching.
 */
export async function fetchWalletHistory(
  wallet: string,
  limit = 1000,
): Promise<HeliusEnhancedTx[]> {
  if (config.heliusMode === 'off') {
    log.warn({ wallet }, 'HELIUS_MODE=off; backfill skipped');
    return [];
  }
  if (!config.heliusApiKey) return [];

  const out: HeliusEnhancedTx[] = [];
  let before: string | undefined;
  while (out.length < limit) {
    const url =
      `${HELIUS_API}/v0/addresses/${wallet}/transactions` +
      `?api-key=${config.heliusApiKey}&limit=100${before ? `&before=${before}` : ''}`;
    try {
      const res = await heliusFetch({
        url,
        kind: 'wallet_history',
        note: wallet,
      });
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
      if (err instanceof HeliusGuardError) {
        log.warn({ wallet, reason: err.reason }, `guard blocked backfill: ${err.message}`);
        break;
      }
      log.warn({ err: String(err), wallet }, 'helius history failed');
      break;
    }
  }
  return out.slice(0, limit);
}
