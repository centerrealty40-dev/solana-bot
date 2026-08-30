# 8zkg shallow branch — buys that fail main turn→dump

## Question

Live miss `72Jp8y…` / `5SfaBM…`: main gate rejected  
`dump=3.74 < floor=7.81` (turn 0.271 → pred 17.8).  
Is that a **separate entry branch**, and what is its formula?

## Split (8zkg dip buys with turn)

| set | n | share |
|---|---|---|
| all dip+turn | 915 | 100% |
| **main formula pass** (α=-5.08, β=6.86, slack 10/12) | 805 | 88% |
| fail | 110 | 12% |
| **too shallow** (resid &lt; −10) | **63** | **7%** |
| too deep | 47 | 5% |

Shallow-fail is real volume, not noise. Classes: shallow 21 / mild_shallow 19 / mild_deep 23.  
Only **27%** sit in our live `h1_red_shallow` band → **not** “just h1_red”.

## Finding: same family, flatter curve

On the **shallow-fail** set, dump still tracks turn (pearson **0.69**), but coeffs differ:

| fit | formula | ±8 cov |
|---|---|---|
| main (pass set) | `dump ≈ −3.47 + 6.10·log1p(turn·100)` | 91% |
| **shallow branch** | `dump ≈ −8.83 + 4.23·log1p(turn·100)` | **97%** |
| live main canon | `−5.08 + 6.86·log…` | — |

Dump p50 by turn (**shallow branch only**):

| turn | dump p50 |
|---|---|
| 0.15–0.40 | **4.3%** |
| 0.40–1.0 | **10.5%** |
| ≥1.0 | **14.2%** |

vs main-pass at turn 0.15–0.40 p50 was ~14%+ — this branch buys **much shallower** at the same turn.

## Dual-gate coverage (8zkg)

```text
MAIN:    pred1 = -5.08 + 6.86·log1p(turn·100)
         keep if pred1-10 ≤ dump ≤ pred1+12

SHALLOW: pred2 = -8.83 + 4.23·log1p(turn·100)
         keep if pred2-8 ≤ dump ≤ pred2+8

entry if MAIN or SHALLOW
```

| rule | n | share of 915 |
|---|---|---|
| main only | 805 | 88% |
| + shallow±8 | **866** | **94.6%** |
| shallow-only adds | **+61** | +6.7% |

Leave-one-mint on shallow-fail for shallow±8: **96.6%** (39 mints).

## Live miss check (`72Jp8y…`)

| | |
|---|---|
| turn / dump | 0.271 / **3.74%** |
| main pred / floor | 17.81 / 7.81 → **FAIL** |
| shallow pred / band ±8 | **5.28** / [−2.7, 13.3] → **PASS** |

## 7BNax (same author family)

Shallow-fail n=99, fit `≈ −10.48 + 4.32·log…`, pearson **0.70**, ±8 cov 95%.  
L2 shallow coeffs on L1 shallow-fail ±8: **98%** — same branch shape, slightly different α.

## Rejected as primary for this branch

| hyp | why |
|---|---|
| only `h1_red` (h1≤−15 & dump 3–10) | covers ~27% of shallow-fails |
| flat dump band only (e.g. 2–12) | works as floor (~81–90%) but loses turn structure |
| “bug / random” | pearson 0.69 + dual-leader match |

## Confidence

| claim | |
|---|---|
| Separate branch from main turn→dump | **high** |
| Still `dump = a + b·log(turn)`, lower β | **high** |
| Exact α/β = −8.83 / 4.23 | **medium** (n=63; re-fit as n grows) |
| OR-gate with main recovers ~95% of his dips | **high** |

## Artifacts

- `leader-shallow-branch.json`
- `scripts-tmp/milddip-reverse-leader-shallow-branch.py`
