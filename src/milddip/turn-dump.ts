/**
 * Turn→dump entry gate — OR live (1.11.793).
 *
 * MAIN:    pred = -5.08 + 6.86·log1p(turn·100), band [pred−10, pred+12]  (8zkg)
 * SHALLOW: pred = -8.83 + 4.23·log1p(turn·100), band [pred−8, pred+8]   (8zkg)
 * KNIFE:   dump ≥ 30 AND turn ≥ 0.30                                   (7BNax OR)
 *
 * turn = vol5m / liq
 * dump = −pc5m  (positive depth %)
 *
 * Live: pass if MAIN or SHALLOW or KNIFE. Prefer MAIN → SHALLOW → KNIFE.
 */

export type TurnDumpBranch = 'main' | 'shallow' | 'knife';

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
  /** 1.11.793 — 7BNax-style deep+hot OR after MAIN|SHALLOW. */
  knifeBranchEnabled?: boolean;
  /** Positive dump depth % floor (default 30 ⇒ pc5m ≤ −30). */
  knifeMinDumpPct?: number;
  /** Min turnover vol5m/liq (default 0.30). */
  knifeMinTurn?: number;
};

export type TurnDumpGateVerdict = {
  pass: boolean;
  /** Which curve/branch accepted the print (null when fail / gate off). */
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

/**
 * Live knife branch at send/final gate: global flag, or a seat that already
 * qualified as hot deep dump on our stream/Dex tape.
 */
export function turnDumpKnifeBranchLive(
  knifeBranchEnabled: boolean,
  opts?: { hotDeepKnifeSeat?: boolean; dipSource?: string | null },
): boolean {
  if (knifeBranchEnabled) return true;
  if (opts?.hotDeepKnifeSeat) return true;
  if (opts?.dipSource === 'turn_dump_knife') return true;
  return false;
}

function evaluateBand(args: {
  dump: number;
  turn: number;
  alpha: number;
  beta: number;
  floorSlack: number;
  ceilSlack: number;
  branch: Exclude<TurnDumpBranch, 'knife'>;
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

export function evaluateTurnDumpKnife(args: {
  dump: number;
  turn: number;
  minDumpPct: number;
  minTurn: number;
}): { pass: boolean; reasons: string[] } {
  const minDump = args.minDumpPct > 0 ? args.minDumpPct : 0;
  const minTurn = args.minTurn > 0 ? args.minTurn : 0;
  if (!(minDump > 0) || !(minTurn > 0)) {
    return { pass: false, reasons: ['turn_dump_knife_off'] };
  }
  if (args.dump + 1e-9 < minDump) {
    return {
      pass: false,
      reasons: [
        `turn_dump_knife_shallow dump=${args.dump.toFixed(2)}<min=${minDump} turn=${args.turn.toFixed(4)}`,
      ],
    };
  }
  if (args.turn + 1e-9 < minTurn) {
    return {
      pass: false,
      reasons: [
        `turn_dump_knife_cold turn=${args.turn.toFixed(4)}<min=${minTurn} dump=${args.dump.toFixed(2)}`,
      ],
    };
  }
  return {
    pass: true,
    reasons: [
      `turn_dump_ok branch=knife dump=${args.dump.toFixed(2)}≥${minDump} turn=${args.turn.toFixed(4)}≥${minTurn}`,
    ],
  };
}

/**
 * 7BNax instant OR: deep dump + hot turnover.
 *
 * Must NOT depend on `evaluateTurnDumpGate(...).branch === 'knife'`.
 * That branch only fires when main/shallow regression bands *fail*;
 * high-turn dumps often classify as `main` first — and those are exactly
 * the seats we want to buy now (EeqYr8 −35% / turn≈1.0 → deep_knife_defer).
 */
export function turnDumpKnifeOrOk(args: {
  enabled: boolean;
  knifeBranchEnabled: boolean;
  pc5m: number | null | undefined;
  volume5mUsd: number | null | undefined;
  liquidityUsd: number | null | undefined;
  minDumpPct: number;
  minTurn: number;
}): { ok: boolean; dump: number | null; turn: number | null } {
  if (!args.enabled || !args.knifeBranchEnabled) {
    return { ok: false, dump: null, turn: null };
  }
  const pc = args.pc5m;
  if (pc == null || !Number.isFinite(pc) || !(pc < 0)) {
    return { ok: false, dump: pc == null || !Number.isFinite(pc) ? null : -pc, turn: null };
  }
  const dump = -pc;
  const turn = turnover5mLiq(args.volume5mUsd, args.liquidityUsd);
  if (turn == null) return { ok: false, dump, turn: null };
  const knife = evaluateTurnDumpKnife({
    dump,
    turn,
    minDumpPct: args.minDumpPct,
    minTurn: args.minTurn,
  });
  return { ok: knife.pass, dump, turn };
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
  knifeBranchEnabled?: boolean;
  knifeMinDumpPct?: number;
  knifeMinTurn?: number;
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

  const reasons: string[] = [];

  const main = evaluateBand({
    dump,
    turn,
    alpha: args.alpha,
    beta: args.beta,
    floorSlack: args.shallowSlackPct,
    ceilSlack: args.deepSlackPct,
    branch: 'main',
  });
  reasons.push(...main.reasons);
  if (main.pass) {
    return {
      pass: true,
      branch: 'main',
      dump,
      turn,
      pred: main.pred,
      resid: main.resid,
      reasons,
    };
  }

  let lastPred = main.pred;
  let lastResid = main.resid;

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
    reasons.push(...shallow.reasons);
    lastPred = shallow.pred;
    lastResid = shallow.resid;
    if (shallow.pass) {
      return {
        pass: true,
        branch: 'shallow',
        dump,
        turn,
        pred: shallow.pred,
        resid: shallow.resid,
        reasons,
      };
    }
  }

  if (args.knifeBranchEnabled) {
    const knife = evaluateTurnDumpKnife({
      dump,
      turn,
      minDumpPct: args.knifeMinDumpPct ?? 30,
      minTurn: args.knifeMinTurn ?? 0.3,
    });
    reasons.push(...knife.reasons);
    if (knife.pass) {
      return {
        pass: true,
        branch: 'knife',
        dump,
        turn,
        pred: lastPred,
        resid: lastResid,
        reasons,
      };
    }
  }

  return {
    pass: false,
    branch: null,
    dump,
    turn,
    pred: lastPred,
    resid: lastResid,
    reasons,
  };
}
