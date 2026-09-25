# Brightness in xiws

Monitor brightness through DDC/CI, set by keys or a quick settings slider and optionally led by a daylight curve from weather data.

## Why

External monitors expose no backlight interface, so the brightness slider of GNOME stays hidden and the brightness keys have nothing to act on. DDC/CI sets the brightness in the monitor itself over I²C. A shell script calling `ddcutil` per key press worked, but took around 0.8 s per step, since every call detected the displays anew, read the current level and wrote with a verifying read back. It also gave no visual feedback.

An automatic mode was wanted on top. The monitor in use, a Samsung Odyssey G95NC, lists Adaptive Picture in its data sheet, yet no sensor reaction could be provoked and the MCCS code `0x66` for an ambient light sensor is unsupported. The webcam was examined as a sensor as well: with fixed exposure its mean luma does follow the light, but UVC controls are global and would disturb a running call, and the camera reports neither its automatic exposure through the controls nor through UVC metadata.

## Model

Keys and slider never write to the monitor. They move a target, and the monitors glide towards it.

```
daylight curve ─┐
                ├─► target ──► glide ──► ddcutil setvcp
offset ─────────┘      │
                       └─► osd and slider show the target at once
```

| Part       | Approach                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Detection  | `ddcutil detect --terse` once and after `monitors-changed`, then a read per bus                  |
| Glide      | one `setvcp` after another, each covering half the remaining distance, two steps or less at once |
| Manual     | the level found on the monitor at start, then moved by keys and slider                           |
| Automatic  | curve from irradiance plus a persistent offset, which keys and slider move instead of the level  |
| Feedback   | the GNOME OSD on key presses, a `QuickSlider` with a switch for the automatic mode in its menu   |
| Failure    | a failed write drops the state, the next change detects afresh                                   |
| No weather | the level holds where it is and stays adjustable                                                 |

Every DDC/CI capable monitor follows the same target in percent of its own range. Monitors report differing maxima, the G95NC for instance 50 rather than 100, which also means its steps are 2 % wide and a glide cannot be finer than that.

## Daylight curve

The irradiance comes from [Open-Meteo](https://open-meteo.com) as `shortwave_radiation` in quarter hour resolution, without an API key. It is global horizontal irradiance from the DWD ICON model and already folds sun elevation, cloud cover and precipitation into one figure. A local Netatmo station nearby was looked at too, it carries rain and wind modules but no light sensor.

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

Some monitors accept the value but do not apply it while a picture mode fixes the brightness. On the G95NC the eco mode and the dynamic brightness had to be turned off.

## Limits

The curve is modelled, not measured. A single cloud passing the sun, the orientation of the window, blinds and room lighting are not seen. The offset is meant to absorb the constant part of that.

A change made through the monitor menu is not seen either, the next glide starts from the level last written.

Monitors keep their settings in non-volatile memory with a limited number of write cycles, and whether the G95NC stores every DDC/CI write right away or defers it is not documented. No case of a monitor worn out this way could be found, yet f.lux held back DDC/CI control over a figure of about 100,000 cycles, and KDE Powerdevil delays and merges its writes for the same reason. Bursts are what the sources point at, so the glide is kept short and the curve moves in single writes behind its hysteresis. That leaves an estimated 20 to 40 writes a day.

`ddcutil` 2.2 verifies every write by reading it back, and `--noverify` conflicts with that default in the tested build. A write thus takes around 0.2 s, which is what paces the glide.
