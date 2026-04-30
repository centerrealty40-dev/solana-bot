#!/usr/bin/env bash
# Stage 0 / step 1: install base system stack on a fresh Ubuntu 24.04 VPS.
# Idempotent: re-running is safe.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

log() { echo "=== $* ==="; }

log "[1/8] hostname + timezone"
hostnamectl set-hostname salpha-v2 || true
timedatectl set-timezone UTC || true

log "[2/8] wait for apt/dpkg locks (max ~45 min — unattended-upgrades на свежем VPS)"
wait_apt_locks() {
  local max="${1:-540}" # 540 * 5s = 45 min
  local i=0
  while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 \
     || fuser /var/lib/dpkg/lock >/dev/null 2>&1 \
     || fuser /var/lib/apt/lists/lock >/dev/null 2>&1 \
     || fuser /var/cache/apt/archives/lock >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt "$max" ]; then
      echo "  ERROR: apt lock wait timeout after $((max * 5))s"
      exit 1
    fi
    if [ $((i % 12)) -eq 0 ]; then
      echo "  locks held ($i/$max) — apt-get/dpkg/unattended-upgrades still running..."
    fi
    sleep 5
  done
  echo "  apt/dpkg locks released"
}
wait_apt_locks 540

log "[3/8] apt update"
wait_apt_locks 540
apt-get update -y 2>&1 | tail -5

log "[4/8] swap 4G (RAM=7.8G, страховка для Postgres+Redis+Node)"
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
  echo "vm.swappiness=10" > /etc/sysctl.d/99-swap.conf
  sysctl -p /etc/sysctl.d/99-swap.conf
  echo "  swap created"
else
  echo "  swap already exists"
fi
free -h | head -3

log "[5/8] core packages (postgres 16, redis, ufw, fail2ban, build, utils, rclone for R2)"
wait_apt_locks 540
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg lsb-release apt-transport-https debian-keyring debian-archive-keyring \
  build-essential git jq htop ncdu iotop sysstat ufw fail2ban unzip rsync rclone \
  postgresql postgresql-contrib redis-server python3-pip 2>&1 | tail -8

log "[6/8] node 20 via nodesource"
if ! command -v node >/dev/null 2>&1; then
  wait_apt_locks 540
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>&1 | tail -4
  wait_apt_locks 540
  apt-get install -y nodejs 2>&1 | tail -4
else
  echo "  node already installed: $(node --version)"
fi

log "[7/8] caddy 2 official repo"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
    > /etc/apt/sources.list.d/caddy-stable.list
  wait_apt_locks 540
  apt-get update -y 2>&1 | tail -3
  wait_apt_locks 540
  apt-get install -y caddy 2>&1 | tail -4
else
  echo "  caddy already installed"
fi

log "[8/8] versions"
echo -n "postgres: "; pg_config --version 2>/dev/null || echo "(missing)"
echo -n "psql:     "; command -v psql >/dev/null && psql --version || echo "(missing)"
echo -n "redis:    "; command -v redis-server >/dev/null && redis-server --version | head -1 || echo "(missing)"
echo -n "node:     "; command -v node >/dev/null && node --version || echo "(missing)"
echo -n "npm:      "; command -v npm >/dev/null && npm --version || echo "(missing)"
echo -n "caddy:    "; command -v caddy >/dev/null && caddy version 2>&1 | head -1 || echo "(missing)"
echo -n "rclone:   "; command -v rclone >/dev/null && rclone version | head -1 || echo "(missing)"
echo -n "git:      "; git --version

log "services status"
for svc in postgresql redis-server caddy fail2ban; do
  printf "  %-20s enabled=%s active=%s\n" "$svc" \
    "$(systemctl is-enabled "$svc" 2>&1)" \
    "$(systemctl is-active  "$svc" 2>&1)"
done

log "load + disk after install"
uptime
df -h / | tail -1
free -h | head -2
log "DONE"
