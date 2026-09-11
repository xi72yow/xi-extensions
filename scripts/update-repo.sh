#!/bin/bash
set -euo pipefail

# Update APT repository structure for GitHub Pages
# Usage: ./scripts/update-repo.sh [--no-sign]
# Expects: packages/*.deb files and GPG_PRIVATE_KEY environment variable (or --no-sign flag)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/.."
PACKAGES_DIR="${REPO_ROOT}/packages"
REPO_DIR="${REPO_ROOT}/repo"
NO_SIGN=false

if [[ "${1:-}" == "--no-sign" ]]; then
  NO_SIGN=true
fi

if [ ! -d "${PACKAGES_DIR}" ] || [ -z "$(ls -A "${PACKAGES_DIR}"/*.deb 2>/dev/null)" ]; then
  echo "Error: No .deb packages found in ${PACKAGES_DIR}"
  exit 1
fi

# Clean and create repo structure. The packages are Architecture: all, but the
# index still lives under binary-amd64: dpkg-scanpackages lists all alongside
# the requested architecture, and apt resolves it from there.
rm -rf "${REPO_DIR}"
mkdir -p "${REPO_DIR}/pool/main"
mkdir -p "${REPO_DIR}/dists/stable/main/binary-amd64"

cp "${PACKAGES_DIR}"/*.deb "${REPO_DIR}/pool/main/"

cd "${REPO_DIR}"
dpkg-scanpackages --arch amd64 pool/main /dev/null > dists/stable/main/binary-amd64/Packages
gzip -k dists/stable/main/binary-amd64/Packages

cd "${REPO_DIR}/dists/stable"

cat > Release << EOF
Origin: xi-extensions
Label: xi-extensions Debian Repository
Suite: stable
Codename: stable
Architectures: amd64 all
Components: main
Description: APT repository for xi-extensions
$(apt-ftparchive release .)
EOF

if [ "$NO_SIGN" = false ]; then
  if [ -n "${GPG_PRIVATE_KEY:-}" ]; then
    echo "${GPG_PRIVATE_KEY}" | gpg --batch --import 2>/dev/null || true
  fi

  GPG_KEY_ID=$(gpg --list-secret-keys --keyid-format long 2>/dev/null | grep sec | head -1 | awk '{print $2}' | cut -d'/' -f2)

  if [ -z "${GPG_KEY_ID}" ]; then
    echo "Error: No GPG secret key found. Set GPG_PRIVATE_KEY or use --no-sign"
    exit 1
  fi

  gpg --batch --yes --armor --detach-sign --output Release.gpg Release
  gpg --batch --yes --armor --clearsign --output InRelease Release

  gpg --batch --yes --armor --export "${GPG_KEY_ID}" > "${REPO_DIR}/key.gpg"
  gpg --batch --yes --export "${GPG_KEY_ID}" > "${REPO_DIR}/key.bin"

  echo "Repository signed with key ${GPG_KEY_ID}"
else
  echo "Warning: Repository is NOT signed (--no-sign)"
fi

cp "${SCRIPT_DIR}/install.sh" "${REPO_DIR}/install.sh"

echo "Repository updated in ${REPO_DIR}/"
echo "Contents:"
find "${REPO_DIR}" -type f | sort | sed "s|${REPO_DIR}/||"
