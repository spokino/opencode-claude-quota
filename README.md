# opencode-claude-quota

Show your **real** Claude subscription usage - the exact panel from
[claude.ai/settings/usage](https://claude.ai/settings/usage) (5-hour session +
weekly limits) - live in the **OpenCode TUI sidebar**.

```
▼ ⚡ Claude usage 0.1.0
 Session (5h)          10%
 ██░░░░░░░░░░░░░░░░  resets in 3m
 Weekly all             8%
 █░░░░░░░░░░░░░░░░░  resets in 5d 11h
 Weekly Fable           0%
 ░░░░░░░░░░░░░░░░░░
 updated 20:31:42
```

Unlike token-log estimators (ccusage etc.), this reads the **authoritative
server-side quota** straight from Anthropic - the same numbers claude.ai and
Claude Code's own statusline show.

## How it works

It calls the Anthropic OAuth usage endpoint using the OAuth token OpenCode
already stores when you log in to Claude:

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <token from OpenCode auth.json>
anthropic-beta: oauth-2025-04-20
```

No browser cookie, no API key, no config. If you're logged into Claude in
OpenCode, it just works.

## Install

### npm (recommended)

Add to your **`tui.json`** (not `opencode.json` - sidebar plugins live in the
TUI config):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-claude-quota"]
}
```

Restart OpenCode. The `⚡ Claude usage` panel appears in the sidebar.

### From source (GitHub)

```bash
git clone https://github.com/spokino/opencode-claude-quota.git
cd opencode-claude-quota
bun install && bun run build
```

Then reference the built file in `tui.json` with an **absolute** `file://` URL:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-claude-quota/dist/index.js"]
}
```

> A **relative** `file://./...` reference is silently ignored by OpenCode - use
> an absolute path.

## Usage

- The panel auto-refreshes every 90s.
- **`Alt+Q`** toggles the panel collapsed/expanded (state persists).
- Bars are color-coded: green under 70%, yellow 70-90%, red 90%+.

## Configuration

Optional environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_QUOTA_POLL_MS` | `90000` | Refresh interval in ms (min 30000 - the endpoint rate-limits hard). |
| `CLAUDE_QUOTA_BAR_WIDTH` | `18` | Progress bar width in characters (6-40). |
| `CLAUDE_QUOTA_AUTH_PATH` | auto | Explicit path to OpenCode `auth.json` if auto-detection fails. |

`auth.json` is auto-detected across Windows / macOS / Linux OpenCode install
locations.

## What the rows mean

| Row | Source field | Meaning |
|-----|--------------|---------|
| Session (5h) | `limits[].kind == "session"` | Rolling 5-hour window |
| Weekly all | `weekly_all` | 7-day all-models limit |
| Weekly \<model\> | `weekly_scoped` | Per-model weekly limit (e.g. Fable) |

## Troubleshooting

- **"no Anthropic login in OpenCode"** - log in to Claude in OpenCode first
  (`/connect` or the Anthropic OAuth flow).
- **"token expired - reopen OpenCode"** - the OAuth token lapsed; reopening
  OpenCode refreshes it.
- **"rate limited"** - the endpoint returned 429; it will recover on the next
  poll. Don't lower `CLAUDE_QUOTA_POLL_MS` below the floor.
- **Panel doesn't appear** - confirm the entry is in `tui.json` (not
  `opencode.json`), the sidebar is visible, and (from source) the `file://`
  path is absolute and points at the built `dist/index.js`.

## Disclaimer

This tool reads **your own** subscription quota using **your own** OAuth token,
read-only, and stores nothing. It talks to an internal (community
reverse-engineered) Anthropic endpoint. Anthropic's terms restrict OAuth tokens
to first-party use, so this is a **gray area** - use at your own risk. It makes
one request per poll interval and never sends your token anywhere except
Anthropic. If Anthropic changes or restricts the endpoint, the panel may stop
working.

Not affiliated with or endorsed by Anthropic or the OpenCode project.

## License

MIT - see [LICENSE](./LICENSE).
