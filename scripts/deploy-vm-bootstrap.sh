#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y nginx curl git ufw certbot python3-certbot-nginx ffmpeg ca-certificates xz-utils
# Node 22 LTS from the official distribution, verified against published checksums.
arch=$(uname -m)
case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) exit 1 ;; esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
curl -fsSLO https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
archive=$(awk -v arch="$arch" '$2 ~ "linux-" arch "\\.tar\\.xz$" {print $2}' SHASUMS256.txt)
test -n "$archive"
curl -fsSLO "https://nodejs.org/dist/latest-v22.x/$archive"
grep " $archive$" SHASUMS256.txt | sha256sum -c -
tar -xJf "$archive" -C /usr/local --strip-components=1
install -d -o cadas-app -g cadas-app /var/www/cadas
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
systemctl enable --now nginx
node --version
npm --version
nginx -t
