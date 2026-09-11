#!/usr/bin/env bash
# installs every extension into the user scope for testing
set -euo pipefail

repo_root=$(cd "$(dirname "$0")" && pwd)
target="${HOME}/.local/share/gnome-shell/extensions"

for dir in "$repo_root"/gnome/*/; do
  uuid=$(basename "$dir")
  [[ -f "$dir/metadata.json" ]] || continue

  rm -rf "${target:?}/$uuid"
  install -d "$target/$uuid"
  cp -r "$dir." "$target/$uuid/"

  if [[ -d "$target/$uuid/schemas" ]]; then
    glib-compile-schemas "$target/$uuid/schemas"
  fi

  echo "installed $uuid"
done

echo
echo "log out and back in, then: gnome-extensions enable <uuid>"
