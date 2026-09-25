import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import GObject from 'gi://GObject'

import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js'
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js'
import { QuickSlider, SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js'

import { SkyLight } from './skyLight.js'

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async')

const BRIGHTNESS_VCP = '10'
const ICON_NAME = 'display-brightness-symbolic'
// each write covers a third of the remaining distance, so a glide starts
// quick and settles softly on the monitor's coarse ddc/ci steps
const EASE_DIVISOR = 3
// irradiance is perceived roughly logarithmically, the scale sets where the
// curve bends and full is treated as bright daylight
const RADIATION_SCALE = 50
const RADIATION_FULL = 800
const CURVE_TICK_SECONDS = 60
const PERSIST_DELAY_MS = 500

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

// a ddc/ci write takes around 0.2 s, so the monitors are led towards a target
// one write after another instead of being set directly. a target changing
// midway simply redirects the running glide.
class DisplayBrightness {
  constructor() {
    this._cancellable = new Gio.Cancellable()
    this._displays = []
    this._loading = null
    this._fraction = null
    this._gliding = false

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

  glideTo(fraction) {
    this._fraction = fraction
    this._glide()
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
        await ddcutil(['--bus', bus, '--brief', 'getvcp', BRIGHTNESS_VCP], this._cancellable),
      )
      displays.push({ bus, max, written: current })
    }

    return displays
  }

  _forget() {
    this._displays = []
    this._loading = null
  }

  async _glide() {
    if (this._gliding) return
    this._gliding = true

    try {
      let moved = true
      while (moved) {
        moved = false

        for (const display of await this._load()) {
          const distance = Math.round(this._fraction * display.max) - display.written
          if (distance === 0) continue

          const next =
            display.written + Math.sign(distance) * Math.ceil(Math.abs(distance) / EASE_DIVISOR)
          await ddcutil(
            ['--bus', display.bus, 'setvcp', BRIGHTNESS_VCP, String(next)],
            this._cancellable,
          )
          display.written = next
          moved = true
        }
      }
    } catch (error) {
      if (isCancelled(error)) return
      logError(error, 'xiws: ddc/ci write failed')
      // a monitor in standby does not answer, its level is read afresh next time
      this._forget()
    } finally {
      this._gliding = false
    }
  }
}

// the target is either a manual level or the daylight curve shifted by an
// offset. keys and slider only ever move the target, the monitors follow.
export class BrightnessController extends Signals.EventEmitter {
  constructor(settings) {
    super()

    this._settings = settings
    this._displays = new DisplayBrightness()
    this._sky = new SkyLight(settings)
    this._manual = null
    this._target = null
    this._offset = settings.get_int('brightness-offset')
    this._persistId = 0

    this._skyChangedId = this._sky.connect('changed', () => this._apply())
    this._settingsIds = [
      'changed::brightness-auto',
      'changed::brightness-auto-min',
      'changed::brightness-auto-max',
    ].map((signal) => settings.connect(signal, () => this._apply()))
    this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CURVE_TICK_SECONDS, () => {
      this._apply()
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

  set(percent) {
    if (this._target === null) return

    const curve = this.auto ? this._curve() : null
    if (curve !== null) {
      this._offset = Math.round(clampPercent(percent) - curve)
      this._persistOffset()
    } else {
      this._manual = clampPercent(percent)
    }

    this._apply()
  }

  step(direction) {
    if (this._target === null) return

    this.set(this._target + direction * this._settings.get_int('brightness-step'))
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
    const level = await this._displays.level()
    if (level === null) return

    this._manual = clampPercent(level * 100)
    this._apply()
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

  _apply() {
    if (this._manual === null) return

    const curve = this.auto ? this._curve() : null
    this._target = curve === null ? this._manual : clampPercent(curve + this._offset)

    // the manual level follows every target, so switching modes or losing
    // the weather data holds the brightness where it is instead of jumping
    this._manual = this._target

    this._displays.glideTo(this._target / 100)
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

const BrightnessItem = GObject.registerClass(
  class BrightnessItem extends QuickSlider {
    _init(controller, settings) {
      super._init({ iconName: ICON_NAME, menuEnabled: true, visible: false })

      this._controller = controller
      this.slider.accessible_name = 'Bildschirmhelligkeit'

      this._sliderChangedId = this.slider.connect('notify::value', () =>
        controller.set(this.slider.value * 100),
      )

      this._autoItem = new PopupMenu.PopupSwitchMenuItem(
        'Automatisch nach Tageslicht',
        controller.auto,
      )
      this._autoItem.connect('toggled', (item, state) =>
        settings.set_boolean('brightness-auto', state),
      )
      this.menu.addMenuItem(this._autoItem)

      this._changedId = controller.connect('changed', () => this._sync())
      this._sync()
    }

    _sync() {
      const controller = this._controller

      this.visible = controller.target !== null
      if (!this.visible) return

      this.slider.block_signal_handler(this._sliderChangedId)
      this.slider.value = controller.target / 100
      this.slider.unblock_signal_handler(this._sliderChangedId)

      this._autoItem.setToggleState(controller.auto)
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
