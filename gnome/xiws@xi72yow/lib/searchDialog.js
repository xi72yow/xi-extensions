import Clutter from 'gi://Clutter'
import GObject from 'gi://GObject'
import St from 'gi://St'

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js'
import { ensureActorVisibleInScrollView } from 'resource:///org/gnome/shell/misc/animationUtils.js'

// shared base for the pickers: a centred dialog with a search field, a
// scrollable list and keyboard navigation. subclasses decide what to list
// and what activating a row does.
export const SearchDialog = GObject.registerClass(
  class SearchDialog extends ModalDialog.ModalDialog {
    _init({ styleClass = 'xiws-dialog', hint = '' } = {}) {
      super._init({ styleClass, destroyOnClose: false })

      this._rows = []
      this._gridRow = null

      this._searchEntry = new St.Entry({
        style_class: 'search-entry xiws-search',
        hint_text: hint,
        can_focus: true,
        x_expand: true,
      })
      this._searchEntry.clutter_text.connect('text-changed', () => this.render())
      this._searchEntry.clutter_text.connect('key-press-event', (actor, event) =>
        this._onSearchKey(event),
      )

      this._rowBox = new St.BoxLayout({ vertical: true, x_expand: true })

      this._scrollView = new St.ScrollView({
        style_class: 'xiws-list',
        overlay_scrollbars: true,
        y_expand: true,
      })
      this._scrollView.add_child(this._rowBox)

      this.contentLayout.add_child(this._searchEntry)
      this.contentLayout.add_child(this._scrollView)

      this.setInitialKeyFocus(this._searchEntry.clutter_text)
    }

    get needle() {
      return this._searchEntry.get_text().trim().toLowerCase()
    }

    // subclasses override this and fill the list through addRow
    render() {}

    // and this, to react to keys on a focused row before navigation runs
    handleRowKey() {
      return Clutter.EVENT_PROPAGATE
    }

    present() {
      this._searchEntry.set_text('')
      this.render()
      this.open(global.get_current_time())
    }

    toggle() {
      if (this.state === ModalDialog.State.OPENED || this.state === ModalDialog.State.OPENING) {
        this.close(global.get_current_time())
        return
      }

      this.present()
    }

    clearRows() {
      this._rowBox.destroy_all_children()
      this._rows = []
      this._gridRow = null
    }

    addHeading(text) {
      this._gridRow = null
      this._rowBox.add_child(
        new St.Label({ text, style_class: 'list-search-result-description xiws-heading' }),
      )
    }

    addRow(row, onActivate, { columns = 1 } = {}) {
      const index = this._rows.length

      row.connect('clicked', onActivate)
      row.connect('key-press-event', (actor, event) => this._onRowKey(index, event))

      this._container(columns).add_child(row)
      this._rows.push({ row, onActivate })
    }

    // rows are filled in reading order, a new line starts once the current
    // one is full. rows of a grid carry their own width, so a line that stays
    // half filled leaves its last entry at the same size as the others.
    _container(columns) {
      if (columns < 2) {
        this._gridRow = null
        return this._rowBox
      }

      if (!this._gridRow || this._gridRow.get_n_children() >= columns) {
        this._gridRow = new St.BoxLayout({ x_expand: true, style_class: 'xiws-grid-row' })
        this._rowBox.add_child(this._gridRow)
      }

      return this._gridRow
    }

    vfunc_key_press_event(event) {
      if (event.get_key_symbol() === Clutter.KEY_Escape) {
        this.close(global.get_current_time())
        return Clutter.EVENT_STOP
      }

      return super.vfunc_key_press_event(event)
    }

    _onSearchKey(event) {
      const symbol = event.get_key_symbol()
      if (this._rows.length === 0) return Clutter.EVENT_PROPAGATE

      if (symbol === Clutter.KEY_Down) {
        this._focusRow(0)
        return Clutter.EVENT_STOP
      }

      if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
        this._rows[0].onActivate()
        return Clutter.EVENT_STOP
      }

      return Clutter.EVENT_PROPAGATE
    }

    _onRowKey(index, event) {
      const entry = this._rows[index]
      if (!entry) return Clutter.EVENT_PROPAGATE

      const symbol = event.get_key_symbol()
      if (this.handleRowKey(entry.row, symbol) === Clutter.EVENT_STOP) {
        return Clutter.EVENT_STOP
      }

      if (symbol === Clutter.KEY_Down) {
        this._focusRow(Math.min(index + 1, this._rows.length - 1))
        return Clutter.EVENT_STOP
      }

      if (symbol === Clutter.KEY_Up) {
        if (index === 0) {
          global.stage.set_key_focus(this._searchEntry.clutter_text)
        } else {
          this._focusRow(index - 1)
        }
        return Clutter.EVENT_STOP
      }

      return Clutter.EVENT_PROPAGATE
    }

    _focusRow(index) {
      const entry = this._rows[index]
      if (!entry) return

      global.stage.set_key_focus(entry.row)
      ensureActorVisibleInScrollView(this._scrollView, entry.row)
    }
  },
)

export const ResultRow = GObject.registerClass(
  class ResultRow extends St.Button {
    _init(title, subtitle) {
      super._init({
        style_class: 'list-search-result xiws-row',
        can_focus: true,
        x_expand: true,
        x_align: Clutter.ActorAlign.FILL,
      })

      const box = new St.BoxLayout({
        vertical: true,
        x_expand: true,
        style_class: 'list-search-result-content',
      })
      box.add_child(new St.Label({ text: title, style_class: 'list-search-result-title' }))

      if (subtitle) {
        box.add_child(
          new St.Label({ text: subtitle, style_class: 'list-search-result-description' }),
        )
      }

      this.set_child(box)
    }
  },
)
