#!/usr/bin/env bash
# builds the packages in the ci container and installs them through apt, so a
# local build runs exactly what a release would deliver
set -euo pipefail

repo_root=$(cd "$(dirname "$0")" && pwd)
image=xi-extensions-build
key="${CRX_KEY:-${HOME}/.ssh/chrome-xiws.pem}"
out="${repo_root}/packages"
user_scope="${HOME}/.local/share/gnome-shell/extensions"

if [[ ! -f "$key" ]]; then
  echo "error: no crx key at $key, set CRX_KEY to its location" >&2
  exit 1
fi

# a version below the installed one would be replaced by the older release
# on the next upgrade, so the build sits right above the newest known
# version and below the next release
installed=$(dpkg-query -W -f='${Version}' gnome-shell-extension-xiws 2>/dev/null || true)
stamp=$(date -u +%Y%m%d%H%M%S)

# the containerfile copies nothing in, so no build context is sent along
podman build -q -t "$image" - < "$repo_root/Containerfile" > /dev/null

rm -rf "$out"
mkdir -p "$out"

podman run --rm \
  -v "$repo_root:/app:ro" \
  -v "$key:/run/crx-key.pem:ro" \
  -v "$out:/out" \
  -e CRX_KEY=/run/crx-key.pem \
  -e INSTALLED="$installed" \
  -e STAMP="$stamp" \
  "$image" bash -c '
    set -euo pipefail

    # dpkg-buildpackage writes next to the source tree, so it builds from a
    # copy and the changelog entry for the local version stays in there
    mkdir -p /tmp/build/src
    tar -C /app --exclude=./node_modules --exclude=./.git --exclude=./packages -cf - . \
      | tar -C /tmp/build/src -xf -
    cd /tmp/build/src

    base=$(dpkg-parsechangelog -S Version)
    released=${INSTALLED%%+local*}
    if [[ -n $released ]] && dpkg --compare-versions "$released" gt "$base"; then
      base=$released
    fi

    maintainer=$(dpkg-parsechangelog -S Maintainer)
    email=${maintainer##*<}
    DEBFULLNAME=${maintainer% <*} DEBEMAIL=${email%>} \
      dch --newversion "${base}+local${STAMP}" --distribution unstable "local build"

    dpkg-buildpackage -us -uc -b
    lintian --fail-on error,warning /tmp/build/*.changes
    cp /tmp/build/*.deb /out/
  '

sudo apt-get install -y "$out"/*.deb

# a copy in the user scope shadows the packaged extension of the same uuid,
# which is what the previous version of this script left behind. settings
# live in dconf and the clipboard in the runtime dir, neither is in there
for dir in "$repo_root"/gnome/*/; do
  uuid=$(basename "$dir")
  if [[ -d "$user_scope/$uuid" ]]; then
    rm -rf "${user_scope:?}/$uuid"
    echo "removed shadowing copy $user_scope/$uuid"
  fi
done

echo
echo "log out and back in for the shell, restart chrome for the browser extension"
