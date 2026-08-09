# Mild-dip 60h: downhill grind = main bleed

## The real problem

Matched book ≈ **−$109** on 1780 buys / 345 mints.

**58 “downhill grind” mints** (entries stair-step lower, net red): **−$279**.  
Of that, **first cycle only −$21**; **rest 376 entries −$258**.

If those rest entries never fired → book ≈ **+$150**.

Pattern (DKx, 7Tw72W, EKppz9, Dz2iVS, DfmUxZ, …): one scrap/reversal prints, then we keep buying **continuation dumps** on the same falling hill. Impulses are skipped by design (dip-only); the bleed is **fake reversals mid-slope**.

## What we will NOT do

- Ban rebuy for X minutes / mint cooldown theater  
- Cut profitable branches (`mild_stabilize` +$14, `stream` +$21 on this window)  
- Blind `dex pc5m ≤ −12` (net ~0)  
- Hard `wait_dump ≤ −12` (cuts ~$280 winner PnL — too much collateral)

## What to ship (evidence only)

### A — already in PR #680 / 1.11.768 (do this)

| Gate | Change | Why |
|------|--------|-----|
| `mild_stabilize` dump | `(−25, −12]` (was −8) | mid-hill −8…−12 stabilize lost |
| `mild_stabilize` bounce | max **4%** (was 8) | chase bounce net-negative |
| trough age | **25s** (was 15s) | don’t buy the wick print |
| rising ticks | last **3** strictly up | turn confirm |
| `h1_red_shallow` | pc5m `(−15, −8]` (was (−10, −3]) | −3…−8 bags (DKx/7Tw72) |

CF: **Δ ≈ +$50**, avoid-loss/win-cut ≈ **1.55**. Branches kept.

### B — next (same idea, wider): turn required when ring knows

When price-ring has samples at decision time: **reject entry if last reclaim ticks are not rising** (same turn test), for `wait_dip` / `dex` / `h1` too — not only stabilize.

CF on top of A: **Δ ≈ +$85**. Still no time ban — only “no buy without a visible turn”.

### C — not ready to ship

Session-high / lower-high filters help downhill rest but mark coverage at entry is sparse (chicken-egg: marks exist mainly while in a bag). Needs live ring on wait/watch mints before we trust it.

## Downhill mint set (top by loss)

| mint | n | pnl | entry decline |
|------|--:|----:|--------------:|
| DfmUxZ | 8 | −33.0 | −66% |
| Dz2iVS | 13 | −22.7 | −40% |
| EKppz9 | 8 | −20.4 | −35% |
| JAX8ZB | 4 | −18.2 | −76% |
| 4pGqQG | 7 | −17.8 | −56% |
| EtxCL9 | 4 | −15.1 | −49% |
| BSiKCM | 13 | −11.8 | −40% |
| … | | | |
| DKxHTQ | 6 | −2.7 | −50% |
| **58 total** | | **−279** | |

Full list: `artifacts/milddip-oracle60h/downhill.json`.

## Strategy in one sentence

Stay dip-only, but **only enter a reclaiming turn** (deeper dump + small bounce + rising ticks). Stop buying red candles that are just the next step down the hill.
