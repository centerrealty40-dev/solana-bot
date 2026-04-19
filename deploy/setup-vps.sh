#!/usr/bin/env bash
#
# One-shot VPS bootstrap for Ubuntu 22.04 / 24.04 LTS.
#
# What it does:
#   1. Update apt and install base tools (git, build-essential, ufw, fail2ban)
#   2. Install Node.js 20.x from NodeSource
#   3. Install pm2 globally
#   4. Install Caddy (official repo) for HTTPS reverse proxy
#   5. Configure UFW firewall (allow SSH + HTTP + HTTPS only)
#   6. Create dedicated unprivileged user `salpha` and /opt/solana-alpha dir
#   7. Print next-step instructions
#
# Run as root:
#   curl -fsSL https://raw.githubusercontent.com/centerrealty40-dev/solana-bot/main/deploy/setup-vps.sh | bash
# OR after `git clone`:
#   sudo bash deploy/setup-vps.sh

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run as root (sudo bash $0)"
  exit 1
fi

echo "==> apt update + base packages"
apt-get update -y
apt-get install -y curl git build-essential ufw fail2ban ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

echo "==> install Node.js 20"
if ! command -v node >/dev/null 2>&1 || [[ $(node -v | cut -dv -f2 | cut -d. -f1) -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node --version
npm --version

echo "==> install pm2"
npm install -g pm2@latest

echo "==> install Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -fsSL "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> configure UFW (allow 22/tcp, 80/tcp, 443/tcp)"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> create salpha user and /opt/solana-alpha"
if ! id salpha >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash salpha
fi
mkdir -p /opt/solana-alpha
chown -R salpha:salpha /opt/solana-alpha

echo "==> enable fail2ban"
systemctl enable --now fail2ban

cat <<EOF

============================================================
VPS bootstrap done. Next steps (run as root, then as salpha):

1. Switch to the salpha user and clone the repo:
     sudo -iu salpha
     cd /opt/solana-alpha
     git clone https://github.com/centerrealty40-dev/solana-bot.git .
     cp .env.example .env
     nano .env     # fill DATABASE_URL (Neon), HELIUS_API_KEY, HELIUS_WEBHOOK_URL=https://YOUR_DOMAIN/webhooks/helius
     npm ci
     npm run db:migrate
     npm run views:install

2. Start the four services:
     pm2 start ecosystem.config.cjs
     pm2 save
     exit          # back to root

3. Enable pm2 to autostart on boot:
     env PATH=\$PATH:/usr/bin pm2 startup systemd -u salpha --hp /home/salpha
     # then run the command pm2 prints

4. Configure Caddy for HTTPS:
     sed -i 's/YOUR_DOMAIN/solana-bot.your-domain.com/g' /opt/solana-alpha/deploy/Caddyfile
     cp /opt/solana-alpha/deploy/Caddyfile /etc/caddy/Caddyfile
     systemctl reload caddy

5. Verify:
     curl https://solana-bot.your-domain.com/health
     pm2 status
     pm2 logs sa-runner --lines 50

============================================================
EOF
