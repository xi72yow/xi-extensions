import Clutter from 'gi://Clutter'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import GObject from 'gi://GObject'
import Meta from 'gi://Meta'
import St from 'gi://St'

import { ResultRow, SearchDialog } from './searchDialog.js'

const PASSWORD_HINT = 'x-kde-passwordManagerHint'
const PREVIEW_LENGTH = 220

function stateFile() {
  const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'xiws'])
  GLib.mkdir_with_parents(dir, 0o700)
  return GLib.build_filenamev([dir, 'clipboard.json'])
}

function collapse(text) {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > PREVIEW_LENGTH ? `${single.slice(0, PREVIEW_LENGTH)}…` : single
}

function describe(text) {
  const lines = text.split('\n').length
  const chars = text.length
  return lines > 1 ? `${chars} Zeichen, ${lines} Zeilen` : `${chars} Zeichen`
}

// history is kept globally rather than per session for now, the session tag
// is noted in docs/clipboard.md as an idea
export class ClipboardHistory {
  constructor(settings) {
    this._settings = settings
    this._entries = this._load()
    this._selection = global.display.get_selection()

    this._ownerChangedId = this._selection.connect('owner-changed', (selection, type) => {
      if (type === Meta.SelectionType.SELECTION_CLIPBOARD) this._onClipboardChanged()
    })
  }

  destroy() {
    if (this._ownerChangedId) {
      this._selection.disconnect(this._ownerChangedId)
      this._ownerChangedId = 0
    }
  }

  get entries() {
    return this._entries
  }

  paste(entry) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, entry.text)
  }

  forget(entry) {
    this._entries = this._entries.filter((candidate) => candidate.text !== entry.text)
    this._save()
  }

  clear() {
    this._entries = []
    this._save()
  }

  _onClipboardChanged() {
    const clipboard = St.Clipboard.get_default()

    // password managers announce their entries through this mime type, which
    // is the only reliable way to keep credentials out of the history
    if (
      this._settings.get_boolean('clipboard-ignore-passwords') &&
      clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD).includes(PASSWORD_HINT)
    ) {
      return
    }

    clipboard.get_text(St.ClipboardType.CLIPBOARD, (source, text) => {
      if (typeof text !== 'string' || text.trim().length === 0) return
      this._remember(text)
    })
  }

  _remember(text) {
    const limit = Math.max(this._settings.get_int('clipboard-size'), 1)

    this._entries = [
      { text, at: Date.now() },
      ...this._entries.filter((entry) => entry.text !== text),
    ].slice(0, limit)

    this._save()
  }

  _load() {
    try {
      const [ok, bytes] = GLib.file_get_contents(stateFile())
      if (!ok) return []

      const parsed = JSON.parse(new TextDecoder().decode(bytes))
      return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry?.text === 'string') : []
    } catch {
      return []
    }
  }

  _save() {
    try {
      const file = Gio.File.new_for_path(stateFile())
      file.replace_contents(
        new TextEncoder().encode(JSON.stringify(this._entries)),
        null,
        false,
        Gio.FileCreateFlags.PRIVATE,
        null,
      )
    } catch (error) {
      logError(error, 'xiws: could not write the clipboard history')
    }
  }
}

const ClipboardRow = GObject.registerClass(
  class ClipboardRow extends ResultRow {
    _init(entry) {
      super._init(collapse(entry.text), describe(entry.text))
      this.entry = entry
    }
  },
)

export const ClipboardPicker = GObject.registerClass(
  class ClipboardPicker extends SearchDialog {
    _init(history) {
      super._init({ hint: 'Zwischenablage' })
      this._history = history
    }

    handleRowKey(row, symbol) {
      if (symbol !== Clutter.KEY_Delete && symbol !== Clutter.KEY_KP_Delete) {
        return Clutter.EVENT_PROPAGATE
      }

      this._history.forget(row.entry)
      this.render()
      return Clutter.EVENT_STOP
    }

    render() {
      this.clearRows()

      const needle = this.needle
      const entries = needle
        ? this._history.entries.filter((entry) => entry.text.toLowerCase().includes(needle))
        : this._history.entries

      for (const entry of entries) {
        this.addRow(new ClipboardRow(entry), () => {
          this.close(global.get_current_time())
          this._history.paste(entry)
        })
      }
    }
  },
)
