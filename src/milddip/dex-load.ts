/**
 * Mild-dip Dex/mark load signals — when Oscar's shared DexScreener gate
 * cannot keep up with open books, alert the operator (plan move to idle VPS).
 */
import { sendTagged } from '../core/telegram/sender.js';

export type MildDipMarkPassStats = {
  openCount: number;
  markPassMs: number;
  markedOk: number;
  markedNull: number;
  markIntervalMs: number;
  markCacheTtlMs: number;
};

export type MildDipLoadAlertGates = {
  /** Alert when a mark pass takes longer than this (default 20s). */
  markPassWarnMs: number;
  /** Alert when open count reaches this with a slow pass (default 35). */
  openWarnCount: number;
  /** Null-mark ratio ≥ this (0–1) with enough samples (default 0.4). */
  nullRatioWarn: number;
};

export type MildDipLoadVerdict = {
  overloaded: boolean;
  reasons: string[];
};

/** Pure overload decision — unit-tested. */
export function evaluateMildDipDexLoad(
  stats: MildDipMarkPassStats,
  gates: MildDipLoadAlertGates,
): MildDipLoadVerdict {
  const reasons: string[] = [];
  const total = stats.markedOk + stats.markedNull;
  const nullRatio = total > 0 ? stats.markedNull / total : 0;
  const slowFloor = Math.max(gates.markPassWarnMs, stats.markIntervalMs * 2);

  if (stats.openCount >= 5 && stats.markPassMs >= slowFloor) {
    reasons.push(
      `mark_pass_slow=${stats.markPassMs}ms>=${slowFloor}ms open=${stats.openCount}`,
    );
  }
  if (stats.openCount >= gates.openWarnCount && stats.markPassMs >= stats.markIntervalMs) {
    reasons.push(
      `open_pressure=${stats.openCount}>=${gates.openWarnCount} markPass=${stats.markPassMs}ms`,
    );
  }
  if (stats.openCount >= 5 && total >= 5 && nullRatio >= gates.nullRatioWarn) {
    reasons.push(
      `mark_null_ratio=${(nullRatio * 100).toFixed(0)}%>=${(gates.nullRatioWarn * 100).toFixed(0)}% ` +
        `(ok=${stats.markedOk} null=${stats.markedNull})`,
    );
  }

  return { overloaded: reasons.length > 0, reasons };
}

let lastAlertAtMs = 0;

/** Test helper. */
export function __resetMildDipDexLoadAlertForTests(): void {
  lastAlertAtMs = 0;
}

/**
 * If overloaded, log + Telegram ALERT (cooldown). Returns whether an alert was sent.
 */
export async function maybeAlertMildDipDexLoad(args: {
  stats: MildDipMarkPassStats;
  gates: MildDipLoadAlertGates;
  cooldownMs: number;
  enabled: boolean;
  nowMs?: number;
  send?: typeof sendTagged;
}): Promise<{ overloaded: boolean; alerted: boolean; reasons: string[] }> {
  const nowMs = args.nowMs ?? Date.now();
  const verdict = evaluateMildDipDexLoad(args.stats, args.gates);
  if (!verdict.overloaded) {
    return { overloaded: false, alerted: false, reasons: [] };
  }

  const line =
    `[mild-dip] DEX LOAD WARN open=${args.stats.openCount} ` +
    `markPass=${args.stats.markPassMs}ms interval=${args.stats.markIntervalMs}ms ` +
    `cacheTtl=${args.stats.markCacheTtlMs}ms ok=${args.stats.markedOk} null=${args.stats.markedNull} ` +
    `reasons=${verdict.reasons.join('; ')} — consider dedicated VPS if sustained`;
  console.warn(line);

  if (!args.enabled) {
    return { overloaded: true, alerted: false, reasons: verdict.reasons };
  }
  if (args.cooldownMs > 0 && nowMs - lastAlertAtMs < args.cooldownMs) {
    return { overloaded: true, alerted: false, reasons: verdict.reasons };
  }

  const send = args.send ?? sendTagged;
  const text =
    `mild-dip Dex/mark pressure on shared Oscar gate.\n` +
    `open=${args.stats.openCount} markPass=${args.stats.markPassMs}ms ` +
    `(interval=${args.stats.markIntervalMs}ms cacheTtl=${args.stats.markCacheTtlMs}ms)\n` +
    `marks ok=${args.stats.markedOk} null=${args.stats.markedNull}\n` +
    `reasons:\n- ${verdict.reasons.join('\n- ')}\n` +
    `If this repeats → move mild-dip-bot to the idle VPS (own Dex IP/budget).`;

  const ok = await send('ALERT', 'MILD_DIP_DEX', text, { disablePreview: true });
  if (ok) lastAlertAtMs = nowMs;
  return { overloaded: true, alerted: ok, reasons: verdict.reasons };
}
