# opencode-claude-quota

Show your **real** Claude subscription usage - the exact panel from
[claude.ai/settings/usage](https://claude.ai/settings/usage) (5-hour session +
weekly limits) - live in the **OpenCode TUI sidebar**.

```
▼ ⚡ Claude usage 1.0.0
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

It calls the Anthropic OAuth usage endpoint with the OAuth token OpenCode
already holds for your Claude login:

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <OpenCode Anthropic OAuth token>
anthropic-beta: oauth-2025-04-20
```

No browser cookie, no API key, no config. If you're logged into Claude in
OpenCode, it just works.

Since 1.0.0 the plugin targets **OpenCode v2** and has two halves:

| Half | Entry | Job |
| --- | --- | --- |
| server | `.` (`dist/server.js`) | Resolves the token from OpenCode's **Anthropic integration** (`ctx.integration.connection`), fetches usage, serves it over plugin RPC (`claude-quota.snapshot`) |
| TUI | `./tui` (`dist/tui.js`) | Renders the sidebar panel from the RPC. Works against a remote OpenCode server too |

If the server half is not loaded (plugin configured only in `cli.json`), the
TUI falls back to fetching locally with the token from `auth.json`.

It is deliberately **not** an OpenCode integration: integrations define how a
service is *connected* (API key / OAuth / CLI login). This plugin only
*consumes* the existing Anthropic connection.

> OpenCode v1 is not supported by 1.x. For v1, build from commit `a651468` (0.2.2).

## Install

### npm (recommended)

Add to **`opencode.json`**. OpenCode v2 loads the server half there and the
CLI picks up the `./tui` panel automatically:

```json
{
  "plugins": ["opencode-claude-quota"]
}
```

Restart OpenCode. The `⚡ Claude usage` panel appears in the sidebar.

### From source (GitHub)

```bash
git clone https://github.com/spokino/opencode-claude-quota.git
cd opencode-claude-quota
bun install && bun run build
```

Then reference the **directory** with an absolute `file://` URL:

```json
{
  "plugins": ["file:///absolute/path/to/opencode-claude-quota"]
}
```

> A local plugin directory is loaded through its root `index.js` (server) and
> `tui.js` (panel), which re-export `dist/`. OpenCode v2 ignores `package.json`
> `exports` for local directories and silently skips a directory without them;
> pointing at a single `.js` file is rejected ("configured plugin path must be
> a directory").

## Usage

- The panel refreshes on an **adaptive interval** (see below) - roughly every
  100-150s in steady state.
- **`Alt+Q`** toggles the panel collapsed/expanded (state persists).
- Bars are color-coded: green under 70%, yellow 70-90%, red 90%+. When the
  endpoint reports a `severity` for a row, that wins over the local thresholds.
- A `·` after a row label marks the limit the server flags as currently active.
- The footer shows the last successful fetch time. If a refresh is failing, an
  extra line states the reason and **how old the numbers actually are**
  (`token expired - reopen OpenCode · 5h 51m old`), highlighted in the warning
  colour once the data passes 15 minutes.

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

### `Retry-After` is clamped at both ends

The server's own retry hint is not trusted unconditionally, because it has been
observed to be useless in both directions:

- **`0` is ignored.** The endpoint routinely sends `Retry-After: 0`, which taken
  literally means "retry immediately" and simply re-triggers the limit. Only a
  value **greater than 0** is honoured.
- **Large values are capped at 10 minutes** (`MAX_COOLDOWN_MS`). A
  `Retry-After: 3600` has been seen in the wild; obeying it verbatim parked the
  panel for a full hour, long after the underlying problem had cleared. A quota
  panel is worth re-checking far sooner than the server's worst-case hint
  suggests.

That 10-minute ceiling is also applied as a final clamp over **every** failure
branch, not just the 429 path - so no combination of errors, backoff ladders and
server hints can freeze the panel for longer than that.

## Expired tokens cost no requests

`auth.json` carries an `expires` timestamp, so a dead token can be spotted
locally **for free**. Before it will even try to take the fetch lock, the plugin
checks that stamp (with 60s of slack) and, if the token has lapsed, **skips the
network call entirely** and re-checks in 30s.

This matters more than it sounds. Firing a request with a known-dead token is
worse than useless: it cannot succeed, and it still spends one of the very few
requests the endpoint allows. That is exactly how a **single overnight token
lapse escalated into an hour-long lockout**: the machine slept, no inference
happened so OpenCode never refreshed the token, the plugin kept retrying with
the dead credential, burned the rate-limit budget on doomed requests, and was
answered with `Retry-After: 3600` - which the old code obeyed literally. Net
effect: ~6 hours of frozen numbers.

Because the pre-flight is a local file read, recovery is automatic and
immediate: the moment OpenCode rewrites `auth.json` (which it does on any
inference call), the next tick picks it up. A missing token (`no-token`) is
treated the same way.

## Errors never blank a populated panel

Originally any error - including a routine 429 - replaced the usage bars with an
error message. 0.2.0 fixed that for *transient* errors but still let a
**terminal** one (`no-token`, `auth expired`) wipe the body, which meant a
lapsed token hid perfectly good cached figures behind "token expired".

The rule is now simply: **if there are numbers, the numbers stay.**

- **Rows present** - they remain on screen and the problem is reported on an
  extra line *beneath* them. Quota moves by fractions of a percent per minute,
  so slightly stale numbers beat no numbers, whatever the error class.
- **No rows at all** - there is nothing to protect, so the message replaces the
  body.

To stop that leniency from hiding a real outage, the extra line reports the
**actual age** of the data rather than a bare `stale` marker - which on the
incident above quietly concealed a six-hour gap:

```
 Session (5h) ·        10%
 ██░░░░░░░░░░░░░░░░  resets in 3m
 token expired - reopen OpenCode · 5h 51m old
 updated 20:31:42
```

The age is recomputed on every tick, so it keeps counting up while the data is
frozen instead of freezing along with it, and it switches to the warning colour
past 15 minutes (`STALE_ALERT_MS`).

Non-429 failures (network drops, 5xx) additionally back off on a capped
exponential ladder, up to 15 minutes - subject to the same 10-minute cooldown
ceiling described above.

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
- **A UTF-8 BOM is stripped before parsing** (0.2.2). `JSON.parse` rejects a
  leading BOM, and anything that hand-edits the cache on Windows adds one -
  PowerShell 5.1's `Set-Content -Encoding utf8` most notably. One such edit was
  enough to make the file unparseable and wedge *every* instance at once.
- **Five consecutive unreadable reads triggers a rewrite** (0.2.2,
  `MAX_UNREADABLE_STREAK`). Skipping the tick is the right response to a file
  that is merely mid-write, but it is the wrong response forever. After five
  failures the cache is treated as missing so the next write repairs it, rather
  than the panel waiting indefinitely for a file that will never parse.

Set `CLAUDE_QUOTA_CACHE_FILE` to override the cache location (e.g. to isolate
profiles).

With the server half loaded the token comes from OpenCode's Anthropic
integration. For the TUI-only fallback, `auth.json` is auto-detected across
Windows / macOS / Linux OpenCode install locations.

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
  OpenCode, or just making any inference call, refreshes it. While it is lapsed
  the plugin makes **no requests at all**, so nothing is being wasted, and it
  picks the new token up within 30s. Any cached numbers stay visible.
- **A line like `... · 5h 51m old`** - the last refresh failed and the age tells
  you how far behind the numbers are. Transient causes (429, 5xx, network) clear
  on their own, since the interval has already backed off and no cooldown can
  exceed 10 minutes. An age of hours alongside `token expired` means the
  credential needs refreshing, not the plugin.
- **Panel doesn't appear** - confirm the entry is under `plugins` in
  `opencode.json`, `opencode plugin list` shows `claude-quota`, the sidebar is
  visible, and (from source) the `file://` path is absolute, points at the
  repository directory, and `bun run build` has produced `dist/`.
- **Check the server half directly** -
  `opencode api POST /api/rpc/claude-quota/snapshot -d '{"input":{}}'` returns
  the same rows the panel renders (Git Bash: prefix `MSYS_NO_PATHCONV=1`).

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
