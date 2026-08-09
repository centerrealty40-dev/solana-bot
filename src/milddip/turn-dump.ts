/**
 * 8zkg-style turn→dump entry gate (dual branch).
 *
 * MAIN (1.11.773):   pred = -5.08 + 6.86·log1p(turn·100), band [pred−10, pred+12]
 * SHALLOW (1.11.777): pred = -8.83 + 4.23·log1p(turn·100), band [pred−8, pred+8]
 *
 * turn = vol5m / liq
 * dump = −pc5m  (positive depth %)
 *
 * Pass if MAIN or SHALLOW matches. Prefer MAIN when both pass.
 */

export type TurnDumpBranch = 'main' | 'shallow';

export type TurnDumpGateConfig = {
  enabled: boolean;
  alpha: number;
  beta: number;
  /** MAIN: reject if dump < pred − this (pp). Default 10 (slip buffer). */
  shallowSlackPct: number;
  /** MAIN: reject if dump > pred + this (pp). 0 = off. Default 12. */
  deepSlackPct: number;
  /** 1.11.777 — second flatter curve for scrapes that miss MAIN. */
  shallowBranchEnabled?: boolean;
  shallowAlpha?: number;
  shallowBeta?: number;
  /** SHALLOW half-width ± this (pp). Default 8. */
  shallowBandPct?: number;
};

export type TurnDumpGateVerdict = {
  pass: boolean;
  /** Which curve accepted the print (null when fail / gate off). */
  branch: TurnDumpBranch | null;
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

function evaluateBand(args: {
  dump: number;
  turn: number;
  alpha: number;
  beta: number;
  floorSlack: number;
  ceilSlack: number;
  branch: TurnDumpBranch;
}): { pass: boolean; pred: number; resid: number; reasons: string[] } {
  const pred = predictDumpDepthPct(args.turn, args.alpha, args.beta);
  const resid = args.dump - pred;
  const floor = pred - Math.max(0, args.floorSlack);
  const reasons: string[] = [];
  if (args.dump < floor) {
    reasons.push(
      `turn_dump_${args.branch}_shallow dump=${args.dump.toFixed(2)}<floor=${floor.toFixed(2)} pred=${pred.toFixed(2)} turn=${args.turn.toFixed(4)}`,
    );
    return { pass: false, pred, resid, reasons };
  }
  if (args.ceilSlack > 0) {
    const ceil = pred + args.ceilSlack;
    if (args.dump > ceil) {
      reasons.push(
        `turn_dump_${args.branch}_deep dump=${args.dump.toFixed(2)}>ceil=${ceil.toFixed(2)} pred=${pred.toFixed(2)} turn=${args.turn.toFixed(4)}`,
      );
      return { pass: false, pred, resid, reasons };
    }
  }
  reasons.push(
    `turn_dump_ok branch=${args.branch} dump=${args.dump.toFixed(2)} pred=${pred.toFixed(2)} resid=${resid.toFixed(2)} turn=${args.turn.toFixed(4)}`,
  );
  return { pass: true, pred, resid, reasons };
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
  shallowBranchEnabled?: boolean;
  shallowAlpha?: number;
  shallowBeta?: number;
  shallowBandPct?: number;
}): TurnDumpGateVerdict {
  if (!args.enabled) {
    return {
      pass: true,
      branch: null,
      dump: null,
      turn: null,
      pred: null,
      resid: null,
      reasons: ['turn_dump_gate_off'],
    };
  }

  const pc = args.pc5m;
  if (pc == null || !Number.isFinite(pc)) {
    return {
      pass: false,
      branch: null,
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
      branch: null,
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
      branch: null,
      dump,
      turn,
      pred: null,
      resid: null,
      reasons: ['turn_dump_missing_turn'],
    };
  }

  const main = evaluateBand({
    dump,
    turn,
    alpha: args.alpha,
    beta: args.beta,
    floorSlack: args.shallowSlackPct,
    ceilSlack: args.deepSlackPct,
    branch: 'main',
  });
  if (main.pass) {
    return {
      pass: true,
      branch: 'main',
      dump,
      turn,
      pred: main.pred,
      resid: main.resid,
      reasons: main.reasons,
    };
  }

  if (args.shallowBranchEnabled) {
    const band = Math.max(0, args.shallowBandPct ?? 8);
    const shallow = evaluateBand({
      dump,
      turn,
      alpha: args.shallowAlpha ?? -8.83,
      beta: args.shallowBeta ?? 4.23,
      floorSlack: band,
      ceilSlack: band,
      branch: 'shallow',
    });
    if (shallow.pass) {
      return {
        pass: true,
        branch: 'shallow',
        dump,
        turn,
        pred: shallow.pred,
        resid: shallow.resid,
        reasons: [...main.reasons, ...shallow.reasons],
      };
    }
    return {
      pass: false,
      branch: null,
      dump,
      turn,
      pred: shallow.pred,
      resid: shallow.resid,
      reasons: [...main.reasons, ...shallow.reasons],
    };
  }

  return {
    pass: false,
    branch: null,
    dump,
    turn,
    pred: main.pred,
    resid: main.resid,
    reasons: main.reasons,
  };
}
