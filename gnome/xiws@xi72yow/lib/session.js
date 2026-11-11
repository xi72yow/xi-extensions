import Clutter from 'gi://Clutter'
import GLib from 'gi://GLib'
import GObject from 'gi://GObject'
import St from 'gi://St'

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'

// paul tol's muted scheme, the pale grey he keeps for missing data left out.
// the reserved workspace and workspaces without a session keep the plain panel
const SESSION_COLORS = [
  '#332288',
  '#88ccee',
  '#44aa99',
  '#117733',
  '#999933',
  '#ddcc77',
  '#cc6677',
  '#882255',
  '#aa4499',
]

function hash(text) {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value
}

// a repository keeps its colour for good once it has one. a new one takes the
// colour least used among the recently opened repositories, those are the
// ones likely to be open beside it. among equally used colours the hash picks,
// otherwise every fresh setup would hand out blue first
export class SessionColors {
  constructor(settings) {
    this._settings = settings
  }

  stored(name) {
    return this._read()[name] ?? null
  }

  assign(name) {
    const colors = this._read()
    if (SESSION_COLORS.includes(colors[name])) return colors[name]

    const usage = new Map(SESSION_COLORS.map((color) => [color, 0]))
    const recent = this._settings.get_strv('recent-workspaces').slice(0, SESSION_COLORS.length)
    for (const other of recent) {
      const color = colors[other]
      if (usage.has(color)) usage.set(color, usage.get(color) + 1)
    }

    const offset = hash(name) % SESSION_COLORS.length
    const candidates = SESSION_COLORS.map(
      (_, step) => SESSION_COLORS[(offset + step) % SESSION_COLORS.length],
    )
    const color = candidates.reduce((best, next) =>
      usage.get(next) < usage.get(best) ? next : best,
    )

    colors[name] = color
    this._settings.set_value('session-colors', new GLib.Variant('a{ss}', colors))
    return color
  }

  _read() {
    return this._settings.get_value('session-colors').deepUnpack()
  }
}

export function colorDot(color) {
  return new St.Widget({
    style_class: 'xiws-session-dot',
    style: color ? `background-color: ${color};` : '',
    visible: Boolean(color),
    y_align: Clutter.ActorAlign.CENTER,
  })
}

function luminance(hex) {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
  const [red, green, blue] = channels.map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

// the wcag contrast ratio against black and white, whichever reads better
function wantsDarkText(hex) {
  const light = luminance(hex) + 0.05
  return light / 0.05 > 1.05 / light
}

// names the active workspace next to the activities button and tints the
// whole panel in the colour of its session. a click opens the picker, there
// is no menu of its own
export const SessionIndicator = GObject.registerClass(
  class SessionIndicator extends PanelMenu.Button {
    _init(onActivate) {
      super._init(0.0, 'xiws session', true)

      this._onActivate = onActivate
      this._baseStyle = Main.panel.style
      this._label = new St.Label({ y_align: Clutter.ActorAlign.CENTER })
      this.add_child(this._label)

      Main.panel.add_style_class_name('xiws-panel')
    }

    setSession({ name, color }) {
      this._label.text = name
      this._tint(color)
    }

    _tint(color) {
      const base = this._baseStyle ?? ''
      Main.panel.style = color ? `${base} background-color: ${color};` : this._baseStyle
      if (color && wantsDarkText(color)) Main.panel.add_style_class_name('xiws-panel-dark')
      else Main.panel.remove_style_class_name('xiws-panel-dark')
    }

    vfunc_event(event) {
      const type = event.type()
      if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
        this._onActivate()
        return Clutter.EVENT_STOP
      }
      return Clutter.EVENT_PROPAGATE
    }

    destroy() {
      this._tint(null)
      Main.panel.remove_style_class_name('xiws-panel')
      super.destroy()
    }
  },
)
