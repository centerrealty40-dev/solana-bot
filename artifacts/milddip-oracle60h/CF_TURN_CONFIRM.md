# CF: DIP ≠ bottom — only confirmed reversal (60h)

Actual book: **−$108.54** / 1780 fills.

## 1. Ceiling (hindsight, not shippable)

Skip every trade that never reached MFE ≥ 5%:

| | PnL |
|--|----:|
| Keep armed only | **+$789.52** |
| Δ vs actual | **+$898** |
| win cut / lose avoided | $7 / $905 (ratio **135**) |

This is the prize if we could detect “will reverse” vs “still dumping” at entry. Proves the edge is **entry selection**, not “hills untadeable”.

## 2. Causal turn at fill (ring known)

Only **~182–190** fills have enough pre-fill ring to test rising ticks.

Require last 3 ticks rising at fill; if unknown → keep actual:

- Book → **−$40.64** (Δ **+$68**)
- On the known subset: **−$34.55 → +$33**

Real, but covers ~10% of trades (marks mostly exist only after we’re already in).

## 3. Delay entry until turn (park, then buy)

Using post-signal marks, wait ≤30–180s for bounce+rising, else skip.

**Does not work as a winner on this journal:**

- When a bounce *does* come, turn prints **~4% higher** than live entry (p50), 93% of the time → late to the move.
- Cohort CF on trades with watch marks: delayed sim often **worse** than the live fill on the same names (you already bought the better price live).
- Rules that look like +$100 full-book Δ mostly mean “almost never enter” (0–15 fills) — not a strategy.

## 4. Attempt-field proxies (full coverage, still noisy)

| Rule | PnL | Δ | ratio | churn |
|------|----:|--:|------:|------:|
| wait_dip only (−15,−10] | −$13 | +$95 | 1.22 | ~$967 |
| PROXY wait_sweet+stab+h1 | +$28 | +$137 | 1.26 | ~$1200 |
| PROXY2 tighter | +$39 | +$148 | 1.26 | ~$1267 |

Positive Δ but **same noise class** as rejected 768 (cut hundreds of wins to avoid slightly more losses). Not “confirmed reversal”.

## Verdict

| Question | Answer |
|----------|--------|
| Is dip≠bottom the right diagnosis? | **Yes** — perfect skip of never-arm → +$790 |
| Does “wait for rising ticks after signal” CF well here? | **No** — late entry eats winners; sparse pre-buy ring |
| What’s missing to CF/ship for real? | **Watch the mint and require reclaim *before* fill**, with dense marks on candidates — not filter after we’re already long |

Next implementation that matches the diagnosis (not another skip-noise gate): on dip signal → park → buy only on trough age + bounce + N rising ticks (like stabilize), for wait/dex too; measure live arm-rate, not journal delay-from-fill.
