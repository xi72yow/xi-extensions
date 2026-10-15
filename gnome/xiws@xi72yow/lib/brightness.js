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
// signal dimming at zero turns the screen black, and with it the slider that
// would undo it. the lower end of the range is therefore a floor rather than
// zero, and the slider maps its full travel onto what is left.
const LUMINANCE_FLOOR = 15
// the two layers multiply rather than take turns: the monitor carries the
// coarse steps, the luminance fills in between them. a correction that stays
// inside one step writes nothing to the monitor at all.
//
// the steps are relative rather than fixed, each one a tenth below the last.
// with fixed steps the lowest ones are relatively coarse, and at a target of
// 6 the luminance fell to 60 with the colour depth behind it. this way it
// stays between the ratio and 100 across the whole range.
const DDC_STEP_RATIO = 0.9
// below this the monitor is at its minimum and the luminance carries alone
const DDC_MIN_PERCENT = 5

function isCancelled(error) {
  return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)
}

function clampPercent(value) {
  return Math.min(Math.max(Math.round(value), 0), 100)
}

// one target splits into a coarse monitor step and the luminance that makes up
// the difference. below the lowest step the monitor is at its minimum and the
// luminance carries the rest alone, which is the only way further down.
function distribute(target) {
  const wanted = clampPercent(target)

  if (wanted >= DDC_MIN_PERCENT) {
    const steps = Math.floor(Math.log(wanted / 100) / Math.log(DDC_STEP_RATIO))
    const ddc = Math.min(100 * DDC_STEP_RATIO ** steps, 100)

    if (ddc >= DDC_MIN_PERCENT) {
      return { ddc: Math.round(ddc), luminance: clampPercent((wanted / ddc) * 100) }
    }
  }

  const share = Math.min(wanted / DDC_MIN_PERCENT, 1)
  return { ddc: 0, luminance: Math.round(LUMINANCE_FLOOR + (100 - LUMINANCE_FLOOR) * share) }
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
  constructor(onChanged) {
    this._proxy = null
    this._connectors = []
    this._onChanged = onChanged
    this._propertiesId = 0
    this._applied = null
    this._modes = new Map()

    // the proxy has to be built asynchronously: gnome-shell is itself the
    // service behind org.gnome.Mutter.DisplayConfig, and a synchronous call
    // blocks the very loop that would have to answer it
    Gio.DBusProxy.new_for_bus(
      Gio.BusType.SESSION,
      Gio.DBusProxyFlags.NONE,
      null,
      'org.gnome.Mutter.DisplayConfig',
      '/org/gnome/Mutter/DisplayConfig',
      'org.gnome.Mutter.DisplayConfig',
      null,
      (source, result) => this._adopt(result),
    )
  }

  _adopt(result) {
    try {
      this._proxy = Gio.DBusProxy.new_for_bus_finish(result)
    } catch (error) {
      logError(error, 'xiws: no display config proxy, signal dimming unavailable')
      return
    }

    this._readConnectors()
    this._readColourModes()

    // the extension loads early, and mutter fills this property once the
    // monitor configuration is up, so changes are followed
    this._propertiesId = this._proxy.connect('g-properties-changed', () => {
      const had = this.available

      this._connectors = []
      this._readConnectors()
      this._readColourModes()

      // a connector arriving late also has to receive the stored value, the
      // caller reapplies it from here
      if (had !== this.available) this._onChanged?.()
    })

    if (this.available) this._onChanged?.()
  }

  // the Luminance property lists an entry per colour mode, but only the one
  // the monitor is actually in has any effect. setting the others as well
  // writes a value nobody maintains, and it would surface on a switch between
  // sdr and hdr as a level from an earlier session.
  _readColourModes() {
    this._proxy.call('GetCurrentState', null, Gio.DBusCallFlags.NONE, -1, null, (proxy, result) => {
      let monitors
      try {
        ;[, monitors] = proxy.call_finish(result).deepUnpack()
      } catch (error) {
        logError(error, 'xiws: could not read the colour modes')
        return
      }

      this._modes = new Map()
      for (const [spec, , properties] of monitors) {
        const mode = properties['color-mode']?.deepUnpack?.()
        if (typeof mode === 'number') this._modes.set(spec[0], mode)
      }

      this._applied = null
      this._onChanged?.()
    })
  }

  destroy() {
    if (this._propertiesId) {
      this._proxy.disconnect(this._propertiesId)
      this._propertiesId = 0
    }
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

  // writing the same value again would bounce back through the property
  // change and start the whole round over
  apply(percent) {
    const bounded = Math.max(Math.min(percent, 100), LUMINANCE_FLOOR)
    if (bounded === this._applied) return

    this._applied = bounded
    if (bounded >= 100) {
      this.reset()
      return
    }

    for (const { connector, mode } of this._active()) {
      this._call('SetLuminance', new GLib.Variant('(sud)', [connector, mode, bounded]))
    }
  }

  // without a known mode every entry is addressed, which is what the earlier
  // revision did throughout: it works, it is just not the one that counts
  _active() {
    if (this._modes.size === 0) return this._connectors

    return this._connectors.filter(({ connector, mode }) => this._modes.get(connector) === mode)
  }

  // reset covers every mode, not just the active one: a value left behind in
  // the other mode would come back when the monitor switches to it
  reset() {
    if (!this._proxy) return

    this._applied = null
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
    this._signal = new SignalDimming(() => this._applySignal())
    this._sky = new SkyLight(settings)
    this._manual = null
    this._target = null
    this._offset = settings.get_int('brightness-offset')
    this._persistId = 0
    this._split = null

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
    this._signal.destroy()

    // the shell keeps the luminance after the extension goes, so an unloaded
    // extension would leave the screen dimmed with no way to undo it
    this._signal.reset()
  }

  // the slider shifts the curve while the automatic runs, so the shift itself
  // is part of what the menu has to show
  get offset() {
    return this._offset
  }

  get canDimSignal() {
    return this._signal.available
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

  // the split is what the slider draws its second mark from
  get split() {
    return this._split
  }

  _applySignal() {
    if (this._split) this._signal.apply(this._split.luminance)
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

      const split = distribute(target)
      this._split = split

      this._displays.moveTo(split.ddc / 100, cause)
      this._signal.apply(split.luminance)
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

// open-meteo is asked for irradiance alone, so the symbol is derived from it
// rather than from a weather code. that also keeps it honest: it shows what
// the control actually reacts to.
function skyIcon(radiation) {
  if (radiation < 20) return 'weather-clear-night-symbolic'
  if (radiation < 150) return 'weather-overcast-symbolic'
  if (radiation < 450) return 'weather-few-clouds-symbolic'
  return 'weather-clear-symbolic'
}

// how the brightness is made up, as figures rather than a sentence: the panel
// of the monitor, the signal on top of it and the irradiance behind both. the
// mark on the slider rail cannot say this, and below the lowest step of the
// monitor it vanishes altogether, which is exactly where the signal carries
// alone.
const SplitRow = GObject.registerClass(
  class SplitRow extends PopupMenu.PopupBaseMenuItem {
    _init() {
      super._init({ reactive: false, can_focus: false })

      const box = new St.BoxLayout({ x_expand: true, style_class: 'xiws-split-row' })

      // mutter brings no icon of its own, and the luminance belongs to its
      // colour handling, which is what the colour symbol stands for
      this._panel = this._pair('video-display-symbolic', box)
      this._signal = this._pair('preferences-color-symbolic', box)
      this._sky = this._pair('weather-clear-symbolic', box)
      this._offset = this._pair('value-increase-symbolic', box)

      this.add_child(box)
    }

    _pair(iconName, box) {
      const group = new St.BoxLayout({ style_class: 'xiws-split-pair' })
      const icon = new St.Icon({ icon_name: iconName, style_class: 'popup-menu-icon' })
      group.add_child(icon)

      const label = new St.Label({ text: '', y_align: Clutter.ActorAlign.CENTER })
      group.add_child(label)
      box.add_child(group)

      return { group, icon, label }
    }

    setSplit(split, radiation, offset) {
      this.visible = split !== null
      if (!split) return

      // at the minimum of the monitor there is no percentage to name, the
      // dash says so without pretending to a number
      this._panel.label.text = split.ddc > 0 ? `${split.ddc} %` : '–'

      // a luminance of 100 adds nothing, so it is left out rather than shown
      // as a figure that carries no information
      this._signal.label.text = `${split.luminance} %`
      this._signal.group.visible = split.luminance < 100

      this._sky.group.visible = radiation !== null
      if (radiation !== null) {
        this._sky.icon.icon_name = skyIcon(radiation)
        this._sky.label.text = `${Math.round(radiation)} W/m²`
      }

      // with the automatic running the slider moves the curve rather than the
      // level, and that shift outlives the moment. naming it is what makes the
      // difference to the manual mode visible.
      this._offset.group.visible = offset !== null && offset !== 0
      if (!this._offset.group.visible) return

      this._offset.icon.icon_name =
        offset > 0 ? 'value-increase-symbolic' : 'value-decrease-symbolic'
      this._offset.label.text = `${Math.abs(offset)}`
    }
  },
)

// the shell dropped PopupSliderMenuItem, so a row with a label above a slider
// is assembled from the parts. unlike the brightness above it this one writes
// only once the hand lets go: contrast has no second layer to interpolate
// over, so every intermediate value would be a write cycle on the monitor for
// a setting that is adjusted deliberately and rarely.
const MenuSlider = GObject.registerClass(
  class MenuSlider extends PopupMenu.PopupBaseMenuItem {
    _init(label, onChange) {
      super._init({ activate: false })

      this._onChange = onChange
      this._dragging = false

      const box = new St.BoxLayout({
        vertical: true,
        x_expand: true,
        style_class: 'xiws-menu-slider',
      })
      box.add_child(new St.Label({ text: label, x_align: Clutter.ActorAlign.START }))

      this.slider = new Slider(0)
      this.slider.accessible_name = label
      this._changedId = this.slider.connect('notify::value', () => {
        // keys and scrolling are single steps and act at once, a drag is a
        // stream and waits for its end
        if (!this._dragging) this._onChange(this.slider.value * 100)
      })
      this.slider.connect('drag-begin', () => {
        this._dragging = true
      })
      this.slider.connect('drag-end', () => {
        this._dragging = false
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
  },
)

const BrightnessItem = GObject.registerClass(
  class BrightnessItem extends QuickSlider {
    _init(controller, settings) {
      super._init({ iconName: ICON_NAME, menuEnabled: true, visible: false })

      this._controller = controller
      this._settings = settings
      this._dragging = false
      this._throttleId = 0
      this._pending = null

      this.slider.accessible_name = 'Bildschirmhelligkeit'
      this.slider.add_style_class_name('xiws-split-slider')

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

      this._splitRow = new SplitRow()
      this.menu.addMenuItem(this._splitRow)

      this._indicatorItem = new PopupMenu.PopupSwitchMenuItem(
        'In der Leiste anzeigen',
        settings.get_boolean('brightness-indicator'),
      )
      this._indicatorItem.connect('toggled', (item, state) =>
        settings.set_boolean('brightness-indicator', state),
      )
      this.menu.addMenuItem(this._indicatorItem)

      // both of these sit in the menu rather than in the quick settings grid:
      // they are set once and left alone, unlike the brightness above them
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem())

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
      this._indicatorItem.setToggleState(this._settings.get_boolean('brightness-indicator'))

      // availability can arrive after the menu was built, see SignalDimming
      // the separator of BarLevel marks where the monitor stops and the
      // luminance takes over. the step always sits above the target, so the
      // red overdrive colouring never kicks in, only the mark is drawn.
      this.slider.overdriveStart = controller.split ? controller.split.ddc / 100 : 1
      this._splitRow.setSplit(
        controller.split,
        controller.auto ? controller.radiation : null,
        controller.auto ? controller.offset : null,
      )
      this.menu.setHeader(ICON_NAME, 'Bildschirmhelligkeit', this._describe())
    }

    _describe() {
      const controller = this._controller
      if (!controller.auto) return 'Manuell'
      if (!controller.hasLocation) return 'Kein Standort gesetzt'

      // the irradiance moved into the row of figures below
      return controller.radiation === null ? 'Keine Wetterdaten' : 'Automatisch'
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

      this._controller = controller
      this._settings = settings

      // a SystemIndicator carries its own icon in the panel, next to the
      // volume and network ones. it is off by default: a permanent icon for a
      // setting is only worth its place to whoever asked for it.
      this._icon = this._addIndicator()
      this._icon.add_style_class_name('xiws-panel-level')

      // a SystemIndicator is a box, so the level goes right beside the icon
      this._label = new St.Label({ y_align: Clutter.ActorAlign.CENTER })
      this.add_child(this._label)

      this.quickSettingsItems.push(new BrightnessItem(controller, settings))

      this._changedId = controller.connect('changed', () => this._sync())
      this._settingsId = settings.connect('changed::brightness-indicator', () => this._sync())
      this._sync()
    }

    _sync() {
      const shown = this._settings.get_boolean('brightness-indicator')
      const split = this._controller.split

      this._icon.visible = shown && split !== null
      this._label.visible = this._icon.visible
      if (!this._icon.visible) return

      const radiation = this._controller.auto ? this._controller.radiation : null
      this._icon.icon_name = radiation === null ? ICON_NAME : skyIcon(radiation)
      this._label.text = `${clampPercent(this._controller.target)} %`
    }

    destroy() {
      this._controller.disconnect(this._changedId)
      this._settings.disconnect(this._settingsId)

      for (const item of this.quickSettingsItems) item.destroy()
      super.destroy()
    }
  },
)
