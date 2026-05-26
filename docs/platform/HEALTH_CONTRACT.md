# Platform Health Contract

> Platform version: see `docs/platform/VERSION`.
> Implementation: `scripts/platform/health-check.sh`.

Solo-operator setup means nobody is staring at logs. Each product MUST
expose its freshness in a uniform way so a single cron job can detect
silent breakages and notify the operator.

## Contract

For each `active` or `in-development` product in `products.yaml`, the
`health` block declares one or both of:

```yaml
health:
  file: <absolute_path_to_a_file_that_is_rewritten_on_each_successful_run>
  max_age_min: <integer minutes; alert fires if file mtime is older>
  http: <optional URL; alert fires if GET does not return 2xx within timeout>
```

## Semantics

- **`file`**: any artifact whose `mtime` is updated on every successful
  data refresh. Examples:
  - `/srv/meteora-dash/shared/data/latest.json` (rewritten by hourly
    refresh worker)
  - `/opt/hl-research/data/funding/paper/funding_pipeline_report.json`
    (rewritten by hourly funding pipeline)
  The check is purely on `mtime` vs `now`; we do not parse the file.
  This makes the contract zero-coupling: any product can satisfy it
  by `touch`-ing a file at the end of its job.

- **`http`**: a URL that returns 2xx when the product's frontend is
  serving live data. Used to catch the case "data is fresh on disk
  but the web layer is broken".

- **`max_age_min`**: hard threshold. We only alert on transitions
  (healthy -> stale or stale -> healthy), not on every cron tick.

## Alerting

`health-check.sh` writes a per-product status file under
`/var/lib/platform-health/<product_key>.state` with content
`OK` / `STALE` / `DOWN`.

If the state changes between runs and Telegram credentials are
configured (env vars `PLATFORM_TG_BOT_TOKEN`, `PLATFORM_TG_CHAT_ID`),
the script sends a Telegram message describing the transition.

State transitions:

- `OK -> STALE`: file is older than `max_age_min`.
- `OK -> DOWN`: HTTP probe failed (and was previously OK).
- `STALE -> OK`: file mtime is fresh again.
- `DOWN -> OK`: HTTP probe is 2xx again.
- Any first-time observation does NOT alert (avoid alert storm on
  initial deploy / new product).

## Recommended cron

Run every 10 minutes:

```cron
*/10 * * * *  bash /srv/platform/scripts/platform/health-check.sh >> /var/log/platform-health.log 2>&1
```

(adjust path to where the workspace is checked out on the VPS)

## How a product satisfies this contract

Two paths:

### Path A — passive (existing data file)

If the product already writes a freshness-bearing file on each
successful run, just point `health.file` at it. No code change needed.

### Path B — active (explicit heartbeat)

If the product has long-running workers but no obvious "I just
finished" file, add at the end of each successful cycle:

```bash
mkdir -p /var/lib/<product_key>
touch    /var/lib/<product_key>/heartbeat
```

then point `health.file` at `/var/lib/<product_key>/heartbeat`
with `max_age_min: <cycle_period_min * 1.5>`.

## What this contract does NOT do

- Does not parse internal product state (PnL, queue depth, error rate).
  Use a product-specific monitor for that.
- Does not measure request latency.
- Does not detect "data is stale but file mtime is bumped anyway"
  (i.e. successful run wrote an empty result). For that you'd add a
  per-product validator, which is intentionally out of platform scope.
