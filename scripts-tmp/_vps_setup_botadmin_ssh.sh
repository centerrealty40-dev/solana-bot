#!/usr/bin/env bash
# Разовая настройка на VPS от root: scp на хост и bash /tmp/_vps_setup_botadmin_ssh.sh
# Добавляет тот же публичный ключ, что у root (Bot Admin / botadmin_187_auto), для входа botadmin@ + sudo NOPASSWD → salpha.
set -euo pipefail
PUBKEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP8DZtI3CdEC5DDnA/Xhmm8y6WL01emfHmuPHVkVAcz5 cente@DESKTOP-B53V0UU'
if ! id botadmin &>/dev/null; then
  useradd -m -s /bin/bash botadmin
fi
install -d -m 700 -o botadmin -g botadmin /home/botadmin/.ssh
AUTH=/home/botadmin/.ssh/authorized_keys
touch "$AUTH"
chown botadmin:botadmin "$AUTH"
chmod 600 "$AUTH"
if ! grep -qxF "$PUBKEY" "$AUTH"; then
  echo "$PUBKEY" >> "$AUTH"
fi
printf '%s\n' 'botadmin ALL=(salpha) NOPASSWD: ALL' >/etc/sudoers.d/botadmin-salpha
chmod 440 /etc/sudoers.d/botadmin-salpha
visudo -cf /etc/sudoers.d/botadmin-salpha
echo 'botadmin SSH + sudo -u salpha: OK'
