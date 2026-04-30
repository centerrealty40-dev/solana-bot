#!/usr/bin/env bash
# Finish Stage 0 stack if SSH dropped mid-bootstrap: Node 20, Caddy 2, UFW basics.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

wait_apt_locks() {
  local max="${1:-540}"
  local i=0
  while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 \
     || fuser /var/lib/dpkg/lock >/dev/null 2>&1 \
     || fuser /var/lib/apt/lists/lock >/dev/null 2>&1 \
     || fuser /var/cache/apt/archives/lock >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt "$max" ]; then
      echo "ERROR: apt lock timeout"; exit 1
    fi
    sleep 5
  done
}

echo "=== [A] node 20 (nodesource) ==="
if ! command -v node >/dev/null 2>&1; then
  wait_apt_locks 540
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  wait_apt_locks 540
  apt-get install -y nodejs
else
  echo "node already: $(node --version)"
fi

echo "=== [B] caddy 2 ==="
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
    > /etc/apt/sources.list.d/caddy-stable.list
  wait_apt_locks 540
  apt-get update -y
  wait_apt_locks 540
  apt-get install -y caddy
else
  echo "caddy already installed"
fi

echo "=== [C] pm2 global ==="
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2@latest
fi

echo "=== [D] UFW (22, 80, 443) ==="
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
yes | ufw enable || true

echo "=== versions ==="
node --version
npm --version
caddy version | head -1
pm2 --version | head -1

systemctl enable --now caddy 2>/dev/null || systemctl restart caddy

echo "DONE finish-node-caddy-ufw"
