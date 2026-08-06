/**
 * Map VOL_GREEN_* → MILD_DIP_* so vol-green-bot reuses the mild-dip loop/exit
 * stack with awakening entry + isolated state paths + FxQf wallet.
 */
import path from 'node:path';

const FXQF = 'FxQfFTmj6xfjbzE2LcXteJMjd1KpBjMhH9nzEiijUGHX';

function setIfAbsent(key: string, value: string): void {
  const cur = process.env[key]?.trim();
  if (cur) return;
  process.env[key] = value;
}

function copyAlias(from: string, to: string): void {
  const v = process.env[from]?.trim();
  if (!v) return;
  if (!process.env[to]?.trim()) process.env[to] = v;
}

/** Call once at process start before `loadMildDipConfig()`. */
export function bootstrapVolGreenEnv(env: NodeJS.ProcessEnv = process.env): void {
  // Prefer VOL_GREEN_* aliases when set.
  const aliases: Array<[string, string]> = [
    ['VOL_GREEN_EXECUTION_MODE', 'MILD_DIP_EXECUTION_MODE'],
    ['VOL_GREEN_WALLET_SECRET', 'MILD_DIP_WALLET_SECRET'],
    ['VOL_GREEN_WALLET_PUBKEY', 'MILD_DIP_WALLET_PUBKEY'],
    ['VOL_GREEN_POSITION_USD', 'MILD_DIP_POSITION_USD'],
    ['VOL_GREEN_RPC_URL', 'MILD_DIP_RPC_URL'],
    ['VOL_GREEN_JOURNAL_PATH', 'MILD_DIP_JOURNAL_PATH'],
    ['VOL_GREEN_STATE_PATH', 'MILD_DIP_STATE_PATH'],
    ['VOL_GREEN_HOT_MINTS_PATH', 'MILD_DIP_HOT_MINTS_PATH'],
    ['VOL_GREEN_PRICE_RING_PATH', 'MILD_DIP_PRICE_RING_PATH'],
    ['VOL_GREEN_MAX_OPEN_POSITIONS', 'MILD_DIP_MAX_OPEN_POSITIONS'],
    ['VOL_GREEN_SLIPPAGE_BPS', 'MILD_DIP_SLIPPAGE_BPS'],
    ['VOL_GREEN_MAX_CHASE_PCT', 'MILD_DIP_MAX_CHASE_PCT'],
    ['VOL_GREEN_EXIT_ARM_PCT', 'MILD_DIP_EXIT_ARM_PCT'],
    ['VOL_GREEN_EXIT_GIVEBACK_PCT', 'MILD_DIP_EXIT_GIVEBACK_PCT'],
    ['VOL_GREEN_EXIT_NEVER_ARM_PATIENCE_MS', 'MILD_DIP_EXIT_NEVER_ARM_PATIENCE_MS'],
    ['VOL_GREEN_EXIT_NEVER_ARM_MAX_HOLD_MS', 'MILD_DIP_EXIT_NEVER_ARM_MAX_HOLD_MS'],
    ['VOL_GREEN_EXIT_NEVER_ARM_DEAD_MIN_MS', 'MILD_DIP_EXIT_NEVER_ARM_DEAD_MIN_MS'],
    ['VOL_GREEN_EXIT_NEVER_ARM_DEAD_PNL_PCT', 'MILD_DIP_EXIT_NEVER_ARM_DEAD_PNL_PCT'],
    ['VOL_GREEN_EXIT_NEVER_ARM_VOL_FADE_MIN_MS', 'MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_MIN_MS'],
    ['VOL_GREEN_EXIT_NEVER_ARM_VOL_FADE_RATIO', 'MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_RATIO'],
    ['VOL_GREEN_EXIT_NEVER_ARM_VOL_FADE_FLOOR_USD', 'MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_FLOOR_USD'],
    ['VOL_GREEN_ALLOWED_DEX_IDS', 'MILD_DIP_ALLOWED_DEX_IDS'],
    ['VOL_GREEN_DISCOVER_SOURCES', 'MILD_DIP_DISCOVER_SOURCES'],
    ['VOL_GREEN_STREAM', 'MILD_DIP_STREAM'],
    ['VOL_GREEN_MIN_FEE_SOL_RESERVE', 'MILD_DIP_MIN_FEE_SOL_RESERVE'],
  ];
  for (const [from, to] of aliases) copyAlias(from, to);

  // Helius: prefer HELIUS_RPC_URL when VOL_GREEN_RPC_URL / MILD_DIP_RPC_URL unset.
  if (!env.MILD_DIP_RPC_URL?.trim() && env.HELIUS_RPC_URL?.trim()) {
    env.MILD_DIP_RPC_URL = env.HELIUS_RPC_URL.trim();
  }

  setIfAbsent('MILD_DIP_ENTRY_MODE', env.VOL_GREEN_ENTRY_MODE?.trim() || 'awakening');
  setIfAbsent('MILD_DIP_APP_NAME', env.VOL_GREEN_APP_NAME?.trim() || 'vol-green-bot');
  setIfAbsent('MILD_DIP_EXECUTION_MODE', 'live');
  setIfAbsent('MILD_DIP_POSITION_USD', '5');
  setIfAbsent('MILD_DIP_WALLET_PUBKEY', FXQF);
  setIfAbsent(
    'MILD_DIP_WALLET_SECRET',
    path.join('data', 'live', 'copy-8zkg.keypair.json'),
  );
  setIfAbsent('MILD_DIP_JOURNAL_PATH', path.join('data', 'volgreen', 'journal.jsonl'));
  setIfAbsent('MILD_DIP_STATE_PATH', path.join('data', 'volgreen', 'state.json'));
  setIfAbsent('MILD_DIP_HOT_MINTS_PATH', path.join('data', 'volgreen', 'hot-mints.json'));
  setIfAbsent('MILD_DIP_PRICE_RING_PATH', path.join('data', 'volgreen', 'price-ring.json'));

  // Awakening entry ignores dip band — widen so mild-dip schema validation passes.
  setIfAbsent('MILD_DIP_MIN_DIP_PCT', '-100');
  setIfAbsent('MILD_DIP_MAX_DIP_PCT', '100');
  setIfAbsent('MILD_DIP_STREAM_DIP_ENTRY', '0');
  setIfAbsent('MILD_DIP_MAX_COOLDOWN_BOUNCE_PCT', '0');

  // Mirror mild-dip prod exit defaults (canary).
  setIfAbsent('MILD_DIP_EXIT_ARM_PCT', '8');
  setIfAbsent('MILD_DIP_EXIT_GIVEBACK_PCT', '6');
  setIfAbsent('MILD_DIP_EXIT_NEVER_ARM_PATIENCE_MS', '0');
  setIfAbsent('MILD_DIP_EXIT_NEVER_ARM_DEAD_MIN_MS', '900000');
  setIfAbsent('MILD_DIP_EXIT_NEVER_ARM_DEAD_PNL_PCT', '15');
  setIfAbsent('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_MIN_MS', '600000');
  setIfAbsent('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_RATIO', '0.35');
  setIfAbsent('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_FLOOR_USD', '500');
  setIfAbsent('MILD_DIP_EXIT_NEVER_ARM_MAX_HOLD_MS', '5400000');

  setIfAbsent('MILD_DIP_ALLOWED_DEX_IDS', 'pumpswap,pumpfun,raydium');
  // Stream-only universe — boosts/profiles burn Dex RPM before awakening eval.
  setIfAbsent('MILD_DIP_DISCOVER_SOURCES', 'stream');
  setIfAbsent('MILD_DIP_STREAM', '1');
  setIfAbsent('MILD_DIP_ENRICH_CONCURRENCY', '4');
  setIfAbsent('MILD_DIP_SLIPPAGE_BPS', '500');
  setIfAbsent('MILD_DIP_MAX_CHASE_PCT', '4');
  setIfAbsent('MILD_DIP_MIN_FEE_SOL_RESERVE', '0.02');
  setIfAbsent('MILD_DIP_MIN_LIQUIDITY_USD', '15000');
  setIfAbsent('MILD_DIP_MIN_VOLUME_5M_USD', '1500');
  setIfAbsent('MILD_DIP_MINT_COOLDOWN_MS', '300000');
  setIfAbsent('MILD_DIP_LOSS_COOLDOWN_MS', '600000');
}

export const VOL_GREEN_DEFAULT_WALLET_PUBKEY = FXQF;
