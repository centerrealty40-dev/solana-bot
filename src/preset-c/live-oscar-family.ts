/** Main Live Oscar process (PG dip discovery). */
export const LIVE_OSCAR_MAIN_STRATEGY_ID = 'live-oscar';

/** Preset C — Telegram dips pullback entry, SuperBot wallet, isolated PM2. */
export const LIVE_OSCAR_PRESET_C_STRATEGY_ID = 'live-oscar-preset-c';

/** SuperBot / Preset C execution wallet (public only). */
export const LIVE_OSCAR_PRESET_C_WALLET_PUBKEY =
  'HcV3BhmKQN5hhFWiKWoRfzuYM2C6ftPjqQC67wo27DDo';

export function isLiveOscarMainStrategyId(strategyId: string): boolean {
  return strategyId === LIVE_OSCAR_MAIN_STRATEGY_ID;
}

export function isLiveOscarPresetCStrategyId(strategyId: string): boolean {
  return strategyId === LIVE_OSCAR_PRESET_C_STRATEGY_ID;
}

/** Shared tracker / wave B / mcap-tier / staged-entry behavior. */
export function isLiveOscarTradingStrategyId(strategyId: string): boolean {
  return isLiveOscarMainStrategyId(strategyId) || isLiveOscarPresetCStrategyId(strategyId);
}
