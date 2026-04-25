from pathlib import Path
import re

path = Path("/opt/solana-alpha/scripts-tmp/live-paper-trader.ts")
s = path.read_text()

# Ensure OpenTrade has partial fields
if "remainingPct: number;" not in s:
    s = s.replace(
        "  trailingArmed: boolean;\n}",
        "  trailingArmed: boolean;\n  remainingPct: number;\n  realizedPnlPct: number;\n  tp1Done: boolean;\n  tp2Done: boolean;\n}",
    )

# Ensure new opens initialize partial fields
s = s.replace(
    "trailingArmed: false,",
    "trailingArmed: false,\n      remainingPct: 1, realizedPnlPct: 0, tp1Done: false, tp2Done: false,",
)

# Replace legacy exit block in trackerTick
legacy = re.compile(
    r"""(?P<indent>\s+)let exitReason: ExitReason \| null = null;\n\s+if \(x >= TP_X\) exitReason = 'TP';\n\s+else if \(x <= SL_X\) exitReason = 'SL';\n\s+else if \(ot\.trailingArmed && cur\.mc <= ot\.peakMcUsd \* \(1 - TRAIL_DROP\)\) exitReason = 'TRAIL';\n\s+else if \(ageH >= TIMEOUT_HOURS\) exitReason = 'TIMEOUT';\n\n\s+if \(exitReason\) \{\n\s+const ct: ClosedTrade = \{ \.\.\.ot, exitTs: Date\.now\(\), exitMcUsd: cur\.mc, exitReason, pnlPct, durationMin: ageH \* 60 \};\n\s+open\.delete\(mint\); closed\.push\(ct\); stats\.closed\[exitReason\]\+\+;\n\s+append\(\{ kind: 'close', \.\.\.ct \}\);\n\s+const arrow = pnlPct >= 0 \? '\+' : '';\n\s+console\.log\(`\[\$\{exitReason\}\] \$\{mint\.slice\(0, 8\)\} \$\$\{ot\.symbol\}  pnl=\$\{arrow\}\$\{pnlPct\.toFixed\(0\)\}%  ` \+\n\s+`peak=\+\$\{ot\.peakPnlPct\.toFixed\(0\)\}%  age=\$\{ageH\.toFixed\(1\)\}h`\);\n\s+\}""",
    re.M,
)

replacement = """
    // backward compatibility for old open records
    if (ot.remainingPct == null) ot.remainingPct = 1;
    if (ot.realizedPnlPct == null) ot.realizedPnlPct = 0;
    if (ot.tp1Done == null) ot.tp1Done = false;
    if (ot.tp2Done == null) ot.tp2Done = false;

    // partial TP ladder: 25% @ x3, 50% @ x5
    if (!ot.tp1Done && x >= TP1_X && ot.remainingPct > 0) {
      const sold = Math.min(TP1_SELL_PCT, ot.remainingPct);
      ot.realizedPnlPct += sold * (TP1_X - 1) * 100;
      ot.remainingPct -= sold;
      ot.tp1Done = true;
      append({ kind: 'partial-close', mint, level: 'TP1', soldPct: sold, x: TP1_X, remainingPct: ot.remainingPct, realizedPnlPct: ot.realizedPnlPct });
      console.log(`[TP1] ${mint.slice(0, 8)} sold=${(sold * 100).toFixed(0)}% @${TP1_X}x rem=${(ot.remainingPct * 100).toFixed(0)}%`);
    }

    if (!ot.tp2Done && x >= TP2_X && ot.remainingPct > 0) {
      const sold = Math.min(TP2_SELL_PCT, ot.remainingPct);
      ot.realizedPnlPct += sold * (TP2_X - 1) * 100;
      ot.remainingPct -= sold;
      ot.tp2Done = true;
      append({ kind: 'partial-close', mint, level: 'TP2', soldPct: sold, x: TP2_X, remainingPct: ot.remainingPct, realizedPnlPct: ot.realizedPnlPct });
      console.log(`[TP2] ${mint.slice(0, 8)} sold=${(sold * 100).toFixed(0)}% @${TP2_X}x rem=${(ot.remainingPct * 100).toFixed(0)}%`);
    }

    let exitReason: ExitReason | null = null;
    if (ot.remainingPct <= 0) exitReason = 'TP';
    else if (x <= SL_X) exitReason = 'SL';
    else if (ot.trailingArmed && cur.mc <= ot.peakMcUsd * (1 - TRAIL_DROP)) exitReason = 'TRAIL';
    else if (ageH >= TIMEOUT_HOURS) exitReason = 'TIMEOUT';

    if (exitReason) {
      const totalPnlPct = (ot.realizedPnlPct || 0) + (ot.remainingPct || 0) * pnlPct;
      const ct: ClosedTrade = { ...ot, exitTs: Date.now(), exitMcUsd: cur.mc, exitReason, pnlPct: totalPnlPct, durationMin: ageH * 60 };
      open.delete(mint); closed.push(ct); stats.closed[exitReason]++;
      append({ kind: 'close', ...ct });
      const arrow = totalPnlPct >= 0 ? '+' : '';
      console.log(`[${exitReason}] ${mint.slice(0, 8)} $${ot.symbol}  pnl=${arrow}${totalPnlPct.toFixed(0)}%  ` +
                  `peak=+${ot.peakPnlPct.toFixed(0)}%  age=${ageH.toFixed(1)}h  rem=${((ot.remainingPct || 0) * 100).toFixed(0)}%`);
    }
"""

new_s, n = legacy.subn(replacement.strip("\n"), s, count=1)
if n != 1:
    raise SystemExit("LEGACY_EXIT_BLOCK_NOT_FOUND")
s = new_s

# Banner line in main
s = s.replace(
    "console.log(`window: [${WINDOW_START_MIN}..${DECISION_AGE_MIN}] min  exit: TP=${TP_X}x SL=${SL_X}x TRAIL=-${TRAIL_DROP * 100}% from peak (after ${TRAIL_TRIGGER_X}x)  TIMEOUT=${TIMEOUT_HOURS}h`);",
    "console.log(`window: [${WINDOW_START_MIN}..${DECISION_AGE_MIN}] min  exit: TP1=${TP1_X}x@${TP1_SELL_PCT * 100}% TP2=${TP2_X}x@${TP2_SELL_PCT * 100}% SL=${SL_X}x TRAIL=-${TRAIL_DROP * 100}% (after ${TRAIL_TRIGGER_X}x) TIMEOUT=${TIMEOUT_HOURS}h`);",
)

path.write_text(s)
print("OK")
