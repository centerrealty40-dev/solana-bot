/**
 * Mint'ы без market-alert в Telegram (spike + dips). Не затрагивает live-oscar / discovery / торговлю.
 */
export const TELEGRAM_MARKET_ALERT_BLOCKED_MINTS = new Set<string>([
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
  'HfMbPyDdZH6QMaDDUokjYCkHxzjoGBMpgaUvpLWGbF5p', // PBTC / Purple Bitcoin
]);

export function isTelegramMarketAlertMintBlocked(mint: string): boolean {
  return TELEGRAM_MARKET_ALERT_BLOCKED_MINTS.has(mint.trim());
}
