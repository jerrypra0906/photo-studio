#!/usr/bin/env bash
# One-time bootstrap for the JES Studio Booking VM (Ubuntu 24.04 LTS on Compute Engine).
# Run as a sudo-capable user:  bash infra/gcp/setup-vm.sh
# Installs Docker, adds swap, enables unattended security upgrades, caps Docker logs, prepares /srv/jes.
set -euo pipefail

echo "== packages"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg unattended-upgrades fail2ban

echo "== docker (official repository)"
if ! command -v docker >/dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
sudo usermod -aG docker "$USER"

echo "== docker daemon defaults (log rotation for any container, live-restore across daemon upgrades)"
sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "5" }, "live-restore": true }
JSON
sudo systemctl restart docker

echo "== swap (2 GB) so builds and spikes don't OOM a small VM"
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf >/dev/null
  sudo sysctl --system >/dev/null
fi

echo "== automatic security updates"
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== app directories"
sudo mkdir -p /srv/jes/backups
sudo chown -R "$USER":"$USER" /srv/jes
chmod 700 /srv/jes/backups

echo "Done. Log out and back in (docker group), then follow docs/DEPLOY_GCP.md from step 4."
