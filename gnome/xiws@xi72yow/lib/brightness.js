import Clutter from 'gi://Clutter'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import GObject from 'gi://GObject'
import St from 'gi://St'

import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js'
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js'
import { QuickSlider, SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js'
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js'

import { SkyLight } from './skyLight.js'

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async')

const BRIGHTNESS_VCP = '10'
const CONTRAST_VCP = '12'
const ICON_NAME = 'display-brightness-symbolic'
// irradiance is perceived roughly logarithmically, the scale sets where the
// curve bends and full is treated as bright daylight
const RADIATION_SCALE = 50
const RADIATION_FULL = 800
const CURVE_TICK_SECONDS = 60
// the curve drifts by fractions every minute, following each of them would
// wear the settings memory of the monitor for changes nobody notices
const CURVE_HYSTERESIS_PERCENT = 4
const PERSIST_DELAY_MS = 500
// a drag emits notify::value with every motion event, which is a burst of i2c
// writes of exactly the kind the monitor is meant to be spared. during a drag
// the writes are therefore throttled, and the value under the hand when it
// lets go is always written.
const SLIDER_THROTTLE_MS = 400

function isCancelled(error) {
  return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)
}

function clampPercent(value) {
  return Math.min(Math.max(Math.round(value), 0), 100)
}

async function ddcutil(args, cancellable) {
  const child = Gio.Subprocess.new(
    ['ddcutil', ...args],
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
  )
  const [stdout, stderr] = await child.communicate_utf8_async(null, cancellable)

  if (!child.get_successful()) throw new Error(`ddcutil ${args.join(' ')}: ${stderr.trim()}`)
  return stdout
}

// monitors without ddc/ci are listed as "Invalid display" and skipped
function parseBuses(output) {
  return output
    .split(/\n\s*\n/)
    .filter((block) => block.startsWith('Display '))
    .map((block) => block.match(/I2C bus:\s+\/dev\/i2c-(\d+)/)?.[1])
    .filter((bus) => bus !== undefined)
}

// brief format: "VCP 10 C <current> <max>"
function parseLevel(output) {
  const [, , , current, max] = output.trim().split(/\s+/).map(Number)

  if (!Number.isInteger(current) || !(max > 0)) {
    throw new Error(`ddcutil: unexpected getvcp output "${output.trim()}"`)
  }
  return { current, max }
}

// monitors may store every ddc/ci write in memory with limited write cycles,
// so each change is a single write straight to the target. targets arriving
// while a write is under way collapse into the next one.
class DisplayControl {
  // the label only names the lines in the journal, which the counts in
  // docs/brightness.md are grepped by
  constructor(vcp, label) {
    this._vcp = vcp
    this._label = label
    this._cancellable = new Gio.Cancellable()
    this._displays = []
    this._loading = null
    this._fraction = null
    this._cause = null
    this._writing = false

    this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._forget())
  }

  destroy() {
    this._cancellable.cancel()
    Main.layoutManager.disconnect(this._monitorsChangedId)
  }

  // level of the first monitor as a fraction, null without a ddc/ci monitor
  async level() {
    const [first] = await this._load()
    return first ? first.written / first.max : null
  }

  moveTo(fraction, cause) {
    this._fraction = fraction
    this._cause = cause
    this._flush()
  }

  // a detection overtaken by a monitor change must not install its result
  _load() {
    if (this._loading) return this._loading

    const loading = this._detect().then(
      (displays) => {
        if (this._loading === loading) this._displays = displays
        return displays
      },
      (error) => {
        if (!isCancelled(error)) logError(error, 'xiws: ddc/ci detection failed')
        if (this._loading === loading) this._loading = null
        return []
      },
    )

    this._loading = loading
    return loading
  }

  async _detect() {
    const output = await ddcutil(['detect', '--terse'], this._cancellable)
    const displays = []

    for (const bus of parseBuses(output)) {
      const { current, max } = parseLevel(
        await ddcutil(['--bus', bus, '--brief', 'getvcp', this._vcp], this._cancellable),
      )
      displays.push({ bus, max, written: current })
    }

    return displays
  }

  _forget() {
    this._displays = []
    this._loading = null
  }

  async _flush() {
    if (this._writing) return
    this._writing = true

    try {
      let moved = true
      while (moved) {
        moved = false

        for (const display of await this._load()) {
          const target = Math.round(this._fraction * display.max)
          if (target === display.written) continue

          await ddcutil(
            ['--bus', display.bus, 'setvcp', this._vcp, String(target)],
            this._cancellable,
          )
          // one line per write, so the journal tells how often the monitor
          // is actually written to
          console.log(
            `xiws: ${this._label} ${display.written} -> ${target} of ${display.max} (${this._cause})`,
          )
          display.written = target
          moved = true
        }
      }
    } catch (error) {
      if (isCancelled(error)) return
      logError(error, 'xiws: ddc/ci write failed')
      // a monitor in standby does not answer, its level is read afresh next time
      this._forget()
    } finally {
      this._writing = false
    }
  }
}

// dimming at signal level, which mutter applies to the output rather than to
// the panel. it costs no write cycle and no round trip over i2c, but it lowers
// the values sent instead of the backlight: black stays as bright as it was.
// that makes it the one way further down once ddc/ci sits at the minimum of
// the monitor, and a poor substitute for it above that.
class SignalDimming {
  constructor() {
    this._proxy = null
    this._connectors = []

    try {
      this._proxy = Gio.DBusProxy.new_for_bus_sync(
        Gio.BusType.SESSION,
        Gio.DBusProxyFlags.NONE,
        null,
        'org.gnome.Mutter.DisplayConfig',
        '/org/gnome/Mutter/DisplayConfig',
        'org.gnome.Mutter.DisplayConfig',
        null,
      )
    } catch (error) {
      logError(error, 'xiws: no display config proxy, signal dimming unavailable')
      return
    }

    this._readConnectors()
  }

  get available() {
    return this._connectors.length > 0
  }

  // the property lists one entry per connector and colour mode, and only the
  // connector name is needed to address it
  _readConnectors() {
    const value = this._proxy?.get_cached_property('Luminance')
    if (!value) return

    const seen = new Set()
    for (const entry of value.deepUnpack()) {
      const connector = entry.connector?.deepUnpack?.()
      const mode = entry['color-mode']?.deepUnpack?.()

      if (typeof connector !== 'string' || mode === undefined) continue
      const key = `${connector}:${mode}`
      if (seen.has(key)) continue

      seen.add(key)
      this._connectors.push({ connector, mode })
    }
  }

  set(percent) {
    if (!this._proxy) return

    for (const { connector, mode } of this._connectors) {
      this._call('SetLuminance', new GLib.Variant('(sud)', [connector, mode, percent]))
    }
  }

  reset() {
    if (!this._proxy) return

    for (const { connector, mode } of this._connectors) {
      this._call('ResetLuminance', new GLib.Variant('(su)', [connector, mode]))
    }
  }

  _call(method, parameters) {
    this._proxy.call(method, parameters, Gio.DBusCallFlags.NONE, -1, null, (proxy, result) => {
      try {
        proxy.call_finish(result)
      } catch (error) {
        logError(error, `xiws: ${method} failed`)
      }
    })
  }
}

// the target is either a manual level or the daylight curve shifted by an
// offset. keys and slider only ever move the target, the monitors follow.
export class BrightnessController extends Signals.EventEmitter {
  constructor(settings) {
    super()

    this._settings = settings
    this._displays = new DisplayControl(BRIGHTNESS_VCP, 'brightness')
    this._contrast = new DisplayControl(CONTRAST_VCP, 'contrast')
    this._signal = new SignalDimming()
    this._sky = new SkyLight(settings)
    this._manual = null
    this._target = null
    this._offset = settings.get_int('brightness-offset')
    this._persistId = 0

    this._skyChangedId = this._sky.connect('changed', () =>
      this._apply({ settle: true, cause: 'weather' }),
    )
    this._settingsIds = [
      'changed::brightness-auto',
      'changed::brightness-auto-min',
      'changed::brightness-auto-max',
    ].map((signal) => settings.connect(signal, () => this._apply()))
    this._settingsIds.push(
      settings.connect('changed::brightness-offset', () => {
        this._offset = settings.get_int('brightness-offset')
        this._apply()
      }),
    )
    this._settingsIds.push(
      settings.connect('changed::brightness-signal', () => this._applySignal()),
    )
    this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CURVE_TICK_SECONDS, () => {
      this._apply({ settle: true, cause: 'drift' })
      return GLib.SOURCE_CONTINUE
    })

    this._start()
  }

  destroy() {
    this._flushOffset()
    GLib.Source.remove(this._tickId)
    for (const id of this._settingsIds) this._settings.disconnect(id)
    this._sky.disconnect(this._skyChangedId)
    this._sky.destroy()
    this._displays.destroy()
    this._contrast.destroy()

    // the shell keeps the luminance after the extension goes, so an unloaded
    // extension would leave the screen dimmed with no way to undo it
    this._signal.reset()
  }

  get canDimSignal() {
    return this._signal.available
  }

  get signal() {
    return this._settings.get_int('brightness-signal')
  }

  // read from the monitor rather than stored: unlike the luminance it survives
  // in the monitor itself, so the slider should start where the hardware is
  async contrast() {
    const level = await this._contrast.level()
    return level === null ? null : clampPercent(level * 100)
  }

  setContrast(percent) {
    this._contrast.moveTo(clampPercent(percent) / 100, 'menu')
  }

  _applySignal() {
    const percent = this.signal
    if (percent >= 100) {
      this._signal.reset()
    } else {
      this._signal.set(percent)
    }

    this.emit('changed')
  }

  get target() {
    return this._target
  }

  get auto() {
    return this._settings.get_boolean('brightness-auto')
  }

  get radiation() {
    return this._sky.radiationNow()
  }

  get hasLocation() {
    return this._sky.hasLocation
  }

  set(percent, cause = 'slider') {
    if (this._target === null) return

    const curve = this.auto ? this._curve() : null
    if (curve !== null) {
      this._offset = Math.round(clampPercent(percent) - curve)
      this._persistOffset()
    } else {
      this._manual = clampPercent(percent)
    }

    this._apply({ cause })
  }

  step(direction) {
    if (this._target === null) return

    this.set(this._target + direction * this._settings.get_int('brightness-step'), 'key')
    Main.osdWindowManager.show(
      -1,
      new Gio.ThemedIcon({ name: ICON_NAME }),
      null,
      this._target / 100,
      1,
    )
  }

  // the level found on the monitor is the manual starting point, so enabling
  // the extension does not move anything by itself
  async _start() {
    // mutter forgets the luminance across a restart, so the stored value is
    // put back rather than read from the compositor
    this._applySignal()

    const level = await this._displays.level()
    if (level === null) return

    this._manual = clampPercent(level * 100)
    this._apply({ cause: 'start' })
  }

  _curve() {
    const radiation = this._sky.radiationNow()
    if (radiation === null) return null

    const min = this._settings.get_int('brightness-auto-min')
    const max = this._settings.get_int('brightness-auto-max')
    const bounded = Math.min(Math.max(radiation, 0), RADIATION_FULL)
    const share =
      Math.log1p(bounded / RADIATION_SCALE) / Math.log1p(RADIATION_FULL / RADIATION_SCALE)

    return min + (max - min) * share
  }

  // settling applies the hysteresis, anything the user did is followed exactly
  _apply({ settle = false, cause = 'settings' } = {}) {
    if (this._manual === null) return

    const curve = this.auto ? this._curve() : null
    if (curve !== null) cause += `, curve ${Math.round(this._sky.radiationNow())} W/m²`
    const target = curve === null ? this._manual : clampPercent(curve + this._offset)
    const settled = settle && Math.abs(target - this._target) < CURVE_HYSTERESIS_PERCENT

    if (!settled) {
      this._target = target

      // the manual level follows every target, so switching modes or losing
      // the weather data holds the brightness where it is instead of jumping
      this._manual = target

      this._displays.moveTo(target / 100, cause)
    }

    // emitted either way, the menu shows the irradiance as it moves
    this.emit('changed')
  }

  // dragging the slider moves the offset many times a second, dconf only
  // gets the value once the hand rests
  _persistOffset() {
    if (this._persistId) GLib.Source.remove(this._persistId)

    this._persistId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PERSIST_DELAY_MS, () => {
      this._persistId = 0
      this._settings.set_int('brightness-offset', this._offset)
      return GLib.SOURCE_REMOVE
    })
  }

  _flushOffset() {
    if (!this._persistId) return

    GLib.Source.remove(this._persistId)
    this._persistId = 0
    this._settings.set_int('brightness-offset', this._offset)
  }
}

// the shell dropped PopupSliderMenuItem, so a row with a label above a slider
// is assembled from the parts. the throttle is the same one the quick slider
// uses, since every one of these writes to the monitor as well.
const MenuSlider = GObject.registerClass(
  class MenuSlider extends PopupMenu.PopupBaseMenuItem {
    _init(label, onChange) {
      super._init({ activate: false })

      this._onChange = onChange
      this._dragging = false
      this._throttleId = 0
      this._pending = null

      const box = new St.BoxLayout({
        vertical: true,
        x_expand: true,
        style_class: 'xiws-menu-slider',
      })
      box.add_child(new St.Label({ text: label, x_align: Clutter.ActorAlign.START }))

      this.slider = new Slider(0)
      this.slider.accessible_name = label
      this._changedId = this.slider.connect('notify::value', () => this._moved())
      this.slider.connect('drag-begin', () => {
        this._dragging = true
      })
      this.slider.connect('drag-end', () => {
        this._dragging = false
        this._stopThrottle()
        this._onChange(this.slider.value * 100)
      })

      box.add_child(this.slider)
      this.add_child(box)
    }

    setValue(percent) {
      this.slider.block_signal_handler(this._changedId)
      this.slider.value = percent / 100
      this.slider.unblock_signal_handler(this._changedId)
    }

    _moved() {
      const value = this.slider.value * 100

      if (!this._dragging) {
        this._onChange(value)
        return
      }

      if (this._throttleId) {
        this._pending = value
        return
      }

      this._onChange(value)
      this._throttleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SLIDER_THROTTLE_MS, () => {
        this._throttleId = 0
        if (this._pending === null) return GLib.SOURCE_REMOVE

        const pending = this._pending
        this._pending = null
        this._onChange(pending)
        return GLib.SOURCE_REMOVE
      })
    }

    _stopThrottle() {
      if (this._throttleId) {
        GLib.Source.remove(this._throttleId)
        this._throttleId = 0
      }
      this._pending = null
    }

    destroy() {
      this._stopThrottle()
      super.destroy()
    }
  },
)

const BrightnessItem = GObject.registerClass(
  class BrightnessItem extends QuickSlider {
    _init(controller, settings) {
      super._init({ iconName: ICON_NAME, menuEnabled: true, visible: false })

      this._controller = controller
      this._dragging = false
      this._throttleId = 0
      this._pending = null

      this.slider.accessible_name = 'Bildschirmhelligkeit'

      this._sliderChangedId = this.slider.connect('notify::value', () => this._onSliderMoved())
      this.slider.connect('drag-begin', () => {
        this._dragging = true
      })
      this.slider.connect('drag-end', () => {
        this._dragging = false
        this._stopThrottle()

        // the pending value is the one the hand stopped on, and it has to
        // reach the monitor even when the throttle swallowed it
        this._controller.set(this.slider.value * 100)
      })

      this._autoItem = new PopupMenu.PopupSwitchMenuItem(
        'Automatisch nach Tageslicht',
        controller.auto,
      )
      this._autoItem.connect('toggled', (item, state) =>
        settings.set_boolean('brightness-auto', state),
      )
      this.menu.addMenuItem(this._autoItem)

      // both of these sit in the menu rather than in the quick settings grid:
      // they are set once and left alone, unlike the brightness above them
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem())

      if (controller.canDimSignal) {
        this._signalItem = new MenuSlider('Signal dimmen', (value) =>
          settings.set_int('brightness-signal', clampPercent(value)),
        )
        this._signalItem.setValue(settings.get_int('brightness-signal'))
        this.menu.addMenuItem(this._signalItem)
      }

      this._contrastItem = new MenuSlider('Kontrast', (value) =>
        controller.setContrast(clampPercent(value)),
      )
      this.menu.addMenuItem(this._contrastItem)
      controller.contrast().then((percent) => {
        if (percent !== null) this._contrastItem.setValue(percent)
      })

      this._changedId = controller.connect('changed', () => this._sync())
      this._sync()
    }

    // outside a drag every change is written right away: keys, scrolling and
    // the menu produce single steps rather than a stream
    _onSliderMoved() {
      const target = this.slider.value * 100

      if (!this._dragging) {
        this._controller.set(target)
        return
      }

      if (this._throttleId) {
        this._pending = target
        return
      }

      this._controller.set(target)
      this._throttleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SLIDER_THROTTLE_MS, () => {
        this._throttleId = 0

        if (this._pending === null) return GLib.SOURCE_REMOVE

        const value = this._pending
        this._pending = null
        this._controller.set(value)
        return GLib.SOURCE_REMOVE
      })
    }

    _stopThrottle() {
      if (this._throttleId) {
        GLib.Source.remove(this._throttleId)
        this._throttleId = 0
      }
      this._pending = null
    }

    _sync() {
      const controller = this._controller

      this.visible = controller.target !== null
      if (!this.visible) return

      this.slider.block_signal_handler(this._sliderChangedId)
      this.slider.value = controller.target / 100
      this.slider.unblock_signal_handler(this._sliderChangedId)

      this._autoItem.setToggleState(controller.auto)
      this._signalItem?.setValue(controller.signal)
      this.menu.setHeader(ICON_NAME, 'Bildschirmhelligkeit', this._describe())
    }

    _describe() {
      const controller = this._controller
      if (!controller.auto) return 'Manuell'
      if (!controller.hasLocation) return 'Kein Standort gesetzt'

      const radiation = controller.radiation
      return radiation === null ? 'Keine Wetterdaten' : `Tageslicht ${Math.round(radiation)} W/m²`
    }

    destroy() {
      this._stopThrottle()
      this._controller.disconnect(this._changedId)
      super.destroy()
    }
  },
)

export const BrightnessIndicator = GObject.registerClass(
  class BrightnessIndicator extends SystemIndicator {
    _init(controller, settings) {
      super._init()
      this.quickSettingsItems.push(new BrightnessItem(controller, settings))
    }

    destroy() {
      for (const item of this.quickSettingsItems) item.destroy()
      super.destroy()
    }
  },
)
