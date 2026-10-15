# Brightness in xiws

Monitor brightness through DDC/CI, set by keys or a quick settings slider and optionally led by a daylight curve from weather data.

## Why

External monitors expose no backlight interface, so the brightness slider of GNOME stays hidden and the brightness keys have nothing to act on. DDC/CI sets the brightness in the monitor itself over I²C. A shell script calling `ddcutil` per key press worked, but took around 0.8 s per step, since every call detected the displays anew, read the current level and wrote with a verifying read back. It also gave no visual feedback.

An automatic mode was wanted on top. Monitors rarely hand out a light reading: MCCS defines `0x66` for an ambient light sensor, but only as a switch for the automatic of the monitor itself. A webcam can serve as a sensor with fixed exposure, yet UVC controls are global and would disturb a running call. Weather data needs neither.

## Model

Keys and slider never write to the monitor. They move a target, and the monitors are set to it.

```
daylight curve ─┐
                ├─► target ──► ddcutil setvcp
offset ─────────┘      │
                       └─► osd and slider show the target at once
```

| Part       | Approach                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------- |
| Detection  | `ddcutil detect --terse` once and after `monitors-changed`, then a read per bus                 |
| Writing    | one `setvcp` straight to the target, targets arriving meanwhile collapse into the next write    |
| Manual     | the level found on the monitor at start, then moved by keys and slider                          |
| Automatic  | curve from irradiance plus a persistent offset, which keys and slider move instead of the level |
| Feedback   | the GNOME OSD on key presses, a `QuickSlider` with a switch for the automatic mode in its menu  |
| Failure    | a failed write drops the state, the next change detects afresh                                  |
| No weather | the level holds where it is and stays adjustable                                                |

Every DDC/CI capable monitor follows the same target in percent of its own range. Monitors report differing maxima, some 50 rather than 100, which makes a single step 2 % wide.

## Daylight curve

The irradiance comes from [Open-Meteo](https://open-meteo.com) as `shortwave_radiation` in quarter hour resolution, without an API key. It is global horizontal irradiance from the DWD ICON model and already folds sun elevation, cloud cover and precipitation into one figure.

| Detail        | Handling                                                                              |
| ------------- | ------------------------------------------------------------------------------------- |
| Refresh       | every 15 minutes, two intervals back and eight ahead                                  |
| Interpolation | linear between the samples, each placed at the middle of the quarter hour it averages |
| Curve         | `ln(1 + E / 50) / ln(1 + 800 / 50)` between `brightness-auto-min` and `-max`          |
| Hysteresis    | the curve only moves the target once it drifted 4 % away, keys and slider act at once |
| Outage        | the forecast part of the last response carries the curve for up to two hours          |
| Privacy       | only the coordinates leave the machine, rounded to two decimals, which is about 1 km  |

The logarithm follows perception: going from 50 to 100 W/m² is a larger step for the eye than going from 500 to 550.

## Settings

| Key                                | Default     | Meaning                                    |
| ---------------------------------- | ----------- | ------------------------------------------ |
| `brightness-up`, `brightness-down` | Super+F6/F5 | move the target                            |
| `brightness-step`                  | 10          | percent per key press                      |
| `brightness-auto`                  | false       | follow the daylight curve                  |
| `brightness-location`              | empty       | `"lat,lon"`, required for automatic mode   |
| `brightness-auto-min`, `-max`      | 20, 100     | range of the curve in percent              |
| `brightness-offset`                | 0           | shift on top of the curve, set by the keys |

The location has no default, the repository is public.

```bash
gsettings set org.gnome.shell.extensions.xiws brightness-location '52.52,13.40'
```

With the extension installed through `build.sh`, the schema only lives in the extension directory and `gsettings` needs `--schemadir ~/.local/share/gnome-shell/extensions/xiws@xi72yow/schemas` in front of `set`.

## Requirements

- `ddcutil`, recommended by the package
- the `i2c-dev` module loaded, access to `/dev/i2c-*` is then granted to the seat user through the `uaccess` rule shipped by `ddcutil`
- DDC/CI enabled in the monitor menu

Some monitors accept the value but do not apply it while a picture mode fixes the brightness, eco and dynamic brightness modes being the usual suspects.

## Limits

The curve is modelled, not measured. A single cloud passing the sun, the orientation of the window, blinds and room lighting are not seen. The offset is meant to absorb the constant part of that.

A change made through the monitor menu is not seen either, the state still holds the level last written.

**The slider is throttled while it is dragged.** `notify::value` fires with every motion event, which produced a burst of writes of exactly the kind the rest of this design avoids. During a drag the writes are limited to one per `SLIDER_THROTTLE_MS`, currently 400, and the value under the hand when it lets go is written on `drag-end` regardless, so the monitor never ends up on an intermediate step. Keys, scrolling and the menu are untouched by this, since they produce single steps rather than a stream.

Monitors keep their settings in non-volatile memory with a limited number of write cycles, and whether a model stores every DDC/CI write right away or defers it is rarely documented. The MCCS command `0x0C` (Save Settings) does not settle it either: according to the ddcutil documentation most monitors offering it show no effect from it, and only a few need it for values to stick. No case of a monitor worn out this way could be found, yet f.lux held back DDC/CI control over a figure of about 100,000 cycles, and KDE Powerdevil delays and merges its writes for the same reason. Bursts are what the sources point at, so an earlier gliding transition was dropped in favour of single writes, and the curve only moves behind its hysteresis. How many writes that leaves depends on the range of the curve and the weather, roughly 10 on a narrow range and 40 or more on the full range with passing clouds. Every write is logged, so the actual count can be read from the journal:

```bash
journalctl --user -b | grep 'xiws: brightness'
journalctl --user --since today | grep -c 'xiws: brightness'
```

Each line names its cause: `key`, `slider`, `menu` for the contrast slider, `settings`, `start`, `weather` for a fresh Open-Meteo response and `drift` for the minute tick, followed by the irradiance whenever the curve set the target.

`ddcutil` 2.2 verifies every write by reading it back, and `--noverify` conflicts with that default in the tested build. A write thus takes around 0.2 s.

**Dimming at signal level sits in the menu.** Mutter 48 exposes `SetLuminance(connector, color_mode, value)` and `ResetLuminance` on `org.gnome.Mutter.DisplayConfig`, which lower the output values without touching the monitor at all, so without any write cycle and without the 0.2 s a DDC/CI write costs. The connector shows up there as unset at 100.

What it does not do is dim the backlight. Black stays as bright as it was, contrast drops and the panel keeps drawing the same power, which is the opposite of what dimming is wanted for in a dark room. That makes it a poor substitute for DDC/CI, and a good addition below it: the monitor on this machine sits at 0 of 50 and cannot go darker, which is exactly the gap this closes.

It is therefore a second slider in the menu of the quick settings tile rather than the main control, kept in `brightness-signal`.

**Zero is not reachable.** A luminance of 0 turns the screen black, and with it the slider that would take it back, so the value never goes below `LUMINANCE_FLOOR`, currently 15. The slider still travels its full length: its range is mapped onto the floor to 100 rather than clipped at the lower end, which keeps the whole width usable instead of wasting the first seventh of it on values that are refused. **The proxy has to be asynchronous.** `gnome-shell` is itself the service behind `org.gnome.Mutter.DisplayConfig`, so a synchronous proxy asks its own process and blocks the loop that would have to answer. The proxy came up but without cached properties, `get_cached_property('Luminance')` returned null, and the slider was never shown. A test from a separate process did not reproduce it for exactly that reason.

Mutter forgets the luminance across a restart, so the stored value is put back on start, and `disable` resets it, since a screen left dimmed by an unloaded extension could not be undone through the interface.

`SetBacklight` exists alongside it and would be the better path, except the `Backlight` property is empty on this machine, so mutter sees no backlight it could drive.

**Contrast shares the slider and the throttle.** `DisplayControl` carries the VCP code, so `0x12` reuses the write path, the collapsing of pending targets and the throttle unchanged. It is read from the monitor when the menu is built rather than stored, since unlike the luminance it survives in the monitor itself. Its journal lines read `contrast` where brightness reads `brightness`.
