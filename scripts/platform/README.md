# Platform Scripts

Shared platform tooling for the multi-product workspace.
See `docs/platform/` for the contract these scripts implement.

## `check-boundaries.sh`

Cross-product change guard. Run as a git pre-commit hook in any product's
repository, or invoke manually before pushing. Reads
`docs/platform/products.yaml` and fails when a single commit:

- touches files belonging to more than one product without a
  `Cross-product:` line in the commit message;
- introduces an env var without a known product prefix;
- edits the generated `docs/platform/PRODUCT_REGISTRY.md` directly
  (instead of editing `products.yaml` and regenerating);
- changes platform docs without bumping `VERSION` and updating
  `PLATFORM_CHANGELOG.md`.

Override (use sparingly): `CHECK_BOUNDARIES=skip git commit ...`

## `install-pre-commit.sh`

Installs `check-boundaries.sh` as a `.git/hooks/pre-commit` in the
current product's repo. Idempotent. Run once per product repo:

```bash
cd /path/to/product-repo  # e.g. cd meteora-dash
bash /path/to/workspace/scripts/platform/install-pre-commit.sh
```

## `health-check.sh`

Per-product freshness monitor. Reads the `health` block of each product
in `products.yaml` and checks file mtime + optional HTTP probe.
Persists last-known state under `/var/lib/platform-health/`. Sends a
Telegram message on state transitions (OK <-> STALE/DOWN) when
`PLATFORM_TG_BOT_TOKEN` and `PLATFORM_TG_CHAT_ID` are set.

Designed for cron, e.g.:

```cron
*/10 * * * *  bash /srv/platform/scripts/platform/health-check.sh >> /var/log/platform-health.log 2>&1
```

See `docs/platform/HEALTH_CONTRACT.md` for the full contract.

## Telegram setup (optional)

1. Talk to `@BotFather` on Telegram, `/newbot`, get a token.
2. Send any message to your bot from your account.
3. Get your chat id:
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[-1].message.chat.id'
   ```
4. Export both env vars before running `health-check.sh`:
   ```bash
   export PLATFORM_TG_BOT_TOKEN=...
   export PLATFORM_TG_CHAT_ID=...
   ```
   Or add them to the cron user's profile.

Without these vars, health-check.sh still runs and updates state files;
it just doesn't notify.
