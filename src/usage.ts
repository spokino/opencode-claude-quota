// Usage fetching, shared cross-instance cache and adaptive polling.
// Used by the server half (token from OpenCode's Anthropic integration) and by
// the TUI half as a fallback when the server half is not loaded.
import {
  appendFileSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = "1.0.0";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

// --- Adaptive poll interval (AIMD) -----------------------------------------
// Start comfortably above the measured limit, then creep down while the
// endpoint keeps saying yes, and back off multiplicatively when it says no.
// This finds the fastest sustainable rate without hard-coding a guess, and
// self-heals if Anthropic retunes the limit.
const INTERVAL_START_MS = 150_000;
// 90s is measured to fail ~29% of the time, so never go below 100s.
const INTERVAL_FLOOR_MS = 100_000;
const INTERVAL_CEIL_MS = 600_000;
const INTERVAL_STEP_DOWN_MS = 10_000;
const OK_STREAK_TO_SPEED_UP = 3;
const BACKOFF_FACTOR = 1.5;

// Setting CLAUDE_QUOTA_POLL_MS pins the interval and DISABLES adaptation,
// for anyone who wants deterministic behaviour.
const rawFixedPoll = Number(process.env.CLAUDE_QUOTA_POLL_MS);
const FIXED_POLL_MS =
  Number.isFinite(rawFixedPoll) && rawFixedPoll > 0
    ? Math.max(30_000, rawFixedPoll)
    : undefined;

const BAR_WIDTH = Math.max(
  6,
  Math.min(40, Number(process.env.CLAUDE_QUOTA_BAR_WIDTH) || 18),
);

// Rows worth hiding. The endpoint always returns every scoped weekly bucket,
// including models the user never touches (e.g. "Weekly Fable" pinned at 0%).
// CLAUDE_QUOTA_HIDE is a comma-separated, case-insensitive substring match
// against the rendered label. CLAUDE_QUOTA_HIDE_ZERO=1 additionally drops any
// row sitting at exactly 0%.
const HIDE_PATTERNS = (process.env.CLAUDE_QUOTA_HIDE ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const HIDE_ZERO = process.env.CLAUDE_QUOTA_HIDE_ZERO === "1";

function isHidden(r: Row): boolean {
  if (HIDE_ZERO && Math.round(r.percent) === 0) return true;
  const label = r.label.toLowerCase();
  return HIDE_PATTERNS.some((p) => label.includes(p));
}

// How long another instance's lock file is honored before we assume it died
// mid-fetch and take over.
const LOCK_TTL_MS = 15_000;
// Ceiling for the exponential ladder used by NON-429 failures (network drops,
// 5xx). 429s do not use this ladder - the adaptive interval absorbs them.
const MAX_BACKOFF_MS = 15 * 60_000;
// Hard ceiling on ANY cooldown, including a server-supplied Retry-After.
// The endpoint has been observed returning "Retry-After: 3600" (one hour);
// honouring that verbatim froze the panel for an hour. A quota panel is worth
// re-checking far sooner than the server's worst-case hint suggests.
const MAX_COOLDOWN_MS = 10 * 60_000;
// How long to wait before re-reading auth.json after finding an expired token.
// This costs no network call, so it can be short - the moment OpenCode
// refreshes the token the panel recovers.
const AUTH_RECHECK_MS = 30_000;
// Treat the token as dead slightly before its stated expiry, to avoid firing a
// request that will land after it lapses.
const AUTH_SKEW_MS = 60_000;
// Data older than this is called out visibly instead of hidden behind a
// one-word "stale" marker.
const STALE_ALERT_MS = 15 * 60_000;
// A persistently unparseable cache must not wedge every instance forever.
// After this many consecutive unreadable reads, overwrite it.
const MAX_UNREADABLE_STREAK = 5;
// Display refresh. Decoupled from the poll interval: a short tick only syncs
// the display with the SHARED cache, it does not cause network calls.
const TICK_MS = 5_000;

// OpenCode auth.json locations, first match wins. Covers Windows, macOS, Linux.
const AUTH_PATHS = [
  process.env.CLAUDE_QUOTA_AUTH_PATH,
  join(homedir(), ".local", "share", "opencode", "auth.json"),
  process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "opencode", "auth.json")
    : undefined,
  process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, "opencode", "auth.json")
    : undefined,
  join(homedir(), ".config", "opencode", "auth.json"),
  // macOS Application Support
  join(homedir(), "Library", "Application Support", "opencode", "auth.json"),
].filter(Boolean) as string[];

export type Auth = { token: string; expires?: number };

// Where the OAuth token comes from. The server half resolves it from OpenCode's
// Anthropic integration; the TUI-only fallback reads auth.json.
export type AuthSource = () => Auth | undefined | Promise<Auth | undefined>;

function readOpenCodeAuth(): Auth | undefined {
  for (const p of AUTH_PATHS) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
      const a = j?.anthropic;
      if (a?.access) return { token: a.access as string, expires: a.expires };
    } catch {
      /* try next path */
    }
  }
  return undefined;
}

// Claude Code keeps its own OAuth token for the same account and refreshes it
// whenever the CLI runs. Read-only: we never refresh or write it back, so we
// cannot desync either client's refresh token.
function readClaudeCodeAuth(): Auth | undefined {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  try {
    const j = JSON.parse(
      readFileSync(join(dir, ".credentials.json"), "utf8").replace(/^\uFEFF/, ""),
    );
    const a = j?.claudeAiOauth;
    if (typeof a?.accessToken === "string") {
      return { token: a.accessToken, expires: Number(a.expiresAt) || undefined };
    }
  } catch {
    /* not installed / not logged in */
  }
  return undefined;
}

function isLive(a: Auth, now = Date.now()): boolean {
  return !a.expires || a.expires - AUTH_SKEW_MS >= now;
}

// First live token in priority order; if none is live, the one expiring last
// (so the expiry pre-flight still reports it).
export function pickAuth(...candidates: (Auth | undefined)[]): Auth | undefined {
  const all = candidates.filter((a): a is Auth => !!a);
  const live = all.find((a) => isLive(a));
  if (live) return live;
  return all.sort((x, y) => (y.expires ?? 0) - (x.expires ?? 0))[0];
}

export function readAuth(): Auth | undefined {
  return pickAuth(readOpenCodeAuth(), readClaudeCodeAuth());
}

// --- Debug log --------------------------------------------------------------
// Status codes, timings and interval only. NEVER the token, headers or any
// response body - this file lands in a world-readable temp dir.
const LOG_FILE =
  process.env.CLAUDE_QUOTA_LOG_FILE ||
  join(tmpdir(), "opencode-claude-quota.log");
const LOG_MAX_BYTES = 256 * 1024;
const LOG_ENABLED = process.env.CLAUDE_QUOTA_LOG !== "0";

function log(line: string): void {
  if (!LOG_ENABLED) return;
  try {
    try {
      if (statSync(LOG_FILE).size > LOG_MAX_BYTES) unlinkSync(LOG_FILE);
    } catch {
      /* no log yet */
    }
    appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] pid=${process.pid} ${line}\n`,
      "utf8",
    );
  } catch {
    /* logging must never break the panel */
  }
}

function fmtReset(iso?: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = t - Date.now();
  if (diff <= 0) return "resetting";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `resets in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `resets in ${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `resets in ${d}d ${h % 24}h`;
}

// "3m" / "1h 12m" / "6h". Used to state how old the numbers actually are - a
// bare "stale" marker once hid a six-hour gap.
function fmtAge(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function bar(percent: number): string {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((p / 100) * BAR_WIDTH);
  return "\u2588".repeat(filled) + "\u2591".repeat(BAR_WIDTH - filled);
}

type Row = {
  label: string;
  percent: number;
  reset: string; // formatted at fetch time; fallback only
  resetsAt?: string; // raw ISO, re-formatted on every render
  severity?: string;
  active?: boolean;
};

function labelFor(kind: string, scope: any): string {
  if (kind === "session") return "Session (5h)";
  if (kind === "weekly_all") return "Weekly all";
  if (kind === "weekly_scoped") {
    return `Weekly ${scope?.model?.display_name ?? "scoped"}`;
  }
  return kind;
}

// --- Error taxonomy ---------------------------------------------------------
// terminal  = no amount of retrying helps until the user acts (no login,
//             expired token). Worth replacing the panel body with.
// transient = rate limit, network blip, 5xx. Cached numbers stay on screen.
type ErrorKind = "terminal" | "transient";

class UsageError extends Error {
  kind: ErrorKind;
  rateLimited: boolean;
  retryAfterMs?: number;
  constructor(
    message: string,
    kind: ErrorKind,
    opts?: { rateLimited?: boolean; retryAfterMs?: number },
  ) {
    super(message);
    this.kind = kind;
    this.rateLimited = opts?.rateLimited ?? false;
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

// Raw fetch of the live endpoint.
async function fetchUsageRaw(auth: Auth): Promise<Row[]> {
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });

  if (res.status === 429) {
    // The endpoint currently sends "Retry-After: 0", which taken literally
    // would mean "retry immediately" and re-trigger the limit. Only honor a
    // positive value.
    const ra = Number(res.headers.get("retry-after"));
    throw new UsageError("rate limited", "transient", {
      rateLimited: true,
      retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined,
    });
  }
  if (res.status === 401 || res.status === 403) {
    throw new UsageError("auth expired", "terminal");
  }
  if (!res.ok) throw new UsageError(`HTTP ${res.status}`, "transient");

  const data: any = await res.json();
  const rows: Row[] = [];

  if (Array.isArray(data?.limits) && data.limits.length) {
    for (const l of data.limits) {
      rows.push({
        label: labelFor(l.kind, l.scope),
        percent: Number(l.percent) || 0,
        reset: fmtReset(l.resets_at),
        resetsAt: l.resets_at ?? undefined,
        // Optional server-driven fields. Absent on older responses, in which
        // case rendering falls back to local percentage thresholds.
        severity: typeof l.severity === "string" ? l.severity : undefined,
        active: l.is_active === true,
      });
    }
  } else {
    if (data?.five_hour)
      rows.push({
        label: "Session (5h)",
        percent: Number(data.five_hour.utilization) || 0,
        reset: fmtReset(data.five_hour.resets_at),
        resetsAt: data.five_hour.resets_at ?? undefined,
      });
    if (data?.seven_day)
      rows.push({
        label: "Weekly all",
        percent: Number(data.seven_day.utilization) || 0,
        reset: fmtReset(data.seven_day.resets_at),
        resetsAt: data.seven_day.resets_at ?? undefined,
      });
  }
  return rows;
}

// ---- Shared cross-instance cache (so N OpenCode instances = 1 fetch/interval)
// All instances share one JSON file in the OS temp dir. Each instance, on its
// tick, reads the file: if fresh it just renders the cached rows and makes NO
// network call. If stale, an exclusive lock file lets exactly one instance do
// the fetch while the others render cached data.
const CACHE_FILE =
  process.env.CLAUDE_QUOTA_CACHE_FILE ||
  join(tmpdir(), "opencode-claude-quota-cache.json");
const LOCK_FILE = `${CACHE_FILE}.lock`;

type Cache = {
  rows?: Row[];
  fetchedAt?: number; // ms epoch of last successful fetch
  error?: string; // last error message, if the last attempt failed
  errorKind?: ErrorKind; // decides whether the panel body is replaced
  cooldownUntil?: number; // ms epoch: do not attempt another fetch before this
  failures?: number; // consecutive NON-429 failures, drives exponential ladder
  intervalMs?: number; // adaptive poll interval, shared by all instances
  okStreak?: number; // consecutive successes, drives the speed-up
};

type CacheRead =
  | { state: "ok"; cache: Cache }
  | { state: "missing" }
  | { state: "unreadable" };

function readCache(): CacheRead {
  let raw: string;
  try {
    raw = readFileSync(CACHE_FILE, "utf8");
  } catch {
    // Genuinely absent - first run. Fetching is the correct response.
    return { state: "missing" };
  }
  try {
    // Tolerate a UTF-8 BOM. Anything that hand-edits this file on Windows
    // (PowerShell 5.1's `Set-Content -Encoding utf8`, most notably) prepends
    // one, and JSON.parse rejects it - which used to wedge every instance.
    return { state: "ok", cache: JSON.parse(raw.replace(/^\uFEFF/, "")) as Cache };
  } catch {
    // The file exists but did not parse. Previously this was indistinguishable
    // from "no cache", so a torn read made an instance fetch and burn the one
    // request the whole account gets per interval. Now we skip the tick.
    return { state: "unreadable" };
  }
}

// Atomic: write a per-pid temp file, then rename over the target. Prevents the
// torn reads that the multi-instance setup would otherwise produce.
function writeCache(c: Cache): void {
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(c), "utf8");
    renameSync(tmp, CACHE_FILE);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing else to do */
    }
  }
}

// Real mutex via exclusive create. The old read-check-write sequence had no
// exclusivity, so instances could claim it simultaneously.
function acquireLock(now: number): boolean {
  try {
    writeFileSync(LOCK_FILE, String(now), { flag: "wx" });
    return true;
  } catch {
    /* held by someone - fall through to the staleness check */
  }
  try {
    if (now - statSync(LOCK_FILE).mtimeMs > LOCK_TTL_MS) {
      // Previous holder died mid-fetch. Take over.
      unlinkSync(LOCK_FILE);
      writeFileSync(LOCK_FILE, String(now), { flag: "wx" });
      log("lock: took over stale lock");
      return true;
    }
  } catch {
    /* another instance won the takeover race */
  }
  return false;
}

function releaseLock(): void {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    /* already gone */
  }
}

function currentInterval(cache: Cache): number {
  if (FIXED_POLL_MS) return FIXED_POLL_MS;
  const v = Number(cache.intervalMs);
  if (!Number.isFinite(v) || v <= 0) return INTERVAL_START_MS;
  return Math.max(INTERVAL_FLOOR_MS, Math.min(INTERVAL_CEIL_MS, v));
}

type Result = {
  skip?: boolean; // cache unreadable this tick - leave the display untouched
  rows: Row[];
  error: string;
  errorKind?: ErrorKind;
  fetchedAt?: number;
  stale: boolean;
};

function fromCache(cache: Cache, stale: boolean): Result {
  return {
    rows: cache.rows ?? [],
    error: cache.error ?? "",
    errorKind: cache.errorKind,
    fetchedAt: cache.fetchedAt,
    stale,
  };
}

// Consecutive unreadable cache reads. Skipping the tick is the right response
// to a torn read, but a permanently corrupt file must not wedge us forever.
let unreadableStreak = 0;

// Returns the freshest data for rendering, fetching only when needed and only
// from one instance at a time.
export async function getUsage(authSource: AuthSource = readAuth): Promise<Result> {
  const now = Date.now();
  const read = readCache();

  if (read.state === "unreadable") {
    unreadableStreak += 1;
    if (unreadableStreak <= MAX_UNREADABLE_STREAK) {
      return { skip: true, rows: [], error: "", stale: false };
    }
    // Escape hatch: the file is not merely being written, it is broken.
    // Fall through and treat it as missing so the next write repairs it.
    log(`cache unreadable x${unreadableStreak} - overwriting`);
  } else {
    unreadableStreak = 0;
  }

  const cache: Cache = read.state === "ok" ? read.cache : {};
  const interval = currentInterval(cache);

  // 1. Cache is fresh -> render it, no network.
  if (cache.fetchedAt && now - cache.fetchedAt < interval && cache.rows) {
    return fromCache(cache, false);
  }

  // 2. In a cooldown -> do NOT hit the network; render last data.
  if (cache.cooldownUntil && now < cache.cooldownUntil) {
    return fromCache(cache, true);
  }

  // 3. Local pre-flight on the token. auth.json carries an `expires` stamp, so
  // a dead token can be detected for free. Firing the request anyway is worse
  // than useless: it cannot succeed, and it spends one of the very few
  // requests the endpoint allows. That is exactly how an overnight token
  // lapse escalated into an hour-long 429 lockout.
  let auth: Auth | undefined;
  try {
    auth = await authSource();
  } catch (e: any) {
    log(`auth source failed: ${e?.message ?? e}`);
  }
  if (!auth) {
    writeCache({ ...cache, error: "no-token", errorKind: "terminal", cooldownUntil: now + AUTH_RECHECK_MS });
    return { rows: cache.rows ?? [], error: "no-token", errorKind: "terminal", fetchedAt: cache.fetchedAt, stale: true };
  }
  if (auth.expires && auth.expires - AUTH_SKEW_MS < now) {
    // No network call. Re-check soon: OpenCode rewrites auth.json as soon as
    // it makes any inference call, and we pick that up on the next tick.
    writeCache({ ...cache, error: "auth expired", errorKind: "terminal", cooldownUntil: now + AUTH_RECHECK_MS });
    log(`token expired locally - skipping fetch, recheck in ${AUTH_RECHECK_MS / 1000}s`);
    return { rows: cache.rows ?? [], error: "auth expired", errorKind: "terminal", fetchedAt: cache.fetchedAt, stale: true };
  }

  // 4. Cache is stale but another instance is already fetching.
  if (!acquireLock(now)) {
    return fromCache(cache, true);
  }

  // 4. We hold the lock. Fetch.
  const started = Date.now();
  try {
    const rows = await fetchUsageRaw(auth);
    const fetchedAt = Date.now();
    const ms = fetchedAt - started;

    // Additive decrease of the interval: after a run of successes, try going
    // a little faster next time.
    let okStreak = (cache.okStreak ?? 0) + 1;
    let intervalMs = interval;
    if (!FIXED_POLL_MS && okStreak >= OK_STREAK_TO_SPEED_UP) {
      intervalMs = Math.max(INTERVAL_FLOOR_MS, interval - INTERVAL_STEP_DOWN_MS);
      okStreak = 0;
    }

    writeCache({
      rows,
      fetchedAt,
      error: "",
      errorKind: undefined,
      cooldownUntil: undefined,
      failures: 0,
      intervalMs,
      okStreak,
    });
    log(`fetch ok in ${ms}ms; interval ${interval}ms -> ${intervalMs}ms; okStreak=${okStreak}`);
    return { rows, error: "", fetchedAt, stale: false };
  } catch (e: any) {
    const err: UsageError =
      e instanceof UsageError
        ? e
        : new UsageError(e?.message ?? "fetch failed", "transient");
    const ms = Date.now() - started;

    let intervalMs = interval;
    let cooldownUntil: number;
    let failures = cache.failures ?? 0;

    if (err.rateLimited) {
      // Multiplicative increase. The interval itself carries the throttle, so
      // there is no separate exponential ladder to climb here.
      if (!FIXED_POLL_MS) {
        intervalMs = Math.min(
          INTERVAL_CEIL_MS,
          Math.round(interval * BACKOFF_FACTOR),
        );
      }
      // Clamp the server hint. A Retry-After of 3600 has been observed in the
      // wild; obeying it literally froze the panel for a full hour even after
      // the underlying problem had cleared.
      cooldownUntil = now + Math.min(err.retryAfterMs ?? intervalMs, MAX_COOLDOWN_MS);
      failures = 0;
    } else if (err.kind === "terminal") {
      // Nothing will change until the user re-authenticates. Check back at the
      // normal interval rather than hammering.
      cooldownUntil = now + interval;
      failures = 0;
    } else {
      // Network drop / 5xx: exponential ladder, capped.
      failures += 1;
      cooldownUntil =
        now + Math.min(interval * 2 ** (failures - 1), MAX_BACKOFF_MS);
    }

    // Defence in depth: whatever the branch above decided, never park the
    // panel for longer than MAX_COOLDOWN_MS.
    cooldownUntil = Math.min(cooldownUntil, now + MAX_COOLDOWN_MS);

    writeCache({
      ...cache,
      error: err.message,
      errorKind: err.kind,
      cooldownUntil,
      failures,
      intervalMs,
      okStreak: 0,
    });
    log(
      `fetch FAIL "${err.message}" (${err.kind}) after ${ms}ms; ` +
        `interval ${interval}ms -> ${intervalMs}ms; ` +
        `cooldown ${Math.round((cooldownUntil - now) / 1000)}s`,
    );
    return {
      rows: cache.rows ?? [],
      error: err.message,
      errorKind: err.kind,
      fetchedAt: cache.fetchedAt,
      stale: true,
    };
  } finally {
    releaseLock();
  }
}

export type { Row, Result, ErrorKind };
export {
  VERSION,
  TICK_MS,
  STALE_ALERT_MS,
  FIXED_POLL_MS,
  CACHE_FILE,
  log,
  bar,
  fmtAge,
  fmtReset,
  isHidden,
};

// Internals exposed for the test harness only.
export const __internals = {
  getUsage,
  readCache,
  writeCache,
  acquireLock,
  releaseLock,
  currentInterval,
  UsageError,
  isHidden,
  HIDE_PATTERNS,
  HIDE_ZERO,
  CACHE_FILE,
  LOCK_FILE,
  INTERVAL_START_MS,
  INTERVAL_FLOOR_MS,
  INTERVAL_CEIL_MS,
  OK_STREAK_TO_SPEED_UP,
  MAX_COOLDOWN_MS,
  AUTH_RECHECK_MS,
  AUTH_SKEW_MS,
  MAX_UNREADABLE_STREAK,
  readAuth,
  fmtAge,
};
