import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Soup from 'gi://Soup'

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js'

Gio._promisify(Soup.Session.prototype, 'send_and_read_async')

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast'
const INTERVAL_SECONDS = 15 * 60
const REFRESH_SECONDS = 15 * 60
// two hours ahead carry the curve through a longer network outage
const FORECAST_INTERVALS = 8
const PAST_INTERVALS = 2

function isCancelled(error) {
  return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)
}

// two decimals are about a kilometre, finer than the weather model resolves
// and all that leaves the machine
function parseLocation(raw) {
  const parts = raw.split(',').map((part) => Number.parseFloat(part))
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) return null

  const [latitude, longitude] = parts.map((part) => part.toFixed(2))
  return { latitude, longitude }
}

// global horizontal irradiance from open-meteo, which already folds sun
// elevation, cloud cover and rain into one figure
export class SkyLight extends Signals.EventEmitter {
  constructor(settings) {
    super()

    this._settings = settings
    this._session = new Soup.Session({ timeout: 20 })
    this._cancellable = new Gio.Cancellable()
    this._samples = []

    this._settingsIds = ['changed::brightness-location', 'changed::brightness-auto'].map((signal) =>
      settings.connect(signal, () => this._refresh()),
    )
    this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
      this._refresh()
      return GLib.SOURCE_CONTINUE
    })

    this._refresh()
  }

  destroy() {
    this._cancellable.cancel()
    GLib.Source.remove(this._timerId)
    for (const id of this._settingsIds) this._settings.disconnect(id)
  }

  get hasLocation() {
    return parseLocation(this._settings.get_string('brightness-location')) !== null
  }

  // watts per square metre interpolated for now, null without usable data
  radiationNow() {
    const now = Date.now() / 1000
    const after = this._samples.findIndex((sample) => sample.time >= now)
    if (after <= 0) return null

    const previous = this._samples[after - 1]
    const next = this._samples[after]
    const progress = (now - previous.time) / (next.time - previous.time)

    return previous.value + (next.value - previous.value) * progress
  }

  async _refresh() {
    const location = parseLocation(this._settings.get_string('brightness-location'))

    if (!this._settings.get_boolean('brightness-auto') || !location) {
      this._samples = []
      this.emit('changed')
      return
    }

    try {
      this._samples = await this._fetch(location)
      this.emit('changed')
    } catch (error) {
      // the forecast part of the previous samples keeps the curve going
      if (!isCancelled(error)) logError(error, 'xiws: open-meteo request failed')
    }
  }

  async _fetch({ latitude, longitude }) {
    const query = Object.entries({
      latitude,
      longitude,
      minutely_15: 'shortwave_radiation',
      past_minutely_15: PAST_INTERVALS,
      forecast_minutely_15: FORECAST_INTERVALS,
      timeformat: 'unixtime',
    })
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&')
    const message = Soup.Message.new('GET', `${ENDPOINT}?${query}`)
    const bytes = await this._session.send_and_read_async(
      message,
      GLib.PRIORITY_DEFAULT,
      this._cancellable,
    )

    if (message.get_status() !== Soup.Status.OK) {
      throw new Error(`open-meteo answered with status ${message.get_status()}`)
    }

    const { time, shortwave_radiation: radiation } = JSON.parse(
      new TextDecoder().decode(bytes.get_data()),
    ).minutely_15

    // each value is the mean over the preceding quarter hour, so it belongs
    // to the middle of that interval rather than to its end
    return time
      .map((stamp, index) => ({ time: stamp - INTERVAL_SECONDS / 2, value: radiation[index] }))
      .filter((sample) => typeof sample.value === 'number')
  }
}
