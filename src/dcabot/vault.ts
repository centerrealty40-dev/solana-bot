/**
 * dca_frontrun — DCA vault progress tracking (read-only RPC).
 *
 * The alt-pipeline DCA funds a WSOL "vault" token account that the keeper drains one cycle
 * at a time. We estimate executed cycles from elapsed time × cadence, and read the vault's
 * remaining WSOL balance to detect when the order has ended (drained) — which, if it happens
 * before the planned cycles complete, is treated as an operator early-cancel.
 */
import { rpc } from './rpc.js';

export type VaultStatus = {
  exists: boolean;
  wsolBalance: number | null;
};

export async function vaultStatus(vault: string): Promise<VaultStatus> {
  const bal = await rpc<{ value?: { uiAmount?: number | null } }>('getTokenAccountBalance', [vault]);
  if (bal && bal.value && bal.value.uiAmount != null) {
    return { exists: true, wsolBalance: Number(bal.value.uiAmount) };
  }
  // No balance returned — confirm whether the account still exists at all.
  const info = await rpc<{ value: unknown | null }>('getAccountInfo', [vault, { encoding: 'base64' }]);
  if (info && info.value == null) return { exists: false, wsolBalance: 0 };
  return { exists: true, wsolBalance: null };
}

export type CycleProgress = {
  executed: number;
  ended: boolean;
  earlyCancel: boolean;
};

/**
 * Estimate cycle progress. `executed` is a time × cadence estimate capped at planned.
 * `ended` is true once the vault is drained/closed. `earlyCancel` is true when it ended
 * meaningfully before the planned schedule.
 */
export async function cycleProgress(
  vault: string,
  openTsMs: number,
  cycleFreqSec: number,
  plannedCycles: number,
): Promise<CycleProgress> {
  const elapsedSec = Math.max(0, (Date.now() - openTsMs) / 1000);
  const byTime = cycleFreqSec > 0 ? Math.floor(elapsedSec / cycleFreqSec) : 0;
  const executed = plannedCycles > 0 ? Math.min(plannedCycles, byTime) : byTime;

  const status = await vaultStatus(vault);
  // Drained/closed vault = the order is done spending.
  const ended = !status.exists || (status.wsolBalance != null && status.wsolBalance < 0.01);
  // If it ended well before the schedule should have completed, call it an early cancel.
  const earlyCancel = ended && plannedCycles > 0 && byTime < plannedCycles * 0.9;

  return { executed, ended, earlyCancel };
}
