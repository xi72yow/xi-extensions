#!/bin/bash
set -euo pipefail

# Sets up the xi-extensions APT repository
# Usage: curl -fsSL https://xi72yow.github.io/xi-extensions/install.sh | sudo bash
#
# The repository holds one package per extension and nothing is installed
# here, so each of them can be pulled on its own afterwards.

REPO_URL="${REPO_URL:-https://xi72yow.github.io/xi-extensions}"

echo "Adding the xi-extensions APT repository..."

curl -fsSL "${REPO_URL}/key.gpg" | gpg --dearmor -o /usr/share/keyrings/xi-extensions.gpg

echo "deb [arch=amd64 signed-by=/usr/share/keyrings/xi-extensions.gpg] ${REPO_URL} stable main" \
  > /etc/apt/sources.list.d/xi-extensions.list

apt-get update

cat << 'EOF'

Repository added. The packages are installed individually:

  apt install gnome-shell-extension-xiws
  apt install chrome-extension-xiws

Afterwards the GNOME extension still has to be enabled once per user:

  gnome-extensions enable xiws@xi72yow

On Wayland a new session is required for the extension to load.
EOF
