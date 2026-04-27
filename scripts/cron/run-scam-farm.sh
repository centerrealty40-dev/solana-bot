#!/bin/bash
# Scam-farm detective — .env is read by Node (dotenv), do not "source" .env in bash
# (values may contain characters that break shell parsing).
set -euo pipefail
cd /opt/solana-alpha
exec /usr/bin/npm run scam-farm:detect
