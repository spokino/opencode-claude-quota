# opencode-claude-quota

Show your **real** Claude subscription usage - the exact panel from
[claude.ai/settings/usage](https://claude.ai/settings/usage) (5-hour session +
weekly limits) - live in the **OpenCode TUI sidebar**.

```
▼ ⚡ Claude usage 0.2.1
 Session (5h) ·        10%
 ██░░░░░░░░░░░░░░░░  resets in 3m
 Weekly all             8%
 █░░░░░░░░░░░░░░░░░  resets in 5d 11h
 Weekly Fable           0%
 ░░░░░░░░░░░░░░░░░░
 updated 20:31:42 · stale
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

- The panel refreshes on an **adaptive interval** (see below) - roughly every
  100-150s in steady state.
- **`Alt+Q`** toggles the panel collapsed/expanded (state persists).
- Bars are color-coded: green under 70%, yellow 70-90%, red 90%+. When the
  endpoint reports a `severity` for a row, that wins over the local thresholds.
- A `·` after a row label marks the limit the server flags as currently active.
- The footer shows the last successful fetch time, plus `· stale` when the most
  recent refresh attempt failed.

## Rate limiting and the adaptive interval

The usage endpoint's 429 bucket is **per credential** and allows roughly **one
request per ~90s**. A fixed 90s poll therefore sits exactly *on* the limit and
fails intermittently: measured on 2026-09-09, it returned 429 on **2 of 7
consecutive polls (~29%)**. Anything sharing the same OAuth token contends for
that single budget.

So the poll interval is **self-tuning (AIMD)** instead of fixed:

| Behaviour | Value |
|-----------|-------|
| Starting interval | 150s |
| After 3 consecutive successes | interval drops by 10s |
| On a 429 | interval multiplied by 1.5 |
| Floor / ceiling | 100s / 600s |

It converges on the fastest cadence that does *not* get rate-limited, and
self-heals if Anthropic retunes the limit. The current interval is **persisted
in the shared cache**, so every instance agrees on it and it survives restarts.

`Retry-After` is honoured only when it is **greater than 0**. The endpoint
currently sends `Retry-After: 0`, which taken literally would mean "retry
immediately" and re-trigger the limit.

## Transient errors no longer blank the panel

Previously any error - including a routine 429 - replaced the usage bars with
an error message. That was the main user-visible bug, and it made the panel
useless roughly a third of the time.

Now errors are split in two:

- **Transient** (429, 5xx, network blip) - the last-known numbers **stay on
  screen** and the footer is marked `stale`. Quota moves by fractions of a
  percent per minute, so slightly stale numbers beat no numbers.
- **Terminal** (`no-token`, `auth expired`) - no amount of retrying helps until
  you act, so these *do* replace the panel body.

Non-429 failures (network drops, 5xx) additionally back off on a capped
exponential ladder, up to 15 minutes.

## Configuration

Optional environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_QUOTA_POLL_MS` | unset (adaptive) | **Pins** the interval in ms and **disables adaptation** entirely (min 30000). See the behaviour change note below. |
| `CLAUDE_QUOTA_BAR_WIDTH` | `18` | Progress bar width in characters (6-40). |
| `CLAUDE_QUOTA_HIDE` | unset | Comma-separated, case-insensitive **substring** match against the row label; matching rows are not rendered. E.g. `Fable`. |
| `CLAUDE_QUOTA_HIDE_ZERO` | unset | Set to `1` to hide any row sitting at exactly 0%. |
| `CLAUDE_QUOTA_AUTH_PATH` | auto | Explicit path to OpenCode `auth.json` if auto-detection fails. |
| `CLAUDE_QUOTA_CACHE_FILE` | temp dir | Path to the shared cross-instance cache file (see below). |
| `CLAUDE_QUOTA_LOG` | enabled | Set to `0` to disable the debug log. |
| `CLAUDE_QUOTA_LOG_FILE` | `<tmp>/opencode-claude-quota.log` | Debug log location. |

> [!IMPORTANT]
> **Behaviour change in 0.2.0:** `CLAUDE_QUOTA_POLL_MS` used to be simply the
> poll period, layered on top of the built-in 90s default. It now **pins the
> interval and turns AIMD off**, so the plugin will no longer back off on a 429
> or speed up when the endpoint is healthy. Leave it unset unless you
> specifically need deterministic timing.

### Hiding rows

The endpoint always returns **every** scoped weekly bucket, including models you
never touch - so `Weekly Fable` can sit permanently at 0% and eat two lines of
sidebar. `CLAUDE_QUOTA_HIDE` drops rows by label substring, and
`CLAUDE_QUOTA_HIDE_ZERO=1` drops anything at exactly 0%:

```bash
CLAUDE_QUOTA_HIDE=Fable
CLAUDE_QUOTA_HIDE_ZERO=1
```

Filtering happens at **render time, not fetch time**. The shared cross-instance
cache therefore stays canonical - it always holds the full response - so
instances configured with different filters still agree on the underlying
numbers and continue to share a single fetch per interval. Changing these
variables never invalidates the cache or costs an extra request.

If every row ends up filtered out, the panel renders ` all rows hidden` rather
than an empty box, so a too-aggressive filter is obvious instead of looking like
a broken plugin.

### Debug log

The log records **status codes, latency and the current interval only** - never
tokens, headers or response bodies. It lands in a world-readable temp dir by
default, so nothing sensitive is written to it. It self-truncates at 256 KB.

## Multiple OpenCode instances

If you run several OpenCode instances at once, they **share a single cache file**
(in your OS temp dir) and coordinate so that **only one instance fetches per
poll interval** - the rest render from the shared cache with no network call.
All instances show the same, in-sync numbers, and you never trigger the
endpoint's rate limit by multiplying requests.

Coordination is hardened as of 0.2.0:

- **Atomic cache writes** - written to a per-pid temp file, then renamed over
  the target, so readers can never see a half-written file.
- **A real lock file** - created with an exclusive `wx` open, which actually
  guarantees one winner. The previous read-check-write "soft lock" had no
  exclusivity, so two instances could claim it simultaneously. A lock left
  behind by an instance that died mid-fetch is taken over after 15s.
- **A torn or unreadable cache now skips the tick** instead of being treated as
  "no cache". Previously a torn read looked identical to a first run and
  triggered a fetch, burning the single request the whole account gets per
  interval.

Set `CLAUDE_QUOTA_CACHE_FILE` to override the cache location (e.g. to isolate
profiles).

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
- **Footer says `stale`** - the last refresh hit a 429, a 5xx or a network
  error. The numbers shown are the last good ones and the interval has already
  backed off; it recovers on its own. Nothing to do.
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
