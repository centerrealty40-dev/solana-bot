/**
 * 8zkg-style turn→dump entry gate.
 *
 * pred_dump = alpha + beta * log1p(turn * 100)
 * turn = vol5m / liq
 * dump = -pc5m  (positive depth %)
 *
 * Default mode (CF winner): reject when dump is too shallow vs pred
 * (resid = dump - pred < -shallowSlack). Optional deep ceiling.
 */

export type TurnDumpGateConfig = {
  enabled: boolean;
  alpha: number;
  beta: number;
  /** Reject if dump < pred − this (pp). Default 8. */
  shallowSlackPct: number;
  /** Reject if dump > pred + this (pp). 0 = off. Default 12. */
  deepSlackPct: number;
};

export type TurnDumpGateVerdict = {
  pass: boolean;
  dump: number | null;
  turn: number | null;
  pred: number | null;
  resid: number | null;
  reasons: string[];
};

export function predictDumpDepthPct(turn: number, alpha: number, beta: number): number {
  return alpha + beta * Math.log1p(turn * 100);
}

export function turnover5mLiq(
  volume5mUsd: number | null | undefined,
  liquidityUsd: number | null | undefined,
): number | null {
  if (volume5mUsd == null || liquidityUsd == null) return null;
  if (!(liquidityUsd > 0) || !(volume5mUsd >= 0)) return null;
  return volume5mUsd / liquidityUsd;
}

/**
 * `pc5m` is Dex/stream price-change % (negative on dump).
 * Uses the signed change as dump depth when red.
 */
export function evaluateTurnDumpGate(args: {
  enabled: boolean;
  pc5m: number | null | undefined;
  volume5mUsd: number | null | undefined;
  liquidityUsd: number | null | undefined;
  alpha: number;
  beta: number;
  shallowSlackPct: number;
  deepSlackPct: number;
}): TurnDumpGateVerdict {
  if (!args.enabled) {
    return {
      pass: true,
      dump: null,
      turn: null,
      pred: null,
      resid: null,
      reasons: ['turn_dump_gate_off'],
    };
  }

  const reasons: string[] = [];
  const pc = args.pc5m;
  if (pc == null || !Number.isFinite(pc)) {
    return {
      pass: false,
      dump: null,
      turn: null,
      pred: null,
      resid: null,
      reasons: ['turn_dump_missing_pc5m'],
    };
  }
  if (!(pc < 0)) {
    return {
      pass: false,
      dump: -pc,
      turn: null,
      pred: null,
      resid: null,
      reasons: [`turn_dump_not_red_pc5m=${pc.toFixed(2)}`],
    };
  }

  const dump = -pc;
  const turn = turnover5mLiq(args.volume5mUsd, args.liquidityUsd);
  if (turn == null || !(turn > 0)) {
    return {
      pass: false,
      dump,
      turn,
      pred: null,
      resid: null,
      reasons: ['turn_dump_missing_turn'],
    };
  }

  const pred = predictDumpDepthPct(turn, args.alpha, args.beta);
  const resid = dump - pred;
  const shallowFloor = pred - Math.max(0, args.shallowSlackPct);
  if (dump < shallowFloor) {
    reasons.push(
      `turn_dump_shallow dump=${dump.toFixed(2)}<floor=${shallowFloor.toFixed(2)} pred=${pred.toFixed(2)} turn=${turn.toFixed(4)}`,
    );
    return { pass: false, dump, turn, pred, resid, reasons };
  }

  if (args.deepSlackPct > 0) {
    const deepCeil = pred + args.deepSlackPct;
    if (dump > deepCeil) {
      reasons.push(
        `turn_dump_deep dump=${dump.toFixed(2)}>ceil=${deepCeil.toFixed(2)} pred=${pred.toFixed(2)} turn=${turn.toFixed(4)}`,
      );
      return { pass: false, dump, turn, pred, resid, reasons };
    }
  }

  reasons.push(
    `turn_dump_ok dump=${dump.toFixed(2)} pred=${pred.toFixed(2)} resid=${resid.toFixed(2)} turn=${turn.toFixed(4)}`,
  );
  return { pass: true, dump, turn, pred, resid, reasons };
}
