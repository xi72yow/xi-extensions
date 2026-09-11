#!/bin/bash
set -euo pipefail

# Builds the signed CRX and the Chrome preferences file pointing at it.
# Usage: ./scripts/build-crx.sh [output-dir]
#
# The key is expected at CRX_KEY. It never lives in the repository: the public
# half sits in chrome/xiws/manifest.json, which is what pins the extension id,
# while the private half signs the archive.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/.."
OUT_DIR="${1:-${REPO_ROOT}/debian/chrome}"
KEY="${CRX_KEY:-${HOME}/.ssh/chrome-xiws.pem}"

if [ ! -f "${KEY}" ]; then
  echo "Error: no CRX key at ${KEY}. Set CRX_KEY to its location." >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

ID=$(node "${SCRIPT_DIR}/pack-crx.js" "${REPO_ROOT}/chrome/xiws" "${KEY}" "${OUT_DIR}/xiws.crx")
VERSION=$(node -p "require('${REPO_ROOT}/chrome/xiws/manifest.json').version")

# on linux chrome picks up an external extension from a preferences file, no
# store listing, policy or update server involved
cat > "${OUT_DIR}/${ID}.json" << EOF
{
  "external_crx": "/usr/share/xi-extensions/xiws.crx",
  "external_version": "${VERSION}"
}
EOF

echo "${ID}"
