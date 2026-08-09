/**
 * Watchdog for stream resolve blindness.
 * When buy-mint-resolve drops most of the firehose, we are flying blind —
 * alert loudly (console + Telegram) instead of waiting for the user to ask.
 */
import { sendTagged } from '../core/telegram/sender.js';

export type StreamResolveSnapshot = {
  resolved: number;
  failed: number;
  droppedOverflow: number;
  droppedStale: number;
  queued: number;
  volumeMarks: number;
};

export type StreamHealthVerdict = {
  blind: boolean;
  reasons: string[];
};

/** Pure decision — unit-tested. */
export function evaluateStreamResolveHealth(
  prev: StreamResolveSnapshot | null,
  cur: StreamResolveSnapshot,
  gates: {
    /** Overflow drops in the window that trigger blind. */
    overflowDeltaWarn: number;
    /** overflow/(overflow+resolved) in window ≥ this → blind. */
    overflowRatioWarn: number;
    /** Min events in window before ratio applies. */
    minEvents: number;
  },
): StreamHealthVerdict {
  if (!prev) return { blind: false, reasons: [] };
  const dOverflow = Math.max(0, cur.droppedOverflow - prev.droppedOverflow);
  const dResolved = Math.max(0, cur.resolved - prev.resolved);
  const dStale = Math.max(0, cur.droppedStale - prev.droppedStale);
  const reasons: string[] = [];
  if (dOverflow >= gates.overflowDeltaWarn) {
    reasons.push(`resolve_overflow_delta=${dOverflow}>=${gates.overflowDeltaWarn}`);
  }
  const denom = dOverflow + dResolved;
  if (denom >= gates.minEvents) {
    const ratio = dOverflow / denom;
    if (ratio >= gates.overflowRatioWarn) {
      reasons.push(
        `resolve_drop_ratio=${(ratio * 100).toFixed(0)}%>=${(gates.overflowRatioWarn * 100).toFixed(0)}% ` +
          `(drop=${dOverflow} ok=${dResolved})`,
      );
    }
  }
  if (cur.queued >= 40 && dResolved === 0 && dOverflow + dStale > 0) {
    reasons.push(`resolve_stalled queued=${cur.queued} resolved_delta=0`);
  }
  return { blind: reasons.length > 0, reasons };
}

let lastAlertAtMs = 0;
let prevSnap: StreamResolveSnapshot | null = null;

/** Test helper. */
export function __resetStreamHealthWatchdogForTests(): void {
  lastAlertAtMs = 0;
  prevSnap = null;
}

export async function maybeAlertStreamResolveBlind(args: {
  snap: StreamResolveSnapshot;
  nowMs?: number;
  cooldownMs?: number;
  enabled?: boolean;
  overflowDeltaWarn?: number;
  overflowRatioWarn?: number;
  minEvents?: number;
  send?: typeof sendTagged;
}): Promise<{ blind: boolean; alerted: boolean; reasons: string[] }> {
  const nowMs = args.nowMs ?? Date.now();
  const enabled = args.enabled !== false;
  const cooldownMs = args.cooldownMs ?? 10 * 60_000;
  const verdict = evaluateStreamResolveHealth(prevSnap, args.snap, {
    overflowDeltaWarn: args.overflowDeltaWarn ?? 2_000,
    overflowRatioWarn: args.overflowRatioWarn ?? 0.85,
    minEvents: args.minEvents ?? 200,
  });
  prevSnap = { ...args.snap };

  if (!verdict.blind) {
    return { blind: false, alerted: false, reasons: [] };
  }

  const line =
    `[mild-dip] STREAM BLIND WARN resolve overflow — ` +
    `reasons=${verdict.reasons.join('; ')} | ` +
    `totals resolved=${args.snap.resolved} overflow=${args.snap.droppedOverflow} ` +
    `stale=${args.snap.droppedStale} queued=${args.snap.queued} volMarks=${args.snap.volumeMarks}`;
  console.error(line);

  if (!enabled) {
    return { blind: true, alerted: false, reasons: verdict.reasons };
  }
  if (lastAlertAtMs > 0 && cooldownMs > 0 && nowMs - lastAlertAtMs < cooldownMs) {
    return { blind: true, alerted: false, reasons: verdict.reasons };
  }

  const send = args.send ?? sendTagged;
  const text =
    `vol-green / mild-dip STREAM BLIND — buy-mint-resolve dropping the firehose.\n` +
    `We will miss leader-sized PumpSwap buys (no mint in logs).\n` +
    `reasons:\n- ${verdict.reasons.join('\n- ')}\n` +
    `totals: resolved=${args.snap.resolved} overflow=${args.snap.droppedOverflow} ` +
    `queued=${args.snap.queued} volMarks=${args.snap.volumeMarks}\n` +
    `Action: raise MILD_DIP_BUY_MINT_RESOLVE_MAX_PER_MIN / concurrency, ` +
    `enable VOL_GREEN_LEADER_WATCH=1 for cheap leader discovery.`;

  const ok = await send('ALERT', 'VOL_GREEN_STREAM', text, { disablePreview: true });
  if (ok) lastAlertAtMs = nowMs;
  return { blind: true, alerted: ok, reasons: verdict.reasons };
}
