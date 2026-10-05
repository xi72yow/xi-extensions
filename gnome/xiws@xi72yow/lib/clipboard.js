import Clutter from 'gi://Clutter'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import GObject from 'gi://GObject'
import Meta from 'gi://Meta'
import Secret from 'gi://Secret'
import St from 'gi://St'

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js'
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js'

const PASSWORD_HINT = 'x-kde-passwordManagerHint'
const PREVIEW_LENGTH = 70
const MENU_WIDTH = 420
const LIST_HEIGHT = 360
const THUMBNAIL_SIZE = 48

// images are spooled into the runtime directory rather than held in the shell
// process: it is a tmpfs owned by the user and taken down with the session, so
// the bytes stay out of both the compositor heap and any persistent disk
function spoolDir() {
  const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'xiws', 'clipboard'])
  GLib.mkdir_with_parents(dir, 0o700)
  return dir
}

// the whole list travels as one secret rather than one secret per entry: it
// keeps the order without an index attribute and costs a single lookup
const FAVOURITES_SCHEMA = Secret.Schema.new('dev.xi72yow.xiws.Clipboard', Secret.SchemaFlags.NONE, {
  store: Secret.SchemaAttributeType.STRING,
})
const FAVOURITES_ATTRIBUTES = { store: 'favourites' }
const FAVOURITES_LABEL = 'xiws clipboard favourites'

function collapse(text) {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > PREVIEW_LENGTH ? `${single.slice(0, PREVIEW_LENGTH)}…` : single
}

// the history never reaches the disk. it holds whatever was copied during the
// session, which on this machine is largely credentials, and a file would
// carry those into every backup of the home directory. what is meant to last
// is marked as a favourite and goes into the keyring instead.
export class ClipboardHistory {
  constructor(settings) {
    this._settings = settings
    this._entries = []
    this._favourites = []
    this._lastUsed = null
    this._onChanged = null
    this._spooled = 0

    this._selection = global.display.get_selection()
    this._ownerChangedId = this._selection.connect('owner-changed', (selection, type) => {
      if (type === Meta.SelectionType.SELECTION_CLIPBOARD) this._onClipboardChanged()
    })

    this._loadFavourites()
  }

  destroy() {
    if (this._ownerChangedId) {
      this._selection.disconnect(this._ownerChangedId)
      this._ownerChangedId = 0
    }

    this._discard(this._entries)
    this._entries = []
    this._onChanged = null
  }

  connectChanged(callback) {
    this._onChanged = callback
  }

  get entries() {
    return this._entries
  }

  get favourites() {
    return this._favourites
  }

  get lastUsed() {
    return this._lastUsed
  }

  isFavourite(text) {
    return typeof text === 'string' && this._favourites.some((entry) => entry.text === text)
  }

  // text entries are compared by their content, images by the file they were
  // spooled into, which is unique per copy
  key(entry) {
    return entry.kind === 'image' ? entry.path : entry.text
  }

  // a favourite keeps its place when picked, only the marker moves. an
  // ordinary entry travels to the top, since the history is a recency list
  paste(entry) {
    const clipboard = St.Clipboard.get_default()

    if (entry.kind === 'image') {
      let bytes
      try {
        const [ok, data] = GLib.file_get_contents(entry.path)
        if (!ok) return
        bytes = new GLib.Bytes(data)
      } catch (error) {
        logError(error, 'xiws: the spooled image is gone')
        return
      }

      clipboard.set_content(St.ClipboardType.CLIPBOARD, entry.mimetype, bytes)
      this._lastUsed = entry.path
      this._notify()
      return
    }

    clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.text)
    this._lastUsed = entry.text

    if (!this.isFavourite(entry.text)) {
      this._entries = [
        { kind: 'text', text: entry.text, at: Date.now() },
        ...this._entries.filter((candidate) => this.key(candidate) !== entry.text),
      ]
    }

    this._notify()
  }

  addFavourite(text) {
    if (this.isFavourite(text)) return

    this._favourites = [...this._favourites, { text, at: Date.now() }]
    this._entries = this._entries.filter((entry) => entry.text !== text)
    this._storeFavourites()
    this._notify()
  }

  removeFavourite(text) {
    this._favourites = this._favourites.filter((entry) => entry.text !== text)
    this._storeFavourites()
    this._notify()
  }

  forget(entry) {
    this._discard([entry])
    this._entries = this._entries.filter((candidate) => this.key(candidate) !== this.key(entry))
    this._notify()
  }

  clear() {
    this._discard(this._entries)
    this._entries = []
    this._notify()
  }

  _notify() {
    this._onChanged?.()
  }

  _onClipboardChanged() {
    const clipboard = St.Clipboard.get_default()
    const mimetypes = clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD)

    // password managers announce their entries through this mime type, which
    // is the only reliable way to keep credentials out of the history
    if (
      this._settings.get_boolean('clipboard-ignore-passwords') &&
      mimetypes.includes(PASSWORD_HINT)
    ) {
      return
    }

    // a copied image offers image/* and nothing textual, while rich text
    // offers text/plain alongside its markup. taking the image only when no
    // plain text is on offer keeps ordinary copies out of the spool.
    const image = mimetypes.find((type) => type.startsWith('image/'))
    if (image && !mimetypes.includes('text/plain')) {
      this._rememberImage(clipboard, image)
      return
    }

    clipboard.get_text(St.ClipboardType.CLIPBOARD, (source, text) => {
      if (typeof text !== 'string' || text.trim().length === 0) return
      this._remember(text)
    })
  }

  _rememberImage(clipboard, mimetype) {
    clipboard.get_content(St.ClipboardType.CLIPBOARD, mimetype, (source, bytes) => {
      const data = bytes?.get_data()
      if (!data || data.length === 0) return

      const suffix = mimetype.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin'
      const path = GLib.build_filenamev([spoolDir(), `${Date.now()}-${this._spooled++}.${suffix}`])

      try {
        Gio.File.new_for_path(path).replace_contents(
          data,
          null,
          false,
          Gio.FileCreateFlags.PRIVATE,
          null,
        )
      } catch (error) {
        logError(error, 'xiws: could not spool the copied image')
        return
      }

      const limit = Math.max(this._settings.get_int('clipboard-size'), 1)
      this._entries = [{ kind: 'image', path, mimetype, at: Date.now() }, ...this._entries]
      this._discard(this._entries.slice(limit))
      this._entries = this._entries.slice(0, limit)

      this._lastUsed = path
      this._notify()
    })
  }

  // a spooled image outlives its entry otherwise, and the runtime directory is
  // only cleared when the session ends
  _discard(entries) {
    for (const entry of entries) {
      if (entry.kind !== 'image') continue

      try {
        Gio.File.new_for_path(entry.path).delete(null)
      } catch {
        // already gone, nothing to do
      }
    }
  }

  _remember(text) {
    // the mark follows the clipboard rather than the menu, otherwise it would
    // keep pointing at an entry that was replaced by a copy made elsewhere
    this._lastUsed = text

    if (this.isFavourite(text)) {
      this._notify()
      return
    }

    const limit = Math.max(this._settings.get_int('clipboard-size'), 1)

    const kept = [
      { kind: 'text', text, at: Date.now() },
      ...this._entries.filter((entry) => this.key(entry) !== text),
    ]

    this._discard(kept.slice(limit))
    this._entries = kept.slice(0, limit)

    this._notify()
  }

  // the keyring is unlocked with the session, so the lookup only has to be
  // asynchronous rather than interactive
  _loadFavourites() {
    Secret.password_lookup(FAVOURITES_SCHEMA, FAVOURITES_ATTRIBUTES, null, (source, result) => {
      let raw
      try {
        raw = Secret.password_lookup_finish(result)
      } catch (error) {
        logError(error, 'xiws: could not read the clipboard favourites')
        return
      }
      if (!raw) return

      try {
        const parsed = JSON.parse(raw)
        this._favourites = Array.isArray(parsed)
          ? parsed.filter((entry) => typeof entry?.text === 'string')
          : []
      } catch (error) {
        logError(error, 'xiws: the stored clipboard favourites are not valid json')
        return
      }

      this._notify()
    })
  }

  _storeFavourites() {
    Secret.password_store(
      FAVOURITES_SCHEMA,
      FAVOURITES_ATTRIBUTES,
      Secret.COLLECTION_DEFAULT,
      FAVOURITES_LABEL,
      JSON.stringify(this._favourites),
      null,
      (source, result) => {
        try {
          Secret.password_store_finish(result)
        } catch (error) {
          logError(error, 'xiws: could not write the clipboard favourites')
        }
      },
    )
  }
}

// a row carries its own actions, so starring or dropping an entry does not
// close the menu the way activating it does
const ClipboardRow = GObject.registerClass(
  {
    Signals: {
      picked: {},
      starred: {},
      dropped: {},
    },
  },
  class ClipboardRow extends PopupMenu.PopupBaseMenuItem {
    _init(entry, { favourite, used }) {
      super._init()

      this.entry = entry

      if (used) this.add_style_class_name('xiws-clip-used')

      // only the entry that was pasted last carries a mark. the others keep an
      // empty slot of the same width, otherwise the labels would shift sideways
      // whenever the mark moves
      this.add_child(
        used
          ? new St.Icon({
              icon_name: 'object-select-symbolic',
              style_class: 'popup-menu-icon xiws-clip-mark',
            })
          : new St.Widget({ style_class: 'xiws-clip-mark' }),
      )

      if (entry.kind === 'image') {
        // the spool file is what the texture cache loads from, so the shell
        // keeps the scaled thumbnail rather than the full image
        this.add_child(
          new St.Icon({
            gicon: Gio.icon_new_for_string(entry.path),
            icon_size: THUMBNAIL_SIZE,
            style_class: 'xiws-clip-thumb',
          }),
        )
        this.add_child(
          new St.Label({
            text: entry.mimetype.replace('image/', '').toUpperCase(),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
          }),
        )
      } else {
        this.add_child(
          new St.Label({
            text: collapse(entry.text),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
          }),
        )
      }

      // an image cannot be starred: the keyring holds small secrets, not blobs
      if (entry.kind !== 'image') {
        const star = new St.Button({
          style_class: 'icon-button xiws-clip-action',
          child: new St.Icon({
            icon_name: favourite ? 'starred-symbolic' : 'non-starred-symbolic',
            style_class: 'popup-menu-icon',
          }),
          y_align: Clutter.ActorAlign.CENTER,
        })
        star.connect('clicked', () => this.emit('starred'))
        this.add_child(star)
      }

      if (!favourite) {
        const drop = new St.Button({
          style_class: 'icon-button xiws-clip-action',
          child: new St.Icon({
            icon_name: 'edit-delete-symbolic',
            style_class: 'popup-menu-icon',
          }),
          y_align: Clutter.ActorAlign.CENTER,
        })
        drop.connect('clicked', () => this.emit('dropped'))
        this.add_child(drop)
      }
    }

    activate(event) {
      this.emit('picked')
      super.activate(event)
    }
  },
)

// a panel button rather than a centred dialog: the list belongs next to the
// indicator it hangs off, the way the shell places its own menus
export const ClipboardIndicator = GObject.registerClass(
  class ClipboardIndicator extends PanelMenu.Button {
    _init(history) {
      super._init(0.5, 'xiws clipboard')

      this._history = history
      this._history.connectChanged(() => {
        if (this.menu.isOpen) this._render()
      })

      this.add_child(
        new St.Icon({ icon_name: 'edit-paste-symbolic', style_class: 'system-status-icon' }),
      )

      this._searchEntry = new St.Entry({
        style_class: 'search-entry xiws-clip-search',
        hint_text: 'Zwischenablage',
        can_focus: true,
        x_expand: true,
      })
      this._searchEntry.clutter_text.connect('text-changed', () => this._render())

      const search = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false })
      search.add_child(this._searchEntry)
      this.menu.addMenuItem(search)

      this._section = new PopupMenu.PopupMenuSection()

      this._scrollView = new St.ScrollView({
        style_class: 'xiws-clip-list',
        overlay_scrollbars: true,
        y_expand: true,
      })
      this._scrollView.add_child(this._section.actor)

      const list = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false })
      list.add_child(this._scrollView)
      this.menu.addMenuItem(list)

      this.menu.box.set_width(MENU_WIDTH)
      this._scrollView.set_height(LIST_HEIGHT)

      this.menu.connect('open-state-changed', (menu, open) => {
        if (!open) return

        this._searchEntry.set_text('')
        this._render()
        global.stage.set_key_focus(this._searchEntry.clutter_text)
      })
    }

    toggle() {
      this.menu.toggle()
    }

    _render() {
      this._section.removeAll()

      const needle = this._searchEntry.get_text().trim().toLowerCase()
      const matches = (entry) => !needle || entry.text.toLowerCase().includes(needle)

      const favourites = this._history.favourites.filter(matches)
      const entries = this._history.entries.filter(matches)

      if (favourites.length > 0) {
        this._addHeading('Favoriten')
        for (const entry of favourites) this._addRow(entry, true)
      }

      if (entries.length > 0) {
        if (favourites.length > 0) this._addSeparator()
        this._addHeading('Verlauf')
        for (const entry of entries) this._addRow(entry, false)
      }

      if (favourites.length === 0 && entries.length === 0) {
        const empty = new PopupMenu.PopupMenuItem(
          needle ? 'Nichts gefunden' : 'Noch nichts kopiert',
        )
        empty.setSensitive(false)
        this._section.addMenuItem(empty)
      }
    }

    _addHeading(text) {
      const heading = new PopupMenu.PopupMenuItem(text, { reactive: false, can_focus: false })
      heading.add_style_class_name('xiws-clip-heading')
      this._section.addMenuItem(heading)
    }

    _addSeparator() {
      this._section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem())
    }

    _addRow(entry, favourite) {
      const row = new ClipboardRow(entry, {
        favourite,
        used: this._history.lastUsed === this._history.key(entry),
      })

      row.connect('picked', () => this._history.paste(entry))
      row.connect('starred', () => {
        if (favourite) {
          this._history.removeFavourite(entry.text)
        } else {
          this._history.addFavourite(entry.text)
        }
        this._render()
      })
      row.connect('dropped', () => {
        this._history.forget(entry)
        this._render()
      })

      this._section.addMenuItem(row)
    }
  },
)
