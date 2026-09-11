# Clipboard in xiws

A minimal clipboard history, sharing the picker with the workspace side. History is global for now, the session tag remains an idea.

## Why not take the existing extension

`clipboard-history@alexsaveau.dev` works and is MIT licensed, so taking it over would be permitted. It carries roughly 2800 lines though, most of them for things not needed here: favourites, image entries, private mode, notifications and its own preferences window.

The reason to bring the clipboard into xiws is not code reuse either. It is context. xiws knows which project a workspace belongs to, and a clipboard that knows the same becomes a different tool. That part is not built yet, see the ideas below.

## Implementation

| Part     | Approach                                                                               |
| -------- | -------------------------------------------------------------------------------------- |
| Watching | `owner-changed` on `global.display.get_selection()`, filtered to `SELECTION_CLIPBOARD` |
| Storage  | `~/.local/share/xiws/clipboard.json`, written with `Gio.FileCreateFlags.PRIVATE`       |
| Picker   | `SearchDialog`, the same base the workspace picker uses                                |
| Removing | Delete on a focused row drops that entry                                               |
| Pasting  | writes back through `St.Clipboard.set_text`                                            |

`clipboard-size` caps the history at 200 entries, `clipboard-ignore-passwords` controls the hint check and defaults to on. Copying something already in the history moves it to the front rather than duplicating it.

Rows show the text collapsed to a single line, with length and line count as the subtitle, so a multi line snippet stays recognisable without inflating the list.

Deliberately left out: images, favourites, a private mode and a preferences window.

## The shared picker

`lib/searchDialog.js` holds what both pickers need: a centred modal dialog with a search field, a scrollable list, keyboard navigation and Escape to close. Subclasses override `render` to fill the list and `handleRowKey` to react to keys on a focused row before navigation runs.

The workspace picker adds session rows with thumbnails and the preset bar, the clipboard picker adds text rows. Nothing else differs.

## Ideas, not implemented

**Session tagged entries.** The active workspace at copy time resolves to a session, which would be recorded alongside the entry. The picker could then default to the current project, with everything else one keystroke away. Copying a connection string in one project and pasting it in another becomes a deliberate act rather than an accident of ordering.

**Pattern exclusion.** Refusing to store content that looks like a secret, `-----BEGIN`, `ghp_`, `sk-`, long base64 runs. Cheap and aimed exactly at the sources that set no password hint, meaning browsers, terminals and editors.

**Encrypted storage.** The history sits in plain text, and the root partition on this machine is ext4 without encryption, so anything copied is readable from the disk itself. Encrypting the file and keeping only the key in the keyring would be one item instead of thousands. `Secret-1` is available for the key; `Gcr-4` targets certificates and PKCS#11 rather than symmetric encryption, so the encryption itself would go through an `openssl enc` subprocess.

Writing the entries into the keyring directly was considered and rejected. The secret service stores one item per secret over D-Bus, which does not scale to thousands of entries and would push the search through D-Bus as well.

The limit of encryption here is worth stating: while the session runs, the keyring is unlocked and the key available. It protects against access to the powered off disk, so theft or a backup, not against code running in the live session. Full disk encryption would be the larger lever, but that means reinstalling.

What does already work is the password manager hint: managers announce their entries through the `x-kde-passwordManagerHint` mime type and those are skipped. It covers managers that set it and misses everything else.
