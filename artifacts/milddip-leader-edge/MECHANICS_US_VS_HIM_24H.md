# Us vs leader — buy/sell mechanics (live 24h)

Window ending 2026-08-09 ~17:25 UTC. Our cycles FIFO from `journal.jsonl`; leader from `leader-observer-*.jsonl`.

**Our book 24h: +$154 (776 cycles).** So “топчемся” ≠ только минус за сутки — минус сидит в **ветке never_arm/hard_stop**, плюс в **mfe_bank**.

## How he buys vs how we buy

| | Leader | Us (mild-dip) |
|--|--|--|
| Trigger | Wallet swap whenever — **green + red** (paired: green 78, mild_* 189, deep_knife 50) | Gate on **dip band** (`pc5m` red / wait_dip / stabilize) |
| Adds | Heavy (observer: adds ≫ new bags) | Rare (`leader_align` only near soft exit) |
| Timing vs him (paired n=363) | — | **292/363 later >30s**; only 27 earlier |
| “Cheaper than him” | — | n=62 at **≤−5% vs his fill**, lag med **7m** → we often buy **after** him into more dump |

Cheaper fill ≠ better trade. On pairs where we are >5% below his fill we still only work when the tape turns; when it doesn’t, we sit in never_arm while he already left or is adding.

## How he sells vs how we sell

| | Leader | Us |
|--|--|--|
| Hold med / p75 | **15.2m / 45.6m** | **25.0m / 94.7m** |
| Exit rule | Flat bag when done (no +5% arm) | Must reach **MFE≥~5%** to arm banks; else `never_arm_*` or `hard_stop` |
| When he flats during our hold | n=149, his med hold **17m**, we still hold med **113m** on those | We keep bag for never_arm timers / hope to arm |

### Our exit $ (24h)

| Reason | n | $ |
|--|--:|--:|
| **mfe_bank_2** | 224 | **+$984** |
| **mfe_bank_sleeve** | 199 | **+$257** |
| never_arm_time_red | 102 | **−$221** |
| hard_stop | 81 | **−$236** |
| never_arm_freefall | 39 | **−$227** |
| never_arm_bounce | 69 | **−$153** |
| cliff_dump | 9 | **−$162** |
| **all never_arm\*** | 248 | **−$677** |

Armed path prints. Dead path deletes it.

## Why “заходим ниже + меньше минусов” still doesn’t glue

24h paired tags:

| Pattern | n | Our $ |
|--|--:|--:|
| **He buys while we hold a loser** | 168 | **−$453** |
| He flats while we still hold | 149 | +$114 (we eventually ok on some) |
| We sell, he buys within 1h | 352 | +$186 |

He-buys-our-dump by *our* exit:

- `never_arm_time_red` −$112  
- `hard_stop` −$109  
- `never_arm_bounce` −$72  
- `never_arm_freefall` −$63  

Concrete failure mode:

1. We enter on red (often **after** him, sometimes cheaper).  
2. Tape does not give **+5% MFE** → we cannot arm.  
3. We bleed on `time_red` / `bounce` / `freefall` / `hard_stop` for tens of minutes.  
4. He either already **flat at ~15m** or **buys the dump** (add) and leaves on a later bounce — we are not in his exit machine.

## Code delta (what to change, not copy)

1. **Exit without arm** — he does not need +5% to leave; our never_arm branch is where −$677 lives.  
2. **Hold cap on dead** — his p75 hold ~46m; ours 95m.  
3. **Entry is not the main gap on overlap** — we are already often later/cheaper; fixing only entry depth won’t fix never_arm.  
4. **Adds** — he averages; we almost never (align is narrow).  

Script: `scripts-tmp/milddip-vs-leader-mechanics-24h.py`  
Divergence tags: `data/milddip/leader-divergence-48h-latest.json` on VPS.
