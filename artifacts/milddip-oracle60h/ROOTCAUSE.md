# Why we lose on normal up/down hills (60h)

## One-line answer

The bot **makes money when the trade actually reverses** (MFE≥5% → **+$790** on 1122 cycles) and **bleeds it all on entries into dumps that never bounce** (MFE&lt;5% → **−$898** on 518 cycles). Net **−$109**.

This is not “exits are broken” and not “hills are untradeable”. We **buy continuing declines**, not bottoms.

## Evidence

| Bucket | n | PnL |
|--------|--:|----:|
| Armed (MFE ≥ 5%) | 1122 | **+$789.52** |
| Never-armed (MFE &lt; 5%) | 518 | **−$898.06** |
| of which true wrong-side (marks never saw +5% after) | 517 | **−$898.07** |
| missed bounce (sold before +5%) | 1 | ~0 |

Of ring-covered entries: **91%** still printed a **deeper bottom within 3 minutes** after our buy (p50 further −3.6%). We are systematically early on the knife.

Never-arm exits: `never_arm_stale` / `vol_fade` / `dead` / `bounce` / `time_red` — death by grind, not “forgot to sell the top”.

## wait_dip is the clearest cartoon

| | n | PnL |
|--|--:|----:|
| wait_dip armed | 200 | **+$422** |
| wait_dip never-arm | 106 | **−$471** |
| wait_dip net | 319 | **−$49** |

Same branch: when the dump **stops**, it pays; when the hill **keeps rolling**, wait_dip buys more red and dies. Dip≠bottom.

## What “buy low sell high” would require

Today we trigger on **dip** (price went down).  
We need trigger on **turn** (went down **and** started up). Stabilize tries; still −$73 never-arm on that lane alone. wait_dip/dex often buy with **no reclaim**.

Oracle on covered set (buy pre-trough, sell post-peak): **+$332** vs actual **−$11** on same mints — edge exists in the path; our entry clock is wrong.

## Not the main story

- Bank-then-sleeve net-red: 140 cycles **−$115** (real, secondary).  
- Noisy gate shaving (768): cut +$198 / avoid −$238 → rejected.  
- Time rebuy bans: wrong tool; would miss real turns.
