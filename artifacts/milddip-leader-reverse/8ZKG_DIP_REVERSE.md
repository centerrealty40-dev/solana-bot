# 8zkg dip reverse-eng (entry dump depth + exit impulse)

Leader: `8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ`  
Scope: **DIP buys only** (`pc5m < 0`), observer window ~Aug 7–9  
Method: seed trade → hypothesize threshold → train/test + leave-one-mint → next hypothesis  
Artifacts: `8zkg-dip-reverse-v2.json` … `v5.json`

## Sample

| set | n |
|---|---|
| dip buys (with turn) | **897** |
| with marks path d300 | 178 (sparse) |
| sane closed flats (exit) | **52** |
| usable quote slip | **0** |

## ENTRY — rejected: single dump depth

Magic band `dump ≈ X ± 2` coverage on all dip buys:

| X | cov |
|---|---|
| 5% | 27.5% |
| 8% | 19.1% |
| 10% | 17.4% |
| 12% | 16.5% |
| 15% | 12.4% |

Plain absolute bands that soft-converge are wide (`3≤dump≤18` te≈68%) — not a hardcoded single number.

Raw `dump=-pc5m`: **p25=4.45 / p50=9.02 / p75=15.46** (wide).

## ENTRY — converged: dump depth = f(turnover)

`pearson(dump, turn) = 0.70`

### Turn buckets (empirical depths)

| turn (vol5m/liq) | n | dump p25 | **p50** | p75 |
|---|---|---|---|---|
| `< 0.05` | 291 | 2.4 | **4.2** | 6.6 |
| `0.05–0.15` | 291 | 5.8 | **9.0** | 13.1 |
| `0.15–0.40` | 167 | 10.3 | **14.3** | 19.1 |
| `≥ 0.40` | 148 | 15.0 | **21.8** | 33.4 |

### Rules that converge (time split + leave-one-mint)

| rule | te | tr | lom | gap |
|---|---|---|---|---|
| `dump ≈ -5.08 + 6.86·log1p(turn·100) ± 10` | **84.6%** | 87.3% | 84.1% | 2.6 |
| `dump ≈ … ± 12` | **89.5%** | 91.5% | 89.0% | 2.0 |
| piece_loose (turn→dump bands) | **89.1%** | 90.4% | 85.7% | 1.3 |
| piece_3bucket | **82.0%** | 81.5% | 77.2% | 0.5 |
| **train-fit p10–p90 per turn bucket → test** | **75.1%** | 80.6% | 74.2% | 5.5 |

Train-fit OOS bands (honest):

| turn | dump band (train p10–p90) |
|---|---|
| `<0.05` | **1.1 – 8.8** |
| `0.05–0.15` | **3.4 – 16.6** |
| `0.15–0.40` | **6.1 – 27.6** |
| `≥0.40` | **10.7 – 47.2** |

**Claim:** he does not buy “−X% dump” fixed. He buys deeper dumps when 5m turnover is higher. Working formula:

```text
dump_pc5m ≈ -5.08 + 6.86 * log1p(turnover5mLiq * 100)   ± 10 pp
```

Example centers: turn=0.03 → ~4.3%; turn=0.10 → ~9.6%; turn=0.25 → ~14.0%; turn=0.50 → ~17.4%.

### Slip

No usable fill-vs-dex slip on this window (`n=0`). Depth reverse-eng is on **Dex `pc5m`**, not fill slip.

## EXIT — impulse (thin sample, n=52)

| subset | n | p25 | p50 | p75 |
|---|---|---|---|---|
| winners | 30 | +53% | **+86%** | +127% |
| losers | 22 | −59% | **−50%** | −44% |

Converged on this sample (train≈test):

| rule | te | tr |
|---|---|---|
| winners `pnl ≥ +20%` | **93.3%** | 93.3% |
| winners `pnl ≥ +25%` | **93.3%** | 93.3% |
| `TP+20 or SL-20` | **92.3%** | 92.3% |
| losers `pnl ≤ −30%` | ~77% (ladder) | — |

**Claim (provisional, small n):** he does **not** scalp +5/+8 on these dip flats. Winning exits cluster **≥ +20…+25%**; losing exits typically dig to **~−30…−50%**. Hold med ~28m win / ~23m loss — not a fixed 15m clock alone.

Arm+giveback (`MFE≥X & giveback≈Y`) did **not** converge on marks paths.

## What was tried and failed

1. Single dump magic ±2 — max cov 27%.
2. Path d60/d300 magic — coverage sparse; early seeds polluted by junk marks (~98% “depth”).
3. dump+bounce-off-low — lom ~9%.
4. Absolute dump band width≤12 with te≥70 — **0** candidates.
5. Slip-adjusted entry — no slip data.

## Next tighten (if more data)

1. Fill prices / quote slip on observer (currently empty).
2. More closed flats or journal `leader_session_closed` with entry `pc5m` (journal currently has 0 for this leader).
3. Dex OHLCV path for d60/d300 on all 897 buys to re-test path depth vs pc5m.
4. Size as second axis (size≥15 skews shallower: p50 dump 6.3 vs 12.1 for size&lt;5).
