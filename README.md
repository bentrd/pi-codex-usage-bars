# pi-codex-usage-bars

Colorful, right-aligned Codex usage bars for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) footer.

It shows remaining ChatGPT Codex subscription quota for the active `openai-codex` model:

```text
████████░░░░░░░░ (3h32)  █████████████░░░ (4d6h)
```

- First bar: primary / short Codex window, usually the 5-hour limit
- Second bar: secondary / long Codex window, usually the weekly limit
- Filled cells (`█`) are remaining usage
- Shaded cells (`░`) are depleted usage
- Parentheses show time until reset
- Colors are randomized per Pi session
- Refreshes on session start, model switch, manual refresh, and after each agent response

## Install

From GitHub:

```bash
pi install git:github.com/bentrd/pi-codex-usage-bars
```

Then reload Pi:

```text
/reload
```

## Commands

Open the interactive config editor:

```text
/codex-usage-bars-config
```

From there you can:

- use a full interactive designer
- change alignment, layout, bar width, refresh interval, and visible bars
- add a custom title
- tune fixed colors with HSL-style sliders
- edit the raw JSON config if you prefer

Reload config, reroll colors if random, and refresh usage:

```text
/codex-usage-bars-refresh
```

## Configuration file

The interactive editor writes to:

```text
~/.pi/agent/codex-usage-bars.json
```

You can also edit it manually.

Example:

```json
{
  "align": "right",
  "layout": "row",
  "barWidth": 16,
  "refreshIntervalMs": 0,
  "bars": "both",
  "palette": "random",
  "title": "",
  "titleColor": "random"
}
```

For fixed custom colors, use:

```json
{
  "align": "right",
  "layout": "row",
  "barWidth": 16,
  "refreshIntervalMs": 0,
  "bars": "both",
  "palette": "fixed",
  "title": "CODEX",
  "titleColor": "fixed",
  "colors": {
    "title": "#ffd479",
    "primaryStart": "#63b3ed",
    "primaryEnd": "#81e6d9",
    "secondaryStart": "#b794f4",
    "secondaryEnd": "#f687b3",
    "empty": "#485060"
  }
}
```

Options:

- `align`: `"left"`, `"center"`, or `"right"`; default `"right"`
- `layout`: `"row"` or `"column"`; default `"row"`
- `barWidth`: `4` to `40`; default `16`. Large values may be truncated on smaller terminal windows.
- `refreshIntervalMs`: `0` to disable timer-based refresh, or `5000` to `600000`; default `0`. Usage still refreshes on session start, model switch, manual refresh, and after each agent response.
- `bars`: `"both"`, `"primary"` / 5h only, or `"secondary"` / weekly only; default `"both"`
- `palette`: `"random"` or `"fixed"`; default `"random"`
- `title`: optional title text; default empty
- `titleColor`: `"random"` or `"fixed"`; default `"random"`
- `colors`: fixed hex colors for `title`, `primaryStart`, `primaryEnd`, `secondaryStart`, `secondaryEnd`, and `empty`

Color controls are conditional: bar colors are only shown for `"palette": "fixed"`; title color is only shown when `title` is non-empty and `titleColor` is `"fixed"`.

Environment variables can override the config file:

```bash
CODEX_USAGE_BARS_ALIGN=left
CODEX_USAGE_BARS_LAYOUT=column
CODEX_USAGE_BARS_BAR_WIDTH=20
CODEX_USAGE_BARS_REFRESH_MS=0
CODEX_USAGE_BARS_BARS=both
CODEX_USAGE_BARS_PALETTE=fixed
CODEX_USAGE_BARS_TITLE=CODEX
CODEX_USAGE_BARS_TITLE_COLOR=fixed
CODEX_USAGE_BARS_TITLE_FIXED_COLOR=#ffd479
CODEX_USAGE_BARS_PRIMARY_START=#63b3ed
CODEX_USAGE_BARS_PRIMARY_END=#81e6d9
CODEX_USAGE_BARS_SECONDARY_START=#b794f4
CODEX_USAGE_BARS_SECONDARY_END=#f687b3
CODEX_USAGE_BARS_EMPTY=#485060
```

Use a custom config path with:

```bash
CODEX_USAGE_BARS_CONFIG=/path/to/codex-usage-bars.json
```

The designer supports align/layout toggles, bar selection, bar width and refresh controls, custom optional title text, live preview, and HSL-style color sliders for each visible fixed color. In row layout, the title is rendered inline with the bars; in column layout, it gets its own line.

Alignment is calculated when the display refreshes. If you resize the terminal and want the alignment fixed immediately, run `/codex-usage-bars-refresh`; otherwise it updates after the next agent response or timer refresh if you enabled `refreshIntervalMs`.

## Auth

The extension tries usage sources in this order:

1. Pi's `openai-codex` provider auth
2. `codex app-server --listen stdio://`

OpenAI API keys are not ChatGPT Codex subscription auth and do not expose these quotas.

## Notes

Pi's default status footer trims normal spaces, so this extension uses an invisible braille blank to visually push the bars to the right without replacing the default footer.

## License

MIT
