/**
 * Partial exits must leave a tracked runner in `state.open`.
 *
 * Live bug (GZudMdxm, 1.11.763): `mfe_bank_sleeve` sold fraction 0.5 but
 * `executeQueuedSell` only treated peak_giveback_partial / mfe_bank_1/2 as
 * partial → deleted the bag from state → remainder sat unmanaged (−80%).
 * Same hole for `never_arm_bounce` half-cuts (1.11.759).
 *
 * Rule: any successful sell with 0 < fraction < 1 is a runner partial.
 * 1.11.767 — also settle against on-chain remainder (`sell-settle.ts`); a
 * "full" exit that leaves SPL must keep the runner too.
 */
export function isRunnerPartialExit(fraction: number): boolean {
  return Number.isFinite(fraction) && fraction > 0 && fraction < 1 - 1e-12;
}
