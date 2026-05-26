/**
 * Лимиты **wallet-backfill:pilot** из боевого cron детектива.
 *
 * SSOT строк — `scripts/cron/install-detective-data-plane-salpha.sh` (блок SA_ALPHA_DP_BEGIN).
 * При изменении чисел в cron обязательно обновить этот файл и наоборот — см. W6.12 S06 §6.
 */

export type DetectivePilotSlotPreset = {
  /** Стабильный ключ в JSON метрик */
  id: string;
  /** Позиция в crontab (памятка оператору) */
  cronHint: string;
  maxWallets: number;
  sigPagesMax: number;
  maxTxPerWallet: number;
};

export const DETECTIVE_DATA_PLANE_PILOT_PRESETS: readonly DetectivePilotSlotPreset[] = [
  {
    id: 'pilot_0325_utc',
    cronHint: '25 3 * * * wallet-backfill:pilot (утро UTC)',
    maxWallets: 160,
    sigPagesMax: 3,
    maxTxPerWallet: 32,
  },
  {
    id: 'pilot_1517_utc',
    cronHint: '17 15 * * * wallet-backfill:pilot (день UTC)',
    maxWallets: 120,
    sigPagesMax: 3,
    maxTxPerWallet: 28,
  },
];

export function pilotSlotCeilingCredits(slot: DetectivePilotSlotPreset, creditsPerRpc: number): number {
  const cp = Math.max(1, Math.floor(creditsPerRpc));
  return slot.maxWallets * (slot.sigPagesMax + slot.maxTxPerWallet) * cp;
}
