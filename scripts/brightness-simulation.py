#!/usr/bin/env python3
"""Counts how often the daylight curve would write to the monitor.

Usage: python3 scripts/brightness-simulation.py [--html out.html]

The figures in docs/brightness.md come from here. It mirrors the formulas of
lib/brightness.js rather than measuring a real day, so a change to the curve,
the step ratio or the hysteresis has to be made in both places. What it models
is a day with four cloud passages, which is the case that produces writes.

Without --html it prints the table; with it, a chart page is written that shows
the distribution, the irradiance and what arrives at the monitor.
"""

import argparse
import json
import math

# kept in sync with lib/brightness.js
RADIATION_SCALE = 50
RADIATION_FULL = 800
AUTO_MIN = 20
AUTO_MAX = 100
LUMINANCE_FLOOR = 15
DDC_MIN_PERCENT = 5

# the monitor in use reports 50 steps, which is what limits how fine a step
# ratio can usefully be: below its resolution several steps collapse onto the
# same raw value and the saving disappears
DDC_MAX_RAW = 50

CLOUDS = ((9.2, 1.1, 0.45), (11.0, 0.6, 0.70), (13.4, 1.8, 0.35), (16.1, 0.9, 0.60))


def curve(radiation):
    bounded = min(max(radiation, 0), RADIATION_FULL)
    share = math.log1p(bounded / RADIATION_SCALE) / math.log1p(RADIATION_FULL / RADIATION_SCALE)
    return AUTO_MIN + (AUTO_MAX - AUTO_MIN) * share


def distribute(target, ratio):
    wanted = max(0, min(100, round(target)))

    if wanted >= DDC_MIN_PERCENT:
        steps = math.floor(math.log(wanted / 100) / math.log(ratio))
        ddc = min(100 * ratio**steps, 100)
        if ddc >= DDC_MIN_PERCENT:
            return round(ddc), max(LUMINANCE_FLOOR, min(100, round(wanted / ddc * 100)))

    share = min(wanted / DDC_MIN_PERCENT, 1)
    return 0, round(LUMINANCE_FLOOR + (100 - LUMINANCE_FLOOR) * share)


def radiation(minute):
    hour = minute / 60
    if hour < 6 or hour > 20:
        return 0

    arc = math.sin((hour - 6) / 14 * math.pi) ** 1.5
    cover = 1.0
    for start, length, depth in CLOUDS:
        if start <= hour < start + length:
            cover = min(cover, depth)

    return 780 * arc * cover


def simulate(targets, hysteresis, ratio):
    """Returns the number of writes and the level that actually arrives."""
    held = None
    written = None
    writes = 0
    levels = []

    for target in targets:
        if held is None or abs(target - held) >= hysteresis:
            held = target

        if ratio is None:
            raw = round(held / 100 * DDC_MAX_RAW)
            level = raw / DDC_MAX_RAW * 100
        else:
            ddc, luminance = distribute(held, ratio)
            raw = round(ddc / 100 * DDC_MAX_RAW)
            level = ddc * luminance / 100

        if raw != written:
            writes += 1
            written = raw

        levels.append(level)

    return writes, levels


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--html', help='write a chart page to this path')
    arguments = parser.parse_args()

    minutes = list(range(24 * 60))
    targets = [curve(radiation(minute)) for minute in minutes]

    variants = [None, 0.9, 0.85, 0.8, 0.75, 0.7]
    table = []
    for ratio in variants:
        table.append(
            {
                'label': 'ohne Aufteilung' if ratio is None else f'Ratio {ratio}',
                'hyst4': simulate(targets, 4, ratio)[0],
                'hyst1': simulate(targets, 1, ratio)[0],
                'lumMin': 100 if ratio is None else round(ratio * 100),
            }
        )

    width = max(len(row['label']) for row in table)
    print(f"{'Variante':<{width}}  Hyst 4  Hyst 1  Lum min")
    for row in table:
        print(f"{row['label']:<{width}}  {row['hyst4']:>6}  {row['hyst1']:>6}  {row['lumMin']:>6} %")

    if not arguments.html:
        return

    step = 5
    data = {
        'minutes': minutes[::step],
        'radiation': [round(radiation(m)) for m in minutes[::step]],
        'target': [round(t, 1) for t in targets[::step]],
        'old': [round(v, 1) for v in simulate(targets, 4, None)[1][::step]],
        'new': [round(v, 1) for v in simulate(targets, 1, 0.8)[1][::step]],
        'table': table,
        'splitX': list(range(101)),
        'splitDdc': [distribute(t, 0.8)[0] for t in range(101)],
        'splitLum': [distribute(t, 0.8)[1] for t in range(101)],
    }

    with open(arguments.html, 'w') as handle:
        handle.write(render(data))
    print(f"\nchart written to {arguments.html}")


def render(data):
    from textwrap import dedent

    width, height = 820, 190
    pad_l, pad_r, pad_t, pad_b = 48, 16, 14, 26

    def line(xs, ys, x0, x1, y0, y1, stepped=False):
        parts = []
        for index, (x, y) in enumerate(zip(xs, ys)):
            px = pad_l + (x - x0) / (x1 - x0) * (width - pad_l - pad_r)
            py = pad_t + (1 - (y - y0) / (y1 - y0)) * (height - pad_t - pad_b)
            if index == 0:
                parts.append(f'M{px:.1f},{py:.1f}')
            elif stepped:
                parts.append(f'H{px:.1f}')
                parts.append(f'V{py:.1f}')
            else:
                parts.append(f'L{px:.1f},{py:.1f}')
        return ' '.join(parts)

    def frame(x0, x1, y0, y1, xticks, yticks, xfmt, yfmt):
        out = []
        for value in yticks:
            py = pad_t + (1 - (value - y0) / (y1 - y0)) * (height - pad_t - pad_b)
            out.append(f'<line class="grid" x1="{pad_l}" y1="{py:.1f}" x2="{width-pad_r}" y2="{py:.1f}"/>')
            out.append(f'<text class="tick" x="{pad_l-8}" y="{py+4:.1f}" text-anchor="end">{yfmt(value)}</text>')
        for value in xticks:
            px = pad_l + (value - x0) / (x1 - x0) * (width - pad_l - pad_r)
            out.append(f'<text class="tick" x="{px:.1f}" y="{height-8}" text-anchor="middle">{xfmt(value)}</text>')
        return '\n'.join(out)

    hours = [0, 360, 720, 1080, 1430]
    split = frame(0, 100, 0, 105, [0, 25, 50, 75, 100], [0, 25, 50, 75, 100], str, str)
    split += f'\n<path class="s2" d="{line(data["splitX"], data["splitDdc"], 0, 100, 0, 105, True)}"/>'
    split += f'\n<path class="s3" d="{line(data["splitX"], data["splitLum"], 0, 100, 0, 105)}"/>'

    sky = frame(0, 1435, 0, 800, hours, [0, 400, 800], lambda v: f'{v//60:02d}:00', str)
    sky += f'\n<path class="s4" d="{line(data["minutes"], data["radiation"], 0, 1435, 0, 800)}"/>'

    day = frame(0, 1435, 0, 105, hours, [0, 25, 50, 75, 100], lambda v: f'{v//60:02d}:00', str)
    day += f'\n<path class="s1 dashed" d="{line(data["minutes"], data["target"], 0, 1435, 0, 105)}"/>'
    day += f'\n<path class="s2" d="{line(data["minutes"], data["old"], 0, 1435, 0, 105, True)}"/>'
    day += f'\n<path class="s3" d="{line(data["minutes"], data["new"], 0, 1435, 0, 105, True)}"/>'

    rows = '\n'.join(
        f'<tr><th scope="row">{row["label"]}</th><td>{row["hyst4"]}</td>'
        f'<td>{row["hyst1"]}</td><td>{row["lumMin"]} %</td></tr>'
        for row in data['table']
    )

    return dedent(f'''\
        <!doctype html>
        <html lang="de"><head><meta charset="utf-8">
        <title>Helligkeit: Aufteilung und Schreibvorgänge</title>
        <style>
        .viz-root {{
          color-scheme: light;
          --surface-1: #fcfcfb; --text-primary: #0b0b0b; --text-secondary: #52514e;
          --muted: #8a8880; --grid: #e6e5e0;
          --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100;
          background: var(--surface-1); color: var(--text-primary);
          font: 14px/1.5 Cantarell, system-ui, sans-serif;
          margin: 0; padding: 28px 32px; max-width: 900px;
        }}
        @media (prefers-color-scheme: dark) {{
          :root:where(:not([data-theme="light"])) .viz-root {{
            color-scheme: dark;
            --surface-1: #1a1a19; --text-primary: #ffffff; --text-secondary: #c3c2b7;
            --muted: #8a8880; --grid: #2f2f2c;
            --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500;
          }}
        }}
        h1 {{ font-size: 19px; margin: 0 0 4px; }}
        h2 {{ font-size: 14px; margin: 26px 0 2px; }}
        p.lede {{ color: var(--text-secondary); margin: 0 0 18px; }}
        p.note {{ color: var(--text-secondary); margin: 2px 0 6px; font-size: 13px; }}
        .stats {{ display: flex; gap: 32px; margin: 18px 0 4px; }}
        .stat b {{ display: block; font-size: 30px; font-weight: 600; line-height: 1.1; }}
        .stat span {{ color: var(--text-secondary); font-size: 13px; }}
        svg {{ display: block; width: 100%; height: auto; }}
        .grid {{ stroke: var(--grid); stroke-width: 1; }}
        .tick {{ fill: var(--muted); font-size: 11px; }}
        path {{ fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }}
        .s1 {{ stroke: var(--s1); }} .s2 {{ stroke: var(--s2); }}
        .s3 {{ stroke: var(--s3); }} .s4 {{ stroke: var(--s4); }}
        .dashed {{ stroke-dasharray: 4 4; }}
        .legend {{ display: flex; gap: 18px; margin: 6px 0 0; font-size: 13px; color: var(--text-secondary); }}
        .legend i {{ display: inline-block; width: 11px; height: 11px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }}
        table {{ border-collapse: collapse; margin-top: 10px; font-variant-numeric: tabular-nums; }}
        th, td {{ text-align: right; padding: 5px 14px 5px 0; border-bottom: 1px solid var(--grid); }}
        th[scope=row] {{ text-align: left; font-weight: 400; }}
        thead th {{ color: var(--text-secondary); font-weight: 600; font-size: 13px; }}
        </style></head>
        <body class="viz-root">

        <h1>Helligkeit: Aufteilung zwischen Panel und Signal</h1>
        <p class="lede">Simulierter Tag mit vier Wolkendurchgängen, gerechnet mit den Formeln aus
        <code>lib/brightness.js</code>. Monitor mit {DDC_MAX_RAW} DDC-Stufen.</p>

        <div class="stats">
          <div class="stat"><b style="color:var(--s2)">{data['table'][0]['hyst4']}</b><span>Schreibvorgänge ohne Aufteilung</span></div>
          <div class="stat"><b style="color:var(--s3)">{data['table'][3]['hyst1']}</b><span>mit Aufteilung, Ratio 0,8</span></div>
          <div class="stat"><b>80 %</b><span>Luminance im schlechtesten Fall</span></div>
        </div>

        <h2>Woraus sich eine Zielhelligkeit zusammensetzt</h2>
        <p class="note">Der Monitor nimmt die nächsthöhere Stufe, das Signal senkt auf den Zielwert ab.</p>
        <svg viewBox="0 0 {width} {height}" role="img" aria-label="Aufteilung je Zielhelligkeit">{split}</svg>
        <div class="legend">
          <span><i style="background:var(--s2)"></i>Monitor, DDC-Stufe in %</span>
          <span><i style="background:var(--s3)"></i>Signal, Luminance in %</span>
          <span style="color:var(--muted)">x: Zielhelligkeit in %</span>
        </div>

        <h2>Einstrahlung über den Tag</h2>
        <svg viewBox="0 0 {width} {height}" role="img" aria-label="Einstrahlung in Watt pro Quadratmeter">{sky}</svg>
        <div class="legend"><span><i style="background:var(--s4)"></i>W/m², eigene Skala</span></div>

        <h2>Was davon am Monitor ankommt</h2>
        <p class="note">Gestrichelt das Ziel der Kurve, durchgezogen die tatsächlich gesetzte Helligkeit.</p>
        <svg viewBox="0 0 {width} {height}" role="img" aria-label="Helligkeitsverlauf über den Tag">{day}</svg>
        <div class="legend">
          <span><i style="background:var(--s1)"></i>Ziel der Kurve</span>
          <span><i style="background:var(--s2)"></i>Hysterese 4, ohne Aufteilung</span>
          <span><i style="background:var(--s3)"></i>Hysterese 1, Ratio 0,8</span>
        </div>

        <h2>Schreibvorgänge pro Tag</h2>
        <table>
        <thead><tr><th scope="col">Variante</th><th scope="col">Hysterese 4</th>
        <th scope="col">Hysterese 1</th><th scope="col">Luminance min</th></tr></thead>
        <tbody>
        {rows}
        </tbody></table>

        </body></html>
    ''')


if __name__ == '__main__':
    main()
