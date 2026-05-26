#!/bin/bash
set -uo pipefail
cd /opt/solana-alpha
set -a && . ./.env && set +a

# Common base — production exit canon, runner enabled, A+ both modes
BASE_ENV() {
  export PAPER_RUNNER_MODE_ENABLED=1
  export PAPER_RUNNER_MIN_PG_SAMPLES_24H=36
  export PAPER_RUNNER_MIN_MCAP_USD=1000000
  export PAPER_RUNNER_MAX_MCAP_USD=30000000
  export PAPER_RUNNER_MIN_LIQ_USD=80000
  export PAPER_RUNNER_MIN_VOL_1H_USD=80000
  export PAPER_RUNNER_MIN_VOL_12H_USD=400000
  export PAPER_RUNNER_VELOCITY_MIN_X=1.5
  export PAPER_RUNNER_MIN_VOL_5M_PEAK_1H_USD=20000
  export PAPER_RUNNER_BS_1H_MIN=0.95
  export PAPER_RUNNER_BS_12H_MIN=1.0
  export PAPER_RUNNER_LIQ_VS_P25_MIN=0.85
  export PAPER_RUNNER_PRICE_HOLD_MIN=0.6
  export PAPER_RUNNER_STALE_VOL_RATIO_MAX=0.5

  export PAPER_POLICY_A_PLUS_ENABLED=1
  export PAPER_POLICY_A_PLUS_BOUNCE_FROM_MIN_30M_MAX_PCT=2.5
  export PAPER_POLICY_A_PLUS_PRICE_CHANGE_1H_MIN_PCT=-20
  export PAPER_POLICY_A_PLUS_VOL_1H_MAX_USD=1000000
  export PAPER_POLICY_A_PLUS_PRICE_CHANGE_WINDOW_MIN=15
  export PAPER_POLICY_A_PLUS_PRICE_CHANGE_30M_MIN_PCT=-10

  export PAPER_STRATEGY_KIND=dip
  export PAPER_STRATEGY_ID=live-oscar
  export PAPER_TP_GRID_STEP_PNL=0.05
  export PAPER_TP_GRID_SELL_FRACTION=0.10
  export PAPER_TP_GRID_SELL_FRACTION_PROFILE=0.10,0.30,0.50,0.70,0.70
  export PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL=0.03
  export PAPER_TP_LADDER=
  export PAPER_DCA_LEVELS=
  export PAPER_DCA_KILLSTOP=-0.25
  export PAPER_TIMEOUT_HOURS=48
  export PAPER_TRAIL_MODE=ladder_retrace
  export PAPER_TRAIL_DROP=0.10
  export PAPER_TRAIL_TRIGGER_X=1.05
  export PAPER_TP_X=100
  export PAPER_SL_X=0
  export PAPER_LIVE_OSCAR_BREAKEVEN_TRIM_AFTER_FIRST_TP_ENABLED=1
  export PAPER_LIVE_OSCAR_BREAKEVEN_TRIM_FRACTION=0.5
  export PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B=1
  export PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B_TRAIL_SELL_FRACTION=0.20
  export PAPER_LIVE_EXIT_MODE_AB=0
  export PAPER_LIVE_STAGED_ENTRY_ENABLED=0
}

echo "=== TEST A: Hardened runner thresholds (velocity>=2.0, bs1h>=1.3), 14d, A+ both ==="
BASE_ENV
export PAPER_RUNNER_VELOCITY_MIN_X=2.0
export PAPER_RUNNER_BS_1H_MIN=1.3
WINDOW_DAYS=14 npx tsx scripts-tmp/runner-canon-backtest.ts --days 14 --step-min 30 --policy-a-plus both --notional 500 > /tmp/runner-bt-A-hardened-14d.log 2>&1
echo "TEST A done. Last summary:"
grep -E '^(##|- )' /tmp/runner-bt-A-hardened-14d.log | tail -30

echo ""
echo "=== TEST B: Default runner thresholds, 19d (full PG retention), A+ both ==="
BASE_ENV
WINDOW_DAYS=19 npx tsx scripts-tmp/runner-canon-backtest.ts --days 19 --step-min 30 --policy-a-plus both --notional 500 > /tmp/runner-bt-B-default-19d.log 2>&1
echo "TEST B done. Last summary:"
grep -E '^(##|- )' /tmp/runner-bt-B-default-19d.log | tail -30

echo ""
echo "=== TEST C: Default runner thresholds, TRAIL-only exit (no TP-ladder), 14d, A+ both ==="
BASE_ENV
# Disable TP-ladder by zeroing sell fractions (TP-rungs may fire but sell 0%)
export PAPER_TP_GRID_STEP_PNL=0.05
export PAPER_TP_GRID_SELL_FRACTION=0.0
export PAPER_TP_GRID_SELL_FRACTION_PROFILE=0,0,0,0,0
export PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL=0.5
export PAPER_LIVE_OSCAR_BREAKEVEN_TRIM_AFTER_FIRST_TP_ENABLED=0
# Switch trail to peak-based (independent of TP-ladder)
export PAPER_TRAIL_MODE=peak
export PAPER_TRAIL_DROP=0.10
export PAPER_TRAIL_TRIGGER_X=1.05
WINDOW_DAYS=14 npx tsx scripts-tmp/runner-canon-backtest.ts --days 14 --step-min 30 --policy-a-plus both --notional 500 > /tmp/runner-bt-C-trail-only-14d.log 2>&1
echo "TEST C done. Last summary:"
grep -E '^(##|- )' /tmp/runner-bt-C-trail-only-14d.log | tail -30

echo ""
echo "=== ALL TESTS DONE ==="
