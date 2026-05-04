-- One-off pilot diagnostics for sa-grws (avoid psql -c quoting over SSH).
SELECT 'total_sa_grws' AS k, count(*)::text AS v
FROM wallets WHERE metadata @> '{"collector_id":"sa-grws"}'::jsonb
UNION ALL
SELECT 'last_24h', count(*)::text
FROM wallets WHERE metadata @> '{"collector_id":"sa-grws"}'::jsonb
  AND first_seen_at >= now() - interval '24 hours'
UNION ALL
SELECT 'last_7d', count(*)::text
FROM wallets WHERE metadata @> '{"collector_id":"sa-grws"}'::jsonb
  AND first_seen_at >= now() - interval '7 days'
UNION ALL
SELECT 'since_utc_midnight', count(*)::text
FROM wallets WHERE metadata @> '{"collector_id":"sa-grws"}'::jsonb
  AND first_seen_at >= ((current_timestamp AT TIME ZONE 'utc')::date AT TIME ZONE 'utc')
UNION ALL
SELECT 'first_seen_min', coalesce(min(first_seen_at)::text, '')
FROM wallets WHERE metadata @> '{"collector_id":"sa-grws"}'::jsonb
UNION ALL
SELECT 'first_seen_max', coalesce(max(first_seen_at)::text, '')
FROM wallets WHERE metadata @> '{"collector_id":"sa-grws"}'::jsonb;
