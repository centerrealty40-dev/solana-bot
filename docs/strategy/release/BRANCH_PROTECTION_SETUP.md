# Branch protection for `v2` (one-time GitHub setup)

Mechanical gate: **no merge/push to prod path without green CI**. Hooks catch mistakes locally; branch protection catches bypass.

## Required status check

Workflow: **`.github/workflows/ci.yml`** → job **`hygiene`**.

## GitHub UI (recommended)

1. Repo **Settings → Branches → Add branch protection rule**
2. Branch name pattern: **`v2`**
3. Enable:
   - **Require status checks to pass before merging**
   - Status check: **`hygiene`** (from workflow `ci`)
   - **Require branches to be up to date before merging**
   - **Do not allow bypassing the above settings** (admins too, if acceptable)
4. Optional but recommended:
   - **Require a pull request before merging** (blocks direct push to `v2`)
   - **Restrict force pushes**

Repeat for **`main`** if it tracks releases.

## GitHub CLI (if `gh` installed)

```bash
gh api repos/centerrealty40-dev/solana-bot/branches/v2/protection -X PUT \
  -f required_status_checks[strict]=true \
  -f required_status_checks[contexts][]=hygiene \
  -f enforce_admins=true \
  -f required_pull_request_reviews[required_approving_review_count]=0 \
  -F restrictions=
```

Adjust `required_approving_review_count` if you want human review on every merge.

## Deploy rule (human / agent)

**Never** run VPS `git reset --hard origin/v2` until:

1. Target SHA is **green on GitHub Actions** for job `hygiene`
2. `bash scripts/release/post-deploy-smoke.sh` passes on VPS after `pm2 reload`
