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
    ['VOL_GREEN_QUOTE_PREMIUM_GUARD_PCT', 'MILD_DIP_QUOTE_PREMIUM_GUARD_PCT'],
    ['VOL_GREEN_EXIT_ARM_PCT', 'MILD_DIP_EXIT_ARM_PCT'],
    ['VOL_GREEN_EXIT_GIVEBACK_PCT', 'MILD_DIP_EXIT_GIVEBACK_PCT'],
    ['VOL_GREEN_EXIT_PARTIAL_SELL_FRACTION', 'MILD_DIP_EXIT_PARTIAL_SELL_FRACTION'],
    ['VOL_GREEN_EXIT_SECOND_GIVEBACK_PCT', 'MILD_DIP_EXIT_SECOND_GIVEBACK_PCT'],
    ['VOL_GREEN_EXIT_MIN_MFE_BEFORE_TRAIL_PCT', 'MILD_DIP_EXIT_MIN_MFE_BEFORE_TRAIL_PCT'],
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
    ['VOL_GREEN_MAX_ENRICH', 'MILD_DIP_MAX_ENRICH'],
    ['VOL_GREEN_ENRICH_BUDGET_MS', 'MILD_DIP_ENRICH_BUDGET_MS'],
    ['VOL_GREEN_GREEN_MIN_VOLUME_5M_USD', 'MILD_DIP_GREEN_MIN_VOLUME_5M_USD'],
    ['VOL_GREEN_GREEN_MIN_TURNOVER_5M', 'MILD_DIP_GREEN_MIN_TURNOVER_5M'],
    ['VOL_GREEN_GREEN_MIN_BUY_SELL_5M', 'MILD_DIP_GREEN_MIN_BUY_SELL_5M'],
    ['VOL_GREEN_GREEN_MAX_PC5M_PCT', 'MILD_DIP_GREEN_MAX_PC5M_PCT'],
    ['VOL_GREEN_GREEN_MIN_MCAP_USD', 'MILD_DIP_GREEN_MIN_MCAP_USD'],
  ];
  for (const [from, to] of aliases) copyAlias(from, to);

  // Helius: prefer HELIUS_RPC_URL when VOL_GREEN_RPC_URL / MILD_DIP_RPC_URL unset.
  if (!env.MILD_DIP_RPC_URL?.trim() && env.HELIUS_RPC_URL?.trim()) {
    env.MILD_DIP_RPC_URL = env.HELIUS_RPC_URL.trim();
  }

  // Default green_tape — leader-like green candle (awakening still available via env).
  setIfAbsent('MILD_DIP_ENTRY_MODE', env.VOL_GREEN_ENTRY_MODE?.trim() || 'green_tape');
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

  // Tape entry ignores dump dip band — widen so mild-dip schema validation passes.
  setIfAbsent('MILD_DIP_MIN_DIP_PCT', '-100');
  setIfAbsent('MILD_DIP_MAX_DIP_PCT', '100');
  setIfAbsent('MILD_DIP_STREAM_DIP_ENTRY', '0');
  setIfAbsent('MILD_DIP_MAX_COOLDOWN_BOUNCE_PCT', '0');

  // Trail: hold a bit more drawdown (3→5 giveback); 50% peel then wider 2nd rung.
  setIfAbsent('MILD_DIP_EXIT_ARM_PCT', '5');
  setIfAbsent('MILD_DIP_EXIT_GIVEBACK_PCT', '5');
  setIfAbsent('MILD_DIP_EXIT_PARTIAL_SELL_FRACTION', '0.5');
  setIfAbsent('MILD_DIP_EXIT_SECOND_GIVEBACK_PCT', '8');
  // Unlock trail earlier so we peel on real micro-pumps instead of only stale-cutting.
  setIfAbsent('MILD_DIP_EXIT_MIN_MFE_BEFORE_TRAIL_PCT', '8');
  setIfAbsent('MILD_DIP_EXIT_NEVER_ARM_PATIENCE_MS', '0');
  setIfAbsent('MILD_DIP_EXIT_NEVER_ARM_DEAD_MIN_MS', '900000');
  setIfAbsent('MILD_DIP_EXIT_NEVER_ARM_DEAD_PNL_PCT', '15');
  setIfAbsent('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_MIN_MS', '600000');
  setIfAbsent('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_RATIO', '0.35');
  setIfAbsent('MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_FLOOR_USD', '500');
  setIfAbsent('MILD_DIP_EXIT_NEVER_ARM_MAX_HOLD_MS', '5400000');
  // False-green: wait longer (75→150s); first hit peels 50%, second at 2× dumps rest.
  setIfAbsent('MILD_DIP_EXIT_NEVER_ARM_STALE_MIN_MS', '150000');
  setIfAbsent('MILD_DIP_EXIT_NEVER_ARM_STALE_MAX_MFE_PCT', '5');

  setIfAbsent('MILD_DIP_ALLOWED_DEX_IDS', 'pumpswap,pumpfun,raydium');
  setIfAbsent('MILD_DIP_DISCOVER_SOURCES', 'stream');
  setIfAbsent('MILD_DIP_STREAM', '1');
  // Fast tape loop: was conc=4 / probe=48 / scan=5s → enrich 25–40s lag vs leaders.
  setIfAbsent('MILD_DIP_ENRICH_CONCURRENCY', '10');
  setIfAbsent('MILD_DIP_PROBE_ENRICH_MAX', '20');
  setIfAbsent('MILD_DIP_MAX_ENRICH', '14');
  // 22s: hard probe cap 24 @180 RPM ≈8–12s + HTTP; was 15s → constant over-budget.
  setIfAbsent('MILD_DIP_ENRICH_BUDGET_MS', '22000');
  setIfAbsent('MILD_DIP_SCAN_INTERVAL_MS', '2000');
  setIfAbsent('MILD_DIP_FORCE_ENRICH_FIRST_SEEN_PER_MIN', '6');
  // PumpSwap Buy logs often omit mint — getTx resolve so we see candles ourselves.
  setIfAbsent('MILD_DIP_BUY_MINT_RESOLVE_MAX_PER_MIN', '40');
  setIfAbsent('MILD_DIP_BUY_MINT_RESOLVE_CONCURRENCY', '3');
  setIfAbsent('DEXSCREENER_GLOBAL_MAX_RPM', '180');
  setIfAbsent('DEXSCREENER_MAX_RPM', '180');
  // Block Dex-green / local-red (goon dip-buy).
  setIfAbsent('MILD_DIP_GREEN_SHORT_RED_WINDOW_MS', '60000');
  setIfAbsent('MILD_DIP_JOURNAL_ENTRY_SKIPS', '1');
  setIfAbsent('DEX_QUOTE_CACHE_ENABLED', '0');
  setIfAbsent('MILD_DIP_SLIPPAGE_BPS', '500');
  // Chase: allow up to 5% fill drift; hops≥3 still blocked (closed-set loss bucket).
  setIfAbsent('MILD_DIP_MAX_CHASE_PCT', '5');
  setIfAbsent('LIVE_BUY_MAX_CHASE_PCT', '5');
  setIfAbsent('MILD_DIP_QUOTE_PREMIUM_GUARD_PCT', '12');
  setIfAbsent('LIVE_BUY_MAX_PRICE_IMPACT_PCT', '2');
  setIfAbsent('LIVE_BUY_MAX_ROUTE_HOPS', '3');
  setIfAbsent('MILD_DIP_MIN_FEE_SOL_RESERVE', '0.02');
  setIfAbsent('MILD_DIP_MIN_LIQUIDITY_USD', '15000');
  setIfAbsent('MILD_DIP_MIN_VOLUME_5M_USD', '1500');
  setIfAbsent('MILD_DIP_MINT_COOLDOWN_MS', '300000');
  setIfAbsent('MILD_DIP_LOSS_COOLDOWN_MS', '600000');

  // Green-tape floors loosened for micro-cap verticals (CHiHkQx: mcap~$20k, liq null/$9k).
  setIfAbsent('MILD_DIP_GREEN_MIN_LIQUIDITY_USD', '8000');
  setIfAbsent('MILD_DIP_GREEN_MIN_MCAP_USD', '18000');
  // Structural floor; rocket-tier vol bypasses age (enter ~with leaders).
  setIfAbsent('MILD_DIP_GREEN_MIN_PAIR_AGE_HOURS', '0.01');
  // 0 = no max age — 8zkg often hits aged runners (HORSE ~450h, MIM ~500h).
  setIfAbsent('MILD_DIP_GREEN_MAX_PAIR_AGE_HOURS', '0');
  // 4h RCA: soft greens + exhausted rockets without bs = never_arm_stale dumps.
  // Impulse: clearer green + buy pressure (was 12/bs1.0).
  setIfAbsent('MILD_DIP_GREEN_IMPULSE_MIN_PC5M_PCT', '18');
  setIfAbsent('MILD_DIP_GREEN_IMPULSE_MAX_PC5M_PCT', '0');
  setIfAbsent('MILD_DIP_GREEN_IMPULSE_MIN_VOLUME_5M_USD', '3000');
  setIfAbsent('MILD_DIP_GREEN_IMPULSE_MIN_BUY_SELL_5M', '1.2');
  setIfAbsent('MILD_DIP_GREEN_IMPULSE_MIN_TURNOVER_5M', '0.05');
  // Liquid: no soft 8–12% noise.
  setIfAbsent('MILD_DIP_GREEN_LIQUID_MIN_PC5M_PCT', '12');
  setIfAbsent('MILD_DIP_GREEN_LIQUID_MIN_VOLUME_5M_USD', '2500');
  setIfAbsent('MILD_DIP_GREEN_LIQUID_MIN_TURNOVER_5M', '0.1');
  setIfAbsent('MILD_DIP_GREEN_LIQUID_MIN_BUY_SELL_5M', '1.15');
  setIfAbsent('MILD_DIP_GREEN_LIQUID_MAX_PC5M_PCT', '25');
  // Mid-band liquid: hotter tape.
  setIfAbsent('MILD_DIP_GREEN_LIQUID_MID_PC5M_LO', '12');
  setIfAbsent('MILD_DIP_GREEN_LIQUID_MID_PC5M_HI', '25');
  setIfAbsent('MILD_DIP_GREEN_LIQUID_MID_MIN_BUY_SELL_5M', '1.4');
  setIfAbsent('MILD_DIP_GREEN_LIQUID_MID_MIN_TURNOVER_5M', '0.18');
  // Early OFF (0 = path disabled) — soft thin tape was noise.
  setIfAbsent('MILD_DIP_GREEN_EARLY_MIN_PC5M_PCT', '0');
  setIfAbsent('MILD_DIP_GREEN_EARLY_MIN_VOLUME_5M_USD', '400');
  setIfAbsent('MILD_DIP_GREEN_EARLY_MIN_TURNOVER_5M', '0.02');
  setIfAbsent('MILD_DIP_GREEN_EARLY_MIN_BUY_SELL_5M', '2.5');
  setIfAbsent('MILD_DIP_GREEN_EARLY_MAX_PC5M_PCT', '25');
  setIfAbsent('MILD_DIP_GREEN_EARLY_MIN_MCAP_USD', '18000');
  // Rocket: only real verticals with pressure (was pc12/bs1.1/vol10k).
  setIfAbsent('MILD_DIP_GREEN_ROCKET_MIN_PC5M_PCT', '25');
  setIfAbsent('MILD_DIP_GREEN_ROCKET_MAX_PC5M_PCT', '0');
  setIfAbsent('MILD_DIP_GREEN_ROCKET_MIN_VOLUME_5M_USD', '15000');
  setIfAbsent('MILD_DIP_GREEN_ROCKET_MIN_TURNOVER_5M', '0.25');
  setIfAbsent('MILD_DIP_GREEN_ROCKET_MIN_BUY_SELL_5M', '1.35');
  setIfAbsent('MILD_DIP_GREEN_ROCKET_MIN_MCAP_USD', '18000');
  // Extreme chase: block weak-bs verticals; allow leader-like (E6cBb6 bs≈1.39 / +163%).
  setIfAbsent('MILD_DIP_GREEN_EXTREME_PC5M_PCT', '100');
  setIfAbsent('MILD_DIP_GREEN_EXTREME_MIN_BUY_SELL_5M', '1.35');
  // liquid_tape: fat/aged books when Dex pc5m lags (WW) — ring-green in discover.
  // Does not raise enrich caps; only re-labels already-probed mints.
  setIfAbsent('MILD_DIP_GREEN_LIQUID_TAPE_MIN_LIQUIDITY_USD', '25000');
  setIfAbsent('MILD_DIP_GREEN_LIQUID_TAPE_MIN_PAIR_AGE_HOURS', '1');
  setIfAbsent('MILD_DIP_GREEN_LIQUID_TAPE_MIN_VOLUME_5M_USD', '1200');
  setIfAbsent('MILD_DIP_GREEN_LIQUID_TAPE_MIN_PC5M_PCT', '-2');
  setIfAbsent('MILD_DIP_GREEN_LIQUID_TAPE_MAX_PC5M_PCT', '40');
  setIfAbsent('MILD_DIP_GREEN_LIQUID_TAPE_MIN_BUY_SELL_5M', '0.85');
  setIfAbsent('MILD_DIP_GREEN_LIQUID_TAPE_MIN_RING_PC5M_PCT', '5');
}

export const VOL_GREEN_DEFAULT_WALLET_PUBKEY = FXQF;
