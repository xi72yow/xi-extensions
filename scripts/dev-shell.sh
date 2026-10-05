#!/bin/bash
set -euo pipefail

# Installs the extensions and opens them in a nested GNOME Shell, so a UI
# change can be looked at without logging out of the running session.
#
# Usage: ./scripts/dev-shell.sh [width]x[height]
#
# Shortcuts are bound globally by whichever shell registers them first, which
# is always the session around this one. The nested instance therefore gets a
# dconf profile of its own, seeded from the real settings, with the shortcuts
# moved onto Shift so they reach it instead:
#
#   Super+Shift+W   workspace picker
#   Super+Shift+C   clipboard
#
# Still shared with the surrounding session is the keyring, so both instances
# write the same clipboard favourites and the one saving last wins. Looking at
# layout is harmless, starring entries in here is not.

UUID="xiws@xi72yow"
BRANCH="/org/gnome/shell/extensions/xiws"

# dconf talks to a service on the session bus rather than writing the file
# directly, so XDG_CONFIG_HOME only takes effect for a service started inside
# the new bus. the second stage therefore runs under dbus-run-session.
if [ "${1:-}" = "--inner" ]; then
  settings="$2"

  dconf load "${BRANCH}/" < "${settings}"
  rm -f "${settings}"

  dconf write /org/gnome/shell/enabled-extensions "['${UUID}']"
  dconf write "${BRANCH}/toggle-picker" "['<Super><Shift>w']"
  dconf write "${BRANCH}/toggle-clipboard" "['<Super><Shift>c']"

  exec gnome-shell --nested --wayland --wayland-display=xiws-dev
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/.."
SIZE="${1:-1600x900}"

"${REPO_ROOT}/build.sh"

# read the real settings while still talking to the real dconf service
SETTINGS=$(mktemp)
dconf dump "${BRANCH}/" > "${SETTINGS}" 2>/dev/null || true

PROFILE=$(mktemp -d -t xiws-dev-XXXXXX)
export XDG_CONFIG_HOME="${PROFILE}"

# the dummy backend gives the nested compositor a monitor of its own rather
# than inheriting the geometry of the host
export MUTTER_DEBUG_DUMMY_MODE_SPECS="${SIZE}"

echo
echo "nested shell at ${SIZE}, settings in ${PROFILE}"
echo "  Super+Shift+W  picker"
echo "  Super+Shift+C  clipboard"
echo "close the window to return"
echo

exec dbus-run-session -- "${SCRIPT_DIR}/dev-shell.sh" --inner "${SETTINGS}"
