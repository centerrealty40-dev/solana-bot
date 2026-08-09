# Mild-dip 60h bottom/reversal oracle + grid

Window: **1780 buys / 345 mints / ~60h** journal marks.  
Matched-cycle actual ≈ **−$108.54** (FIFO buy→sell legs).

## Verdict

Do **not** cut profitable branches. On this window:

| dipSource | n | pnl |
|-----------|--:|----:|
| stream | 203 | **+$21.49** |
| mild_stabilize | 276 | **+$13.71** |
| wait_dip | 319 | −$48.87 |
| dex | 455 | −$33.64 |
| dex+stream | 309 | −$29.96 |
| h1_red_shallow | 191 | −$23.76 |

Losses are mostly **mid-hill entries** (bounce before the real low) and **shallow h1** (−3…−8%), not “stabilize is bad”.

## DKxHTQ oracle

6 cycles, actual ≈ **−$2.72**.

| # | source | entry | actual | note |
|---|--------|------:|-------:|------|
| 1 | wait_dip | 5.23e-4 | +$0.31 | ok |
| 2 | dex −21% | 4.53e-4 | −$1.50 | still falling |
| 3 | mild_stabilize dump−10 / bounce+4.2 | 5.52e-4 | +$0.74 | shallow dump (new gate would skip) |
| 4 | h1 pc5m=−4.25 | 3.98e-4 | −$2.31 | toxic shallow |
| 5 | mild_stabilize dump−14.5 / bounce+7.4 | 3.19e-4 | +$2.64 | bounce>4 (new gate would skip; was a winner — tradeoff) |
| 6 | h1 pc5m=−7.49 | 2.59e-4 | −$2.58 | toxic shallow |

- Early-trough oracle (buy MAE of first 3m): **+$3.17**
- Perfect local scalper ceiling: **+$3.31** (3 trades)

Ideal path = wait for **deeper dump + rising-tick turn**, skip h1 −3…−8.

## Grid (causal skip-filters on live buys)

Best **without deleting** stabilize/stream:

1. **Ship (1.11.768):** stabilize dump≤−12 + bounce≤4 + h1 band (−15,−8] → **≈ +$50** vs actual  
2. Heuristic turn_confirm + stabilize_tight + h1≤−10 → **≈ +$100** (more skips when ring known)  
3. Blind “deepen all dex to −12” **hurts** (skips net-positive dex fills) — do not ship  
4. Non-causal “delay if better” looked like +$400 — **look-ahead**, not shippable

## Shipped strategy (1.11.768)

Keep all branches; tighten bottom detection:

- `mild_stabilize`: dump `(−25,−12]`, bounce `[1.5,4]`, trough age 25s, **3 rising ticks**
- `h1_red_shallow`: pc5m `(−15,−8]`

Script: `scripts-tmp/milddip-bottom-oracle-grid-60h.py`
