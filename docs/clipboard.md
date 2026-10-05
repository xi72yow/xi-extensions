# Clipboard in xiws

A clipboard history that keeps nothing on disk. The session history lives in memory, and what is meant to last is marked as a favourite and goes into the keyring.

## Why not take the existing extension

`clipboard-history@alexsaveau.dev` works and is MIT licensed, so taking it over would be permitted. It carries roughly 2800 lines though, most of them for things not needed here: image entries, notifications and its own preferences window.

The reason to bring the clipboard into xiws is not code reuse either. It is context. xiws knows which project a workspace belongs to, and a clipboard that knows the same becomes a different tool. That part is not built yet, see the ideas below.

Its storage layout was still worth reading, and the import script relies on it: an append only log of five operations, with entry ids handed out in the order the save ops appear. `scripts/import-clipboard-favourites.js` parses that log and carries the favourites over into the keyring.

## Storage

**The history is never written.** It holds what was copied during the session and is gone on logout, a shell crash included. The earlier revision kept it in `~/.local/share/xiws/clipboard.json`, which on this machine amounted to 146 kB of plain text, credentials among them, carried into every backup of the home directory. Storing it encrypted was examined and dropped: GJS reaches no symmetric cipher through introspection, so every write would have meant an `openssl enc` subprocess.

**Favourites go into the keyring**, through `Secret` and therefore `gnome-keyring`, which is unlocked with the session. That splits the two along what actually needs protecting: the volatile part never reaches a disk, the durable part reaches one encrypted.

The whole list travels as a single secret holding JSON rather than one secret per entry. It keeps the order without an index attribute, costs one lookup instead of a search plus a retrieval per item, and avoids pushing a per entry search through D-Bus. That objection was the reason an earlier revision rejected the keyring for the history as a whole, and it still holds there: thousands of volatile entries do not belong in the secret service, a handful of deliberate favourites do.

| Part       | Approach                                                                               |
| ---------- | -------------------------------------------------------------------------------------- |
| Watching   | `owner-changed` on `global.display.get_selection()`, filtered to `SELECTION_CLIPBOARD` |
| History    | in memory, capped by `clipboard-size`                                                  |
| Favourites | one `Secret` item under the schema `dev.xi72yow.xiws.Clipboard`                        |
| Pasting    | writes back through `St.Clipboard.set_text`                                            |

## Ordering

A favourite keeps its position when picked. Only the marker moves, so the list a user builds deliberately stays where it was put and stays navigable by muscle memory. An ordinary entry travels to the top instead, because the history is a recency list and that is what makes it useful.

The entry that was pasted last is marked by its icon rather than by its position, which is what makes the difference visible without rearranging anything.

## Interface

A panel button opens the list below its icon, the way the shell places its own menus, rather than a dialog in the middle of the screen. The search field sits at the top of the menu and takes the key focus on open, so typing filters immediately. `<Super>C` toggles the same menu.

Favourites are listed first, the history below, each row carrying a star to move an entry between the two and, for history rows, a delete button. Those buttons act without closing the menu, while activating a row pastes and closes.

## Migration

Run as `gjs -m scripts/import-clipboard-favourites.js`, the `-m` being required since gjs treats a plain `.js` as a script in which import declarations are a syntax error. An optional path argument points it at a backup copy of the log instead of the live one.

It reads the favourites out of the foreign log and writes them into the keyring entry, merging with whatever is already there unless `--replace` is passed. It prints counts only, never contents, since the entries are credentials more often than not.

It should run while the extension is not writing the same secret, so before enabling xiws or with the menu closed, otherwise the two overwrite each other's version of the list.

## Ideas, not implemented

**Session tagged entries.** The active workspace at copy time resolves to a session, which would be recorded alongside the entry. The picker could then default to the current project, with everything else one keystroke away. Copying a connection string in one project and pasting it in another becomes a deliberate act rather than an accident of ordering.

**Pattern exclusion.** Refusing to store content that looks like a secret, `-----BEGIN`, `ghp_`, `sk-`, long base64 runs. With the history volatile this matters less than it did, but it would still keep such content out of the list a shoulder can read.

What does already work is the password manager hint: managers announce their entries through the `x-kde-passwordManagerHint` mime type and those are skipped. It covers managers that set it and misses everything else.

The limit of the keyring is worth stating: while the session runs it is unlocked and the favourites are readable by anything running as the user. It protects against access to the powered off disk, so theft or a backup, not against code running in the live session.
