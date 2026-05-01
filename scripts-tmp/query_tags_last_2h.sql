-- Snapshot: tags touched vs new wallets (last 2 hours, server local time = DB now())

WITH tw AS (
  SELECT now() - interval '2 hours' AS t0
),
new_wallets AS (
  SELECT w.address
  FROM wallets w, tw v
  WHERE w.first_seen_at >= v.t0
),
tags_in_window AS (
  SELECT wt.wallet, wt.tag, wt.source, wt.added_at
  FROM wallet_tags wt, tw v
  WHERE wt.added_at >= v.t0
),
stats AS (
  SELECT
    (SELECT count(*) FROM new_wallets) AS new_wallet_rows,
    (SELECT count(DISTINCT wallet) FROM tags_in_window) AS distinct_wallets_tag_touched,
    (SELECT count(*) FROM tags_in_window) AS tag_row_events,
    (SELECT count(DISTINCT wallet)
     FROM new_wallets nw
     INNER JOIN tags_in_window t ON t.wallet = nw.address) AS new_wallets_with_tag_touch
  FROM tw
)
SELECT * FROM stats;

-- Breakdown by tag (rows in window; same wallet can appear in multiple tags)
SELECT tag, source, count(*) AS rows, count(DISTINCT wallet) AS distinct_wallets
FROM wallet_tags wt, (SELECT now() - interval '2 hours' AS t0) v
WHERE wt.added_at >= v.t0
GROUP BY tag, source
ORDER BY rows DESC;

-- New wallets only: how many got at least one tag row in window, by tag
SELECT t.tag, t.source, count(DISTINCT t.wallet) AS new_wallets_with_this_tag
FROM wallet_tags t
JOIN wallets w ON w.address = t.wallet
CROSS JOIN (SELECT now() - interval '2 hours' AS t0) v
WHERE w.first_seen_at >= v.t0
  AND t.added_at >= v.t0
GROUP BY t.tag, t.source
ORDER BY new_wallets_with_this_tag DESC;
