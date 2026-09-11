# xi-extensions

Own browser and shell extensions, built and shipped as Debian packages. Every extension lives on its own in a dedicated directory and turns into its own binary package.

Target platform is Debian 13 with GNOME Shell 48 and Google Chrome.

## Layout

```
gnome/xiws@xi72yow/     dev workspaces, picker in the panel
chrome/xiws/            counterpart to xiws, persists tabs per workspace
chrome/webtweaks/       collection of tweaks for individual websites
debian/                 one source package, several binary packages
docs/                   concepts and findings per extension
scripts/                apt repository and installation
build.sh                local installation for testing
Containerfile           build and lint environment used by CI
```

## Extensions

| Extension   | Platform    | State                                      | Concept                                |
| ----------- | ----------- | ------------------------------------------ | -------------------------------------- |
| `xiws`      | GNOME Shell | sessions, snapping and presets implemented | [docs/xiws.md](docs/xiws.md)           |
| `xiws`      | Chrome      | implemented and verified                   | [docs/xiws.md](docs/xiws.md)           |
| `webtweaks` | Chrome      | imported, rework pending                   |                                        |
| clipboard   | GNOME Shell | minimal core implemented                   | [docs/clipboard.md](docs/clipboard.md) |

The two Chrome extensions are deliberately kept apart. `webtweaks` carries `identity`, `webRequest` and content scripts on `<all_urls>`, while `chrome/xiws` gets by with `tabs` and `storage`. Merging them would pull the smaller extension into a considerably broader permission scope. On top of that their lifecycles differ, since `webtweaks` follows the DOM of third party sites.

## Packaging

| Package                      | Contents                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `gnome-shell-extension-xiws` | extension into `/usr/share/gnome-shell/extensions/xiws@xi72yow/`, schema into `/usr/share/glib-2.0/schemas/` |
| `chrome-extension-xiws`      | signed CRX into `/usr/share/xi-extensions/`, preferences file into `/usr/share/google-chrome/extensions/`    |

The GSettings schema is deliberately not compiled inside the extension directory. `libglib2.0-0t64` holds a dpkg trigger on `/usr/share/glib-2.0/schemas`, so dropping the XML file is sufficient.

The dependency on `gnome-shell` is bounded in both directions. GNOME Shell breaks the extension API between major releases, and a package without an upper bound would silently leave a broken extension behind after a distribution upgrade.

Enabling an extension does not belong into the package, it lives in the dconf of the respective user. For a preseeded installation a schema override on `org.gnome.shell enabled-extensions` would be the way, which belongs to the system composition rather than here.

`chrome/xiws` ships as a signed CRX with a preferences file pointing at it. On Linux this is how Chrome picks up a locally installed extension, without a store listing, a policy or an update server.

The extension id is pinned rather than derived from wherever the extension happens to sit: the public half of the signing key is carried in `manifest.json`, which fixes the id to `joljhccfdnpdncplopfkfdhpdlfpdhap` for the packaged CRX and for an unpacked load alike. The private half never enters the repository. It is expected at `~/.config/xi-extensions/chrome-xiws.pem` locally, or in the `CHROME_CRX_KEY` secret in CI, and `scripts/pack-crx.js` refuses to sign with a key that does not match the manifest.

A package for `webtweaks` is still pending, along with the rework noted above.

## Installing

The packages come from an APT repository on GitHub Pages. The script only adds
the repository and installs nothing by itself, so every extension can be pulled
on its own:

```bash
curl -fsSL https://xi72yow.github.io/xi-extensions/install.sh | sudo bash
sudo apt install gnome-shell-extension-xiws
sudo apt install chrome-extension-xiws
gnome-extensions enable xiws@xi72yow
```

Enabling stays a manual step, since it lives in the dconf of the respective
user rather than in the package. On Wayland a new session is required
afterwards.

## Continuous integration

Every push runs linting and builds the packages inside the container described
by `Containerfile`, which keeps the toolchain identical to the local one. The
build is checked with `lintian --fail-on error,warning` and the resulting
package is test installed.

A release is triggered manually through `workflow_dispatch`. It derives the
version from `debian/changelog`, appends an incrementing revision, tags the
commit, signs the repository with the `GPG_PRIVATE_KEY` secret and publishes it
to GitHub Pages.

## Testing locally

```bash
./build.sh
gnome-extensions enable xiws@xi72yow
```

The script installs the GNOME extensions into `~/.local/share/gnome-shell/extensions/` and compiles their schemas in place. On Wayland a new session is required afterwards, restarting the shell without logging out is not possible.

The Chrome extensions are loaded through `chrome://extensions` as unpacked extensions for testing. For `chrome/xiws` the id stays put while doing so, since `manifest.json` pins it through the signing key. Without that it would be derived from the path and change whenever the directory moves, leaving the associated storage orphaned, which is still the case for `webtweaks`.

Packaging the Chrome extension locally needs the private key:

```bash
CRX_KEY=~/.config/xi-extensions/chrome-xiws.pem ./scripts/build-crx.sh /tmp/crx
```
