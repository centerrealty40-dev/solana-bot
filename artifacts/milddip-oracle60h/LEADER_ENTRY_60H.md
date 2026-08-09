# 60h: leader entry pattern on OUR buys

Not copy-wallet. Filter = his measured entry recipe applied as keep/skip on mild-dip FIFO cycles.

**Actual book: −$108.54 (n=1780).** Context (pc5m+vol5m+liq): 1779/1780.  
**Missing vs full 8zkg audit:** `vol1h/mcap` not in extract — used `turn5m = vol5m/liq` + `pc5m`.

## Where we buy vs where he earns

| | Ours (p50) | His profitable entry |
|--|--:|--|
| pc5m | **−12.4%** | best **−5…−1%** |
| share in his best pc band | **6.2%** | — |
| share pc ≤ −15 (too deep) | **34%** | avoid |
| turn5m < 0.09 (dead pool) | **30%** | reject |

## A. Our PnL by pc5m band

| pc5m | n | PnL | armed | never |
|------|--:|----:|------:|------:|
| (−5,−1] his best | 111 | −$7 | +$35 | −$42 |
| (−8,−5] | 157 | −$26 | +$76 | −$102 |
| (−10,−8] | 240 | −$73 | +$81 | −$154 |
| (−15,−10] | 664 | **+$154** | +$373 | −$218 |
| (−20,−15] | 355 | −$74 | +$159 | −$233 |
| (−25,−20] | 205 | −$90 | +$71 | −$161 |

Deep knives with live turnover still bleed never-arm.

## B. Our PnL by turnover5m

| turn | n | PnL |
|------|--:|----:|
| <0.09 dead | 536 | −$24 |
| 0.09–0.14 | 298 | −$14 |
| 0.14–0.21 | 239 | +$8 |
| 0.21–0.39 | 266 | −$27 |
| ≥0.39 | 440 | −$52 |

Turnover alone does not save us — we still enter too deep.

## C. CF: keep only leader-like entries

| Keep rule | keep n | keep $ | Δ vs actual |
|-----------|-------:|-------:|------------:|
| turn≥0.09 | 1243 | −$84 | +$25 |
| turn≥0.14 | 945 | −$70 | +$38 |
| pc (−5,−1] only | 111 | −$7 | +$102 |
| pc > −15 (reject deep) | 1173 | **+$49** | **+$157** |
| **turn≥0.09 & pc > −15** | **683** | **+$59** | **+$167** |
| **turn≥0.14 & pc > −15** | **449** | **+$68** | **+$177** |
| turn≥0.09 & pc (−15,−5] | 648 | +$39 | +$147 |
| turn≥0.09 & pc (−8,−1] (closest to him) | 104 | −$5 | +$103 |

Closest pure-him band (−8,−1]∩live: only 104 trades, still ~flat — sample tiny + never-arm still eats.

## Verdict

1. We are **not** entering like him: median **−12%** red vs his **−5…−1%**.
2. On our book, his recipe adapts to: **live pool (`turn≥0.09`) + no deeper than −15%**. That flips 60h to **+$59…+$68**.
3. Hole remains never-arm on whatever we keep — entry filter helps, does not replace turn-confirm.

Artifact: `cf-leader-entry-60h.json`
