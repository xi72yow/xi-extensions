#!/usr/bin/env gjs
// Imports the favourites of clipboard-history@alexsaveau.dev into the keyring
// entry xiws reads.
//
// Usage: gjs scripts/import-clipboard-favourites.js [--replace]
//
// Nothing is printed but counts: the entries are credentials more often than
// not, so they travel from the log into the keyring without passing through a
// terminal. Run it while the shell extension is not writing, that is before
// enabling xiws or with the clipboard menu closed, so the two do not overwrite
// each other's version of the list.

import GLib from 'gi://GLib'
import Secret from 'gi://Secret'

const SOURCE = GLib.build_filenamev([
  GLib.get_user_cache_dir(),
  'clipboard-history@alexsaveau.dev',
  'database.log',
])

const SCHEMA = Secret.Schema.new('dev.xi72yow.xiws.Clipboard', Secret.SchemaFlags.NONE, {
  store: Secret.SchemaAttributeType.STRING,
})
const ATTRIBUTES = { store: 'favourites' }
const LABEL = 'xiws clipboard favourites'

// the foreign store is an append only log of five operations, with ids handed
// out in the order the save ops appear. see store.js of that extension.
const OP_SAVE = 1
const OP_DELETE = 2
const OP_FAVOURITE = 3
const OP_UNFAVOURITE = 4
const OP_MOVE = 5

function readFavourites(path) {
  const [ok, bytes] = GLib.file_get_contents(path)
  if (!ok) throw new Error(`cannot read ${path}`)

  const decoder = new TextDecoder()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const texts = new Map()
  const favourite = new Map()
  const order = []
  let nextId = 1
  let offset = 0

  while (offset < bytes.length) {
    const op = bytes[offset]
    offset += 1

    if (op === OP_SAVE) {
      let end = offset
      while (end < bytes.length && bytes[end] !== 0) end += 1
      if (end >= bytes.length) break

      const id = nextId++
      texts.set(id, decoder.decode(bytes.subarray(offset, end)))
      favourite.set(id, false)
      order.push(id)
      offset = end + 1
      continue
    }

    if (op === OP_DELETE || op === OP_FAVOURITE || op === OP_UNFAVOURITE || op === OP_MOVE) {
      if (offset + 4 > bytes.length) break
      const id = view.getUint32(offset, true)
      offset += 4

      if (op === OP_DELETE) {
        texts.delete(id)
        favourite.delete(id)
      } else if (op === OP_FAVOURITE && favourite.has(id)) {
        favourite.set(id, true)
      } else if (op === OP_UNFAVOURITE && favourite.has(id)) {
        favourite.set(id, false)
      }
      continue
    }

    // an unknown opcode means the log is out of sync, the rest is unusable
    break
  }

  return order
    .filter((id) => favourite.get(id) && texts.has(id))
    .map((id) => ({ text: texts.get(id), at: Date.now() }))
}

function existing() {
  const raw = Secret.password_lookup_sync(SCHEMA, ATTRIBUTES, null)
  if (!raw) return []

  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry?.text === 'string') : []
}

const replace = ARGV.includes('--replace')
const imported = readFavourites(SOURCE)
const current = replace ? [] : existing()

const seen = new Set(current.map((entry) => entry.text))
const added = imported.filter((entry) => !seen.has(entry.text))
const merged = [...current, ...added]

Secret.password_store_sync(
  SCHEMA,
  ATTRIBUTES,
  Secret.COLLECTION_DEFAULT,
  LABEL,
  JSON.stringify(merged),
  null,
)

print(`found in the log : ${imported.length}`)
print(`already present  : ${imported.length - added.length}`)
print(`added            : ${added.length}`)
print(`now stored       : ${merged.length}`)
