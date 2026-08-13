# mild-dip known-good baseline

**Tag:** `milddip-good-baseline-1.11.915`
**Commit:** `abc39755`
**Marked:** 2026-08-13 20:03 UTC, at the user's request

```bash
git reset --hard milddip-good-baseline-1.11.915
```

This is the first revision where the entry gate lines up with a large share of
the leaders' entries and the exit gets us out on the bounce rather than into the
red candle. Anything that regresses either of those two properties should be
compared against this tag before it ships.

## What the baseline contains

**A leader holding the name overrides the fitted priors.** Every threshold in the
entry gate was fitted on the population of coins we have no other evidence about.
A leader inside the name is other evidence, so for leader-seen mints these stand
down: the 6h pair-age floor, the $40k 5m volume ceiling, the 0.06 turnover floor
and the 0.25 ceiling, the 30s knife-stabilize defer, and the knife branch. The
−4% dip ceiling widens to flat — green candles stay out, since that is what the
ceiling was for.

The leader-seen flag is read from our own memory rather than inferred from which
wake happened to find the coin, and the wait-dip refloor re-check reads it too.
Both of those were silent holes: `ELiQoVM9` was rejected 239 times on
`structural_fail` while `8zkgFGVZ` turned $149.57 into $249.73 on it in 23
minutes.

**The ladder no longer caps a runner.** 8%/50% rungs with a 20% remainder floor
used to liquidate the bag on the third rung, +24%, so a coin that went +67% could
not pay more than about +14% blended. The ladder now stands down at the floor and
the 12% giveback trail carries the last slice.

**Two-basis accounting.** Gains are measured from the higher of fill and entry
mark, losses from the lower, so a stale mark cannot manufacture profit and then
trigger a profit-taking exit into a real loss.

**The jump guard quarantines single-tick moves** until a different feed, or the
same feed with a different value, confirms them. An identical re-read is not
confirmation.

**Exits and entries share one brain.** A soft exit is deferred while the entry
gate would still buy the same coin, on a per-position time budget, with a 10s
floor between sell legs on one mint.

## Known open problem

We are still not making money. Entries match the leaders and the bounce exits
work, so the leak is somewhere between the two. Finding it is the next task; it
is not a reason to move off this baseline.
