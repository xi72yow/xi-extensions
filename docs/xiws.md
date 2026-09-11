# xiws

Dev workspaces for GNOME. A workspace bundles a project directory with the applications belonging to it: GitHub Desktop, Zed and a Chrome window holding the tabs of the project.

Status: in use. Sessions, snapping, presets and the clipboard are implemented; what remains open is listed at the end.

## Goal

A rofi style widget reachable through a keyboard shortcut. Typing filters the workspace list, Enter opens or switches. In addition a shortcut cycles through the workspaces that are currently open.

## Model

Definition and session are kept apart.

| Term       | Meaning                                                 | Order of magnitude |
| ---------- | ------------------------------------------------------- | ------------------ |
| Definition | A known project that shows up in the picker             | 30 and more        |
| Session    | A workspace that is currently open with running windows | typically 3        |

A GNOME workspace is assigned to a session on open and released again on close. There is no fixed binding between a definition and a GNOME workspace, otherwise the number of definitions would be capped by the number of GNOME workspaces. `dynamic-workspaces` is enabled on the target system and carries this behaviour by itself.

The lower workspaces stay reserved for personal use. `first-workspace-index` defines the lowest index that may be used for sessions and defaults to 1, so the first workspace is never taken. Selection picks the first unoccupied workspace at or above that index and appends a new one if none is free. Windows that are sticky or skip the taskbar do not count as occupying a workspace.

**An appended workspace has to be activated right away.** `append_new_workspace(false, ...)` leaves an empty workspace at the end, which is exactly what mutter reclaims under `dynamic-workspaces`. The picked workspace then disappeared before the launched windows arrived, and moving them by index silently landed them on the last existing workspace, in practice the reserved one. The session looked lost and the picker showed no card for it, since a session whose workspace holds no windows is dropped from the list.

For the same reason a claim holds the `Meta.Workspace` object rather than its index, matching how open sessions are tracked, and checks that it still exists before moving a window onto it.

This only surfaced after the browser warm up round was removed. That round used to occupy the reserved workspace before the selection ran, so mutter already kept a spare workspace at the end and nothing had to be appended.

**Windows are moved explicitly.** Passing a workspace to `global.create_app_launch_context` only writes a startup notification, which a running instance ignores. Chrome and GitHub Desktop are usually already running, so their new windows appeared on the previously active workspace. Verified in a nested shell: a window opens on workspace 0 and is moved to 1 only through `change_workspace_by_index`.

Claiming listens on `window-created` and acts once the compositor reports `first-frame`, since window properties are not reliably set before that. It stays active for `claim-seconds` after opening a session, so unrelated windows opened in the meantime are left alone.

**Claims are held side by side and keyed by application.** A single exclusive claim was replaced by every later one, so opening a second workspace while the first was still coming up redirected its remaining windows to the newer target. Switching to a session with a cold git client had the same effect, since that arms a claim as well. Windows then arrived on whichever workspace had armed the last claim, the reserved one included.

Each claim now carries the set of applications its launch is waiting for. A window goes to the first claim still expecting its application, and that entry is removed afterwards, so a claim retires once everything it launched has appeared. Only windows the shell cannot map to an application fall back to the oldest claim, since there is nothing to key them on.

The consequence is that a second window of the same application within one launch is not claimed. That matches how a session is captured, where only the first window per application is recorded.

**Nothing happens during the workspace switch animation.** Moving a window while that animation runs leaves the shell without a stacking record for it, which surfaced as `TypeError: record is undefined` in `workspaceAnimation.js`. Anything that touches windows therefore waits out a settle delay first.

**Applications are started spaced out, not at once.** Launching the three of them together crashed `gnome-keyring-daemon` with a `TRAP`, since all of them query the secret service on startup and raced each other there. Afterwards systemd restarted the service while D-Bus activated a second instance, leaving two daemons that reported `discover_other_daemon` and asked for authentication again. The spacing also flattens the CPU spike that starting a Rust editor and two Electron applications simultaneously produces.

**Windows are identified by application, not by window class.** Comparing window classes failed for GitHub Desktop, which follows neither of the spellings its manifest suggests. Since the shell maintains the window to application mapping itself, `Shell.WindowTracker.get_window_app` is asked instead and the result compared against `session-desktop-ids`. Both `org.gnome.Shell.Introspect.GetWindows` and `GetRunningApplications` are rejected with `AccessDenied` for unprivileged callers, so the class could not be determined from outside either. `claim-window-classes` remains as a fallback for windows the shell cannot map, and is empty by default.

The same applies to GitHub Desktop following a session: its windows are taken from `Shell.App.get_windows()` on the app resolved through `git-desktop-id`. This also happens when opening a session, not only when switching. A running instance merely changes repository without creating a window, so claiming on `window-created` would never see it.

**Windows are placed into fixed slots.** `session-layout` assigns a tile per application, given as fractions of the work area, so the same layout holds on any monitor size. Placement uses `move_resize_frame` directly and therefore needs no tiling extension and no auto tiling. Applications without an entry keep their own placement, an empty array disables placement altogether. A maximized window is unmaximized first, otherwise the geometry would not take effect.

Assignment is per application rather than by order of appearance, so the arrangement does not depend on which application finishes starting first. A tile may carry `background`, which lowers the window behind the others after placing it.

A tile without `width` and `height` only moves the window and leaves its size alone, using `move_frame` instead of `move_resize_frame`. Together with `center` that yields a window placed in the middle at whatever size it carries. GitHub Desktop uses this, because it stores its own window size and resizing it on every session change would keep overwriting that.

Such an entry is also exempt from capturing. Measuring it would replace the intent with the geometry it happens to have at that moment, and the setting would silently turn into a fixed size again.

**The arrangement is remembered per workspace.** `session-apps` maps a workspace name to the same tile format `session-layout` uses, so it records which applications were open and where. Storing fractions rather than pixels keeps a captured arrangement valid when the resolution changes. Capturing happens whenever the picker opens, which keeps the stored state current without having to watch every window for the whole lifetime of a session.

A stored arrangement takes precedence over `session-layout`, which therefore only applies to workspaces opened for the first time. Moving a window and reopening the picker is enough to update it.

The stacking order is captured as well, in a reduced form: the bottom-most window of a session is marked `background` and gets lowered again on restore. That preserves an arrangement where one window sits behind the others without having to store a full stacking order.

Only the first window per application is recorded, otherwise a second editor window would overwrite the entry of the first. Windows the shell cannot map to an installed application are skipped, since `get_window_app` returns a synthetic app for those whose id only holds for the current session.

**Capturing merges, closing replaces.** Replacing the set on every capture dropped any application that happened to sit on another workspace at that moment, and since the set drives the next launch it never came back. That is how the editor disappeared from a session. Capturing therefore updates the applications it finds and leaves the rest in place. Closing a session is the one moment the set is authoritative, so there it replaces and an application can actually be dropped.

The reserved workspace is the exception, since it is never closed. Merging left its set growing monotonically: an application that ran there once stayed in it and was launched again on every open, long after it had been shut down. Capturing is therefore authoritative for `__home__`. The trade off is that a window temporarily moved off the reserved workspace drops out of its set, which seems acceptable given that the set is meant to describe what was there last.

**Editor, browser and git client make up a project session and are always started.** Driving them from the captured set meant a session lost one of them whenever it happened to be on another workspace while capturing, and since the set drives the next launch it never came back. That is what made the editor stop opening. Everything beyond the three comes from what was captured and is opened through `Shell.App.open_new_window` on the session workspace.

The git client is additionally skipped while capturing, since it follows sessions rather than belonging to one and would otherwise pile up in every set.

The reserved workspace is the exception in the other direction: there nothing is forced, see the picker section.

An earlier revision stored plain application ids without geometry. Such entries are still read and simply carry no placement.

Sessions can be closed from the picker, either through the button on the row or with the Delete key while it is focused. Closing captures the arrangement first, then asks every window on that workspace to close, so reopening restores the same set.

Closing then moves on to the next open session, the way closing a tab moves to the next one: the first session above the closed index, wrapping to the lowest one, and falling back to the reserved workspace when none is left. Without that the emptied workspace would stay active.

The git client is exempt from being closed. Being a single shared instance, closing it would remove it from every other session as well. It is moved to the workspace below the session range instead, which is the one reserved for personal use. Switching to a session also arms window claiming for a moment, because the git client may have been shut down in the meantime and then starts cold, leaving no window to move at that point.

**The reserved workspace carries a browser window like any other.** It is opened under the sentinel name `__home__`, the same key its arrangement is stored under, so its tabs are persisted and restored through the Chrome extension rather than being left to the browser.

An earlier revision treated the first browser window as an untracked default session and warmed a cold browser up before opening a workspace, waiting on `notify::state` with a timeout. That is no longer needed: with the reserved workspace managing its own window, a cold browser can go straight to the sentinel of whichever workspace is being opened.

## Components

| Component            | Role                                                                        |
| -------------------- | --------------------------------------------------------------------------- |
| `gnome/xiws@xi72yow` | GNOME extension. Picker, workspace management, launching the applications   |
| `chrome/xiws`        | Chrome extension. Persists the tabs per workspace and restores them on open |

## Application models

| App            | Behaviour on switch                                    | Invocation                         |
| -------------- | ------------------------------------------------------ | ---------------------------------- |
| Zed            | one window per workspace, stays on its GNOME workspace | `zed --new <path>`                 |
| Chrome         | one window per workspace, stays put, default profile   | sentinel URL, see below            |
| GitHub Desktop | single instance, follows along, repository changes     | `x-github-client://openRepo/<url>` |

GitHub Desktop holds a single instance lock and is therefore not bound to a session. On switch only the displayed repository is changed, and the window is pulled onto the active GNOME workspace via `change_workspace`.

Chrome deliberately keeps using the default profile. Any form of profile separation, both `--profile-directory` and `--user-data-dir`, creates its own cookie store. Chrome Sync carries passwords and bookmarks but no session cookies, so with SSO providers every profile requires its own login flow. That was rejected as impractical.

Separation therefore happens through windows rather than profiles. Persistence across a Chrome restart is the job of the Chrome extension.

This requires Chrome's own session restore to be turned off, meaning `restore_on_startup` set to 5 instead of 1. Otherwise Chrome restores the windows itself on startup without any binding to a workspace, and opening through `xiws` later produces a second window holding stale state. With restore disabled, `xiws` is the only party restoring windows. This could be pinned through a policy under `/etc/opt/chrome/policies/managed/` using `RestoreOnStartup: 5`.

## Definitions

Auto discovery is the baseline: git repositories below the configured search paths are offered as workspaces automatically. This avoids maintaining 30 and more individual files.

A directory holding a `.git` counts as a repository and is not descended into, which keeps submodules and vendored checkouts out of the list. Anything else is followed down to `search-depth`, three levels by default, so repositories grouped under a folder are found as well. Their name then carries the path below the search root, `trunshopdev/trunshop24` rather than just `trunshop24`, which also keeps two projects of the same name apart.

Measured against the current tree, with a warm cache and medians of five runs: depth one takes 433 µs for 76 repositories, depth two 880 µs for 80, depth three 7.6 ms for the same 80, depth four 29 ms. Since 7.6 ms exceeds a frame, the result is cached and refreshed shortly after the dialog opens, so only the first open after login pays for the scan. `search-exclude` additionally skips directories that never hold a project of their own, `node_modules` and the like, which is what makes deeper scans affordable at all.

Per project overlay files under `~/.config/xiws/` were planned and are not implemented. They became unnecessary: `session-apps` records what a session actually held, `session-layout` provides the default arrangement, and the browser state lives with the Chrome extension. A file would only have restated one of the three.

A workspace does not have to be bound to a repository. The reserved workspace covers everyday use and is restored without anything being forced onto it, see the picker section.

## Picker contents

The reserved workspace is the first entry of the session section, labelled through `home-label`. With a search active it appears only when its label matches.

It is drawn as the same card as every other session, thumbnail included, since it is a workspace like the rest and differs only in always being there. The one omission is the close button: its windows are not a session that can be ended, so neither the button nor the Delete key applies to it.

It is restored like a session but nothing is forced onto it. Its arrangement is captured under the key `__home__`, a name no repository can carry, and opening it launches only what was there last time and is not already running. Without a stored state it is a plain workspace switch. The editor gets no project path there, and the git client is not pulled along, since neither belongs to a workspace that has no project.

The browser is the exception among the three: it is opened with the sentinel `ws=__home__` like on any other workspace, so the tabs of the reserved workspace are persisted and come back with it. The same applies to `<Super>E` while the reserved workspace is active. Other workspaces without a session still get a plain window, since two windows bound to `__home__` would overwrite each other's state.

The dialog shows two sections. Open sessions come first, laid out as cards in a grid of `SESSION_COLUMNS` columns, currently two, each with a thumbnail of its GNOME workspace above its name and number.

**The dialog width is computed, not stated in the stylesheet.** Given in `em`, it drifted against the cards, which are measured in pixels: at the default font size 42em came out around 616 pixels while two cards need 644, and the second column was clipped. `pickerWidth()` derives it from `THUMB_WIDTH`, `SESSION_COLUMNS` and the card metrics instead. Actor sizes are logical pixels while CSS lengths are multiplied by the theme scale factor, so only the padding and spacing parts of that sum are scaled. The stylesheet keeps a `max-width` purely to lift the 28em cap the shell theme puts on a dialog. Then an empty search lists the most recently opened projects as plain rows, capped by `recent-count` and defaulting to 7. Typing switches the lower section to a filter across all discovered projects.

Cards carry their own width rather than expanding, so a half filled last line leaves its entry at the same size as the others. The label box is pinned to the thumbnail width and its labels are ellipsized, otherwise a long project name such as `trunshopdev/trunshop24` would widen the card and break the grid alignment.

The close button is placed over the thumbnail through a `Clutter.BinLayout` rather than beside the labels. Sharing a row with them, its width competed with their minimum width, and the row then grew past the thumbnail: the button hung over the edge of the card and was clipped by the dialog in the right hand column.

Keyboard navigation stays linear across the grid: Up and Down step through the cards in reading order rather than by column, since Right is already taken by the detail view.

Sessions are held as a map from project name to `Meta.Workspace`. The object reference is stored rather than the index, because indices shift when dynamic workspaces are added or removed. A session is dropped as soon as its workspace no longer exists or holds no windows, so closing everything on a workspace ends the session implicitly.

Activating a session switches to its workspace instead of launching anything again. GitHub Desktop follows along, since its single instance lock keeps it from living on a workspace: the repository is switched through `--cli-open` and its window is moved to the target workspace.

Thumbnails are built from `Clutter.Clone` on the window actors, positioned by `get_frame_rect` and scaled to the work area. Deliberately not used is the `WorkspaceThumbnail` class of the overview, which is bound to that context. Windows without a compositor actor fall back to their application icon.

Their height follows the aspect ratio of the work area rather than being fixed. On an ultrawide display a fixed height leaves most of the thumbnail empty, since the windows only occupy a flat strip at the top. At 300 pixels wide a 32:9 work area yields 84 pixels of height, 16:9 yields 169.

## Shortcuts

| Binding    | Effect                                                         |
| ---------- | -------------------------------------------------------------- |
| `<Super>W` | open the workspace picker                                      |
| `<Super>C` | open the clipboard history                                     |
| `<Super>E` | focus the browser of the current session, or open it there     |
| `<Super>D` | focus the git client for the current session, or open it there |

The two application shortcuts look for a matching window on the active workspace first and only launch when none is there. Launching goes through the session context, so the browser gets the sentinel URL of that session and the git client the matching repository. Outside a session both simply open normally.

All four are free of system bindings. `<Super>B` was the obvious choice for the browser but is taken by `media-keys www`, and `<Super>V` by `toggle-message-tray`. C, D and E sit together on the keyboard, which keeps the three application shortcuts within one hand position.

## Following workspace switches

Rather than intercepting the workspace shortcuts, the extension listens on `workspace-switched`. That covers every way a workspace can be reached, including the overview and touchpad gestures, and keeps the standard bindings intact.

On arriving at a workspace that belongs to a session, the git client switches repository and follows along. A guard on the last followed session prevents repeating that when the same workspace is reached again. Window claiming is only armed when the git client is not running, since a cold start has no window to move at that point.

Activating a session from the picker therefore only activates its workspace, everything else happens in the switch handler.

## Snapping

Holding a modifier while dragging a window highlights the zone under the pointer and places the window there on release. `snap-modifier` selects the key, Control by default.

The zones come from `snap-presets`, a list of named layouts whose tiles are fractions of the work area. `snap-preset` holds the index of the active one. The defaults were taken over from the `tilingshell` configuration that was in use before, unchanged including their odd fractions.

The picker carries a row of preset buttons along its bottom edge, each drawing its layout in miniature rather than using an icon, which makes them self explanatory. Clicking one switches the active preset. The row stays hidden while fewer than two presets exist.

The buttons are spread evenly across the bar rather than left aligned. `St.BoxLayout` offers no space distribution of its own, so each button expands into an equal slot while keeping its natural size through `x_align: CENTER`. The spacing in the stylesheet then only guarantees a minimum gap for a narrow bar.

There is no editor for the presets yet, they are JSON in the setting. A graphical one belongs in `prefs.js`, where GTK4 and Adwaita are available. Noted as an idea, not implemented.

The shell exposes no motion signal to extensions, so the pointer is polled at 60 ms between `grab-op-begin` and `grab-op-end`. Polling only runs during a drag. `global.get_pointer` returns the modifier state alongside the coordinates, which avoids having to track key events separately.

The preview carries `tile-preview`, the class the shell uses for its own snap indicator, so fill and border follow the accent colour without defining either.

It is animated: fading in where it first appears, then gliding between zones as the pointer moves, and fading out on release. Without that it would jump between zones and read as several indicators rather than one travelling object. `St.Settings.get().enable_animations` is honoured, so with animations turned off the geometry is set directly. Running transitions are cleared before each change, otherwise a fast pointer would queue them up.

The window itself is not animated. Its geometry is set through `move_resize_frame`, which the compositor applies immediately.

This overlaps with a tiling extension only in the drag interaction. The layout itself hangs off a different axis here: `tilingshell` keys its `selected-layouts` to the GNOME workspace index, while a session gets its workspace assigned dynamically and would therefore carry the layout of whichever project sat on that index before.

## Detail view

A session row opens a detail view with the Right arrow key, showing every window of that workspace as a card with a live preview, its application name and its title. Selecting a card activates that window through `Main.activateWindow`, which also switches to its workspace. Escape and the Left arrow key return.

Previews here use the aspect ratio of the individual window rather than that of the work area, since a card shows one window instead of a whole workspace.

**Browser tabs cannot be listed there.** They are only known to the Chrome extension, which keeps them in `chrome.storage.local`. That store is a LevelDB inside the browser profile and is not readable from the shell in any reasonable way. A bridge would be needed, and the least invasive one appears to be a native messaging host: the Chrome extension hands its state to a small script through `chrome.runtime.sendNativeMessage`, the script writes it to `~/.local/state/xiws/`, and the shell extension reads that file. This avoids a socket and the MV3 service worker lifetime problem, since the host only runs for the duration of a message. Not implemented.

## Styling

The dialog reuses the style classes of the shell instead of defining its own appearance. `search-entry` for the search field, `list-search-result` with `list-search-result-title` and `list-search-result-description` for the rows, and `icon-button` for the close button. Focus rings, hover states, the accent colour and the switch between light and dark are inherited that way and need no maintenance.

The extension stylesheet therefore contains layout only, no colours. Hardcoding them would break both the light theme and user themes, and the shell resolves accent colours through its own CSS functions such as `-st-accent-color`, which are not worth reproducing.

The theme shipped with the running shell is the reference for this, readable through `gresource extract /usr/share/gnome-shell/gnome-shell-theme.gresource /org/gnome/shell/theme/gnome-shell-dark.css`. That is more reliable than any guide, since it matches the installed version.

## Verified findings

Checked on 2026-09-05 against GNOME Shell 48.7 on Wayland and Google Chrome 152.

**The GitHub Desktop CLI path does not work.** `github open <path>` fails with `Error: Unsupported platform`. In the bundle under `/usr/lib/github-desktop/resources/app/cli.js` the platform specific function for `open` and `clone` is a stub that always throws. This goes unnoticed in daily use because the shell wrapper detaches the process into the background.

**The URL scheme does work.** `x-github-client://openRepo/<url>` is parsed in `main.js` into the action `open-repository-from-url` and handled in the renderer by `openRepositoryFromUrl`. The handler is already registered on `github-desktop.desktop`. Invoking it through `xdg-open` switched the repository in the running window. Optional query parameters according to the parser: `branch`, `pr`, `filepath`.

Resolution happens through the remote URL, not through the local path. An action `open-repository-from-path` does not exist in the bundle. For SSH remotes the rewritten https form is sufficient:

```bash
git -C "$path" remote get-url origin \
  | sed -E 's#^git@github\.com:#https://github.com/#; s#\.git$##'
```

Repositories without a remote presumably cannot be addressed this way. A fallback without repository selection should be provided for that case.

**Separate GitHub Desktop instances were tested and rejected.** A dedicated `--user-data-dir` does split the single instance lock, a second instance starts independently. The cost is a separate login per data directory plus roughly 15 MB per directory in its initial state.

**Window control is only possible from inside the shell.** On Wayland no external process can activate a window or move it to a workspace. `org.gnome.Shell.Eval` has been locked down since GNOME 41. A CLI is therefore ruled out as the primary interface, the logic belongs into the extension.

**The required shell APIs are backed by a local example.** The installed extension `clipboard-history@alexsaveau.dev` uses the same building blocks and covers GNOME 46 through 50:

| Building block                   | Use                                             |
| -------------------------------- | ----------------------------------------------- |
| `Main.wm.addKeybinding`          | shortcut with `Shell.ActionMode.ALL`            |
| `St.Entry` inside a `PanelMenu`  | search field                                    |
| `global.stage.set_key_focus`     | focus after opening, navigation within the list |
| `ensureActorVisibleInScrollView` | scrolling for long lists                        |

**Tab groups cannot be driven from outside.** Chrome 152 supports saved tab groups that survive restarts. There is however no command line option for them, and the DevTools protocol does not cover tab groups. They are only reachable programmatically through the `chrome.tabGroups` API from inside an extension. Tab groups are therefore useful for structuring a single window, not as the carrier of workspace separation.

**A `chrome-extension://` URL is not usable as a trigger.** According to the documentation on `web_accessible_resources`, a navigation from a web origin to an extension resource is blocked unless the resource is declared web accessible. Reports from the Puppeteer context show the same behaviour with `ERR_BLOCKED_BY_CLIENT`. Declaring the page web accessible would at the same time expose it to arbitrary websites, and hardening it through `use_dynamic_url` is ruled out because the identifier is regenerated per browser session and is therefore not stable enough to be invoked.

A sentinel URL is used instead. It is opened from the command line and picked up by the Chrome extension before the browser leaves for the network:

```
google-chrome --new-window "https://xiws.invalid/open?ws=my-system&url=https%3A%2F%2Fgithub.com%2Fxi72yow%2Fmy-system"
```

The extension recognises the tab already in `chrome.tabs.onCreated` through its `pendingUrl`, so before navigation begins. It restores the stored tabs into the new window and removes the sentinel tab. This works without `webNavigation` and without host permissions, `tabs` and `storage` are sufficient.

The optional `url` parameters act as the initial set. They only apply when no state is stored for the workspace yet. Existing state always takes precedence.

**The durable copy lives in bookmarks.** A folder `xiws` under Other Bookmarks holds one subfolder per workspace with its tabs in order. The reserved workspace is the one name that is not taken over verbatim: `__home__` is mapped to `Persönlich` for the folder title, since the key is an internal marker and the bookmark manager is user facing. The mapping sits in the Chrome extension and covers reading as well as writing, so `home-label` can be renamed on the shell side without orphaning the folder. Chrome numbers its roots 1 for the bookmarks bar, 2 for other and 3 for mobile bookmarks. Falling back to the last child when the id lookup fails put the folder under mobile bookmarks, so the second position is used as the fallback instead. Chrome carries bookmarks into the account and the bookmark manager exports them as HTML, so cloud sync and backup are covered by a mechanism Chrome maintains itself.

`chrome.storage.sync` was considered first and rejected. Its quotas are around 8 kB per item and 100 kB in total, which does not hold this amount of data. Trimming to fit would silently lose tabs, and a backup that quietly discards data is worse than none.

`chrome.storage.local` remains the working copy, but only as a buffer. When `windows.onRemoved` fires, the tabs of that window are already gone, so the state has to have been recorded beforehand. And an MV3 service worker is torn down after a short idle period, so that buffer has to be persistent. Writing to bookmarks on every tab change instead would mean rebuilding the folder on every navigation.

Both copies hold the same thing, url, title and order. Restoring prefers the local one and falls back to bookmarks, so a workspace unknown locally still returns from what the account carries.

Bookmarks are written when a workspace window closes, which is the point at which its state is final. A crash or a browser shutdown can skip that, so an alarm sweeps every five minutes as a safety net. Both compare the folder against the stored tabs first and do nothing when they match, which keeps sync traffic down.

Restored tabs are discarded once they have finished loading, which frees the memory behind them while title and favicon stay in the tab strip.

Discarding them immediately after creation does not work, even though that would avoid the initial load entirely. A tab that never completed has no state to return to and stays stuck showing `about:blank` as "loading". The discard therefore waits for `status === 'complete'` through `chrome.tabs.onUpdated`, with a second listener on `onRemoved` so a tab closed in the meantime does not leave the first one registered.

The tab that becomes active after the sentinel is removed cannot be discarded, which is the intended outcome for it.

The TLD `.invalid` is reserved by RFC 2606 and never resolves, so with the extension inactive only an error tab appears and nothing leaves the machine.

Sources: [web_accessible_resources](https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources), [Puppeteer issue 1796](https://github.com/puppeteer/puppeteer/issues/1796)

**The sentinel mechanism was implemented and verified.** The Chrome extension under `chrome/xiws/` was tested against Chrome 152, loaded as an unpacked extension.

| Checked                                                            | Result                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------ |
| sentinel detection through `pendingUrl` in `chrome.tabs.onCreated` | applies before navigation starts                       |
| removal of the sentinel tab after restoring                        | happens, the sentinel URL does not appear in the state |
| initial set through `url` parameters                               | only applies without stored state                      |
| snapshot on tab changes                                            | picks up added tabs                                    |
| `removeInfo.isWindowClosing` in `chrome.tabs.onRemoved`            | prevents the state from draining on window close       |
| stored state taking precedence over the initial set                | confirmed                                              |

Tearing down a window removes every tab one by one. Without the check on `isWindowClosing` the state would shrink tab by tab and end up stored empty. This is the most critical pitfall of the mechanism.

**Snapshots are debounced.** During the test the state was written once per tab event, six times in a row. Writes are now collected over 400 ms per window. This introduces a second pitfall: a pending snapshot must not outlive its window, otherwise it would query a window that is gone and overwrite the state that was valid right before the close. Two safeguards cover this, a cancel in `chrome.windows.onRemoved` and a guard against empty query results, since a live window always holds at least one tab.

**GitHub Desktop ships no `StartupWMClass`** and runs natively on Wayland, so its window class cannot be read through `xprop`. Its manifest declares `name` as `github-desktop` and `productName` as `GitHub Desktop`, and Electron derives the class from one of the two. Both normalize to the same value, so the configured entry matches either way. Adding a `StartupWMClass` on the packaging side would remove the ambiguity and also help GNOME associate windows with the application in general.

**Applications must not be launched through `GLib.spawn`** from within the extension, otherwise they end up as child processes of `gnome-shell`. Launching goes through `Gio.AppInfo` respectively `Shell.AppSystem`, which places them into their own systemd scopes.

**A per cent sign in the commandline has to be escaped.** `Gio.AppInfo.create_from_commandline` parses its argument as a desktop entry exec string, in which `%` opens a field code. The `%2F` of a percent encoded workspace name was therefore read as the unknown code `%2`, dropped, and left its `F` behind: `trunshopdev/trunshop24` arrived at the Chrome extension as `trunshopdevFtrunshop24`, and its bookmark folder carries that name. Verified by launching a script that prints its arguments, once with and once without escaping. Since no invocation here ever means a field code, `launch` doubles every per cent sign, which the specification defines as the escape for a literal one.

Folders written under the old names stay behind and are not migrated. They are orphaned rather than lost, since the state is written again as soon as such a workspace closes.

## Settings

All of these live under `/org/gnome/shell/extensions/xiws/` and can be dumped with `dconf dump` for backup.

| Key                          | Default                             | Purpose                                                   |
| ---------------------------- | ----------------------------------- | --------------------------------------------------------- |
| `toggle-picker`              | `<Super>W`                          | open the workspace picker                                 |
| `toggle-clipboard`           | `<Super>C`                          | open the clipboard history                                |
| `open-browser`               | `<Super>E`                          | browser of the current session                            |
| `open-git`                   | `<Super>D`                          | git client for the current session                        |
| `search-paths`               | `~/Schreibtisch`, `~/Workplace`     | where repositories are looked for                         |
| `search-depth`               | 3                                   | levels below a search path                                |
| `search-exclude`             | `node_modules` and similar          | never descended into                                      |
| `recent-workspaces`          | empty                               | most recently opened, written automatically               |
| `recent-count`               | 7                                   | how many are listed without a search                      |
| `home-label`                 | Persönlich                          | name of the reserved workspace                            |
| `first-workspace-index`      | 1                                   | lowest workspace usable for sessions                      |
| `editor-command`             | `zed --new`                         | project path is appended                                  |
| `editor-desktop-id`          | `dev.zed.Zed.desktop`               | for detection and restoring                               |
| `browser-command`            | `google-chrome`                     |                                                           |
| `browser-desktop-id`         | `google-chrome.desktop`             | also used to check whether it runs                        |
| `git-desktop-id`             | `github-desktop.desktop`            | the application that follows sessions                     |
| `session-desktop-ids`        | editor, browser, git                | whose windows are moved onto a session                    |
| `claim-window-classes`       | empty                               | fallback for windows without an application               |
| `claim-seconds`              | 25                                  | how long new windows are claimed                          |
| `session-layout`             | Chrome left, Zed right, git centred | default arrangement                                       |
| `session-apps`               | empty                               | captured arrangement per workspace, written automatically |
| `snap-presets`               | four layouts                        | zones for drag snapping                                   |
| `snap-preset`                | 0                                   | which one is active                                       |
| `snap-modifier`              | control                             | armed while dragging                                      |
| `clipboard-size`             | 200                                 | entries kept                                              |
| `clipboard-ignore-passwords` | true                                | skip password manager entries                             |

## Open

A graphical editor for the snap presets, which belongs in `prefs.js`.

Listing browser tabs in the detail view, which needs a bridge to the Chrome extension.

Pattern exclusion and encrypted storage for the clipboard, see [clipboard.md](clipboard.md).

Session state does not survive a restart of `gnome-shell`. A store under `~/.local/state/xiws/` with reconstruction on extension load is conceivable.

Packaging the Chrome extension as a `.deb`. The path is clear: on Linux a preferences file under `/usr/share/google-chrome/extensions/<id>.json` may point to a local CRX, so no store listing, policy or update server is needed. An update raises `external_version` and Chrome picks it up on the next start, which keeps APT as the only update channel. Open is the signature, since the extension id derives from the public key and that key has to be kept outside the repository. Source: [Install extensions on Linux](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)

Whether xiws stays standalone or moves into the planned meta extension `xios-shell`. A dedicated UUID is simpler while developing.

Rebinding Chrome windows after a browser restart. With `restore_on_startup` at 1 Chrome restores its windows itself, and those carry no session binding since that lives in `chrome.storage.session`. They then stop recording, and opening the session later produces a second window. Either the setting goes to 5 or the windows are matched against the stored states in `chrome.runtime.onStartup`.

A window moved to another workspace keeps its original session in the Chrome extension, since the binding is made once on open and Chrome knows nothing about GNOME workspaces. Same bridge, same idea.
