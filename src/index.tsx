// opencode-claude-quota
// Renders the real Claude subscription usage panel (the one at
// https://claude.ai/settings/usage) in the OpenCode TUI sidebar.
//
// Data source: GET https://api.anthropic.com/api/oauth/usage
//   Authorization: Bearer <OpenCode Anthropic OAuth access token>
//   anthropic-beta: oauth-2025-04-20
// This is the same endpoint claude.ai and Claude Code's statusline use.
// The OAuth token is read from OpenCode's own auth.json (no browser cookie).
//
// See README for the ToS note: this reads YOUR own quota with YOUR own token,
// read-only, and stores nothing. Use at your own risk.
import { createRoot, createSignal, onCleanup } from "solid-js";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = "0.1.0";

// The endpoint rate-limits aggressively (HTTP 429, no Retry-After).
// Do not poll faster than ~90s. Overridable via CLAUDE_QUOTA_POLL_MS.
const POLL_MS = Math.max(
  30_000,
  Number(process.env.CLAUDE_QUOTA_POLL_MS) || 90_000,
);
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BAR_WIDTH = Math.max(
  6,
  Math.min(40, Number(process.env.CLAUDE_QUOTA_BAR_WIDTH) || 24),
);

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

type Auth = { token: string; expires?: number };

function readAuth(): Auth | undefined {
  for (const p of AUTH_PATHS) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      const a = j?.anthropic;
      if (a?.access) return { token: a.access as string, expires: a.expires };
    } catch {
      /* try next path */
    }
  }
  return undefined;
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

function bar(percent: number): string {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((p / 100) * BAR_WIDTH);
  return "\u2588".repeat(filled) + "\u2591".repeat(BAR_WIDTH - filled);
}

type Row = { label: string; percent: number; reset: string };

function labelFor(kind: string, scope: any): string {
  if (kind === "session") return "Session (5h)";
  if (kind === "weekly_all") return "Weekly all";
  if (kind === "weekly_scoped") {
    return `Weekly ${scope?.model?.display_name ?? "scoped"}`;
  }
  return kind;
}

async function fetchUsage(): Promise<Row[]> {
  const auth = readAuth();
  if (!auth) throw new Error("no-token");

  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (res.status === 429) throw new Error("rate limited");
  if (res.status === 401 || res.status === 403) throw new Error("auth expired");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data: any = await res.json();
  const rows: Row[] = [];

  if (Array.isArray(data?.limits) && data.limits.length) {
    for (const l of data.limits) {
      rows.push({
        label: labelFor(l.kind, l.scope),
        percent: Number(l.percent) || 0,
        reset: fmtReset(l.resets_at),
      });
    }
  } else {
    if (data?.five_hour)
      rows.push({
        label: "Session (5h)",
        percent: Number(data.five_hour.utilization) || 0,
        reset: fmtReset(data.five_hour.resets_at),
      });
    if (data?.seven_day)
      rows.push({
        label: "Weekly all",
        percent: Number(data.seven_day.utilization) || 0,
        reset: fmtReset(data.seven_day.resets_at),
      });
  }
  return rows;
}

let initialized = false;

const tui = async (api: any) => {
  if (initialized) return;
  initialized = true;

  createRoot(() => {
    const [rows, setRows] = createSignal<Row[]>([]);
    const [err, setErr] = createSignal<string>("");
    const [updated, setUpdated] = createSignal<string>("");

    const EXPANDED_KV = "claude-quota.expanded";
    const [expanded, setExpanded] = createSignal(
      api.kv?.get?.(EXPANDED_KV, true) !== false,
    );

    async function refresh() {
      try {
        const r = await fetchUsage();
        setRows(r);
        setErr("");
        setUpdated(new Date().toLocaleTimeString());
      } catch (e: any) {
        const m = e?.message;
        setErr(
          m === "no-token"
            ? "no Anthropic login in OpenCode"
            : m === "auth expired"
              ? "token expired - reopen OpenCode"
              : (m ?? "fetch failed"),
        );
      }
    }

    refresh();
    const timer = setInterval(refresh, POLL_MS);
    onCleanup(() => clearInterval(timer));

    const TOGGLE = "claude-quota.toggle";
    api.keymap?.registerLayer?.({
      commands: [
        {
          name: TOGGLE,
          title: "Claude Quota: Toggle panel",
          description: "Collapse or expand the Claude usage panel",
          run: () => {
            const next = !expanded();
            setExpanded(next);
            api.kv?.set?.(EXPANDED_KV, next);
          },
        },
      ],
      bindings: [{ key: "alt+q", cmd: TOGGLE }],
    });

    api.slots?.register?.({
      order: 150,
      slots: {
        sidebar_content(ctx: any) {
          const theme = ctx.theme.current;

          const header = jsxs("box", {
            flexDirection: "row",
            justifyContent: "space-between",
            onMouseDown: () => {
              const next = !expanded();
              setExpanded(next);
              api.kv?.set?.(EXPANDED_KV, next);
            },
            children: [
              jsxs("text", {
                fg: theme.text,
                children: [
                  expanded() ? "\u25BC" : "\u25B6",
                  " \u26A1 Claude usage",
                ],
              }),
              jsx("text", { fg: theme.textMuted, children: ` ${VERSION}` }),
            ],
          });

          if (!expanded())
            return jsx("box", { flexDirection: "column", children: [header] });

          let body: any;
          if (err()) {
            body = jsx("text", { fg: theme.textMuted, children: ` ${err()}` });
          } else if (rows().length === 0) {
            body = jsx("text", { fg: theme.textMuted, children: " loading..." });
          } else {
            body = rows().map((r) => {
              const color =
                r.percent >= 90
                  ? (theme.error ?? theme.text)
                  : r.percent >= 70
                    ? (theme.warning ?? theme.text)
                    : (theme.success ?? theme.text);
              return jsxs("box", {
                flexDirection: "column",
                children: [
                  jsxs("box", {
                    flexDirection: "row",
                    justifyContent: "space-between",
                    children: [
                      jsx("text", { fg: theme.text, children: ` ${r.label}` }),
                      jsx("text", {
                        fg: color,
                        children: `${Math.round(r.percent)}%`,
                      }),
                    ],
                  }),
                  jsxs("box", {
                    flexDirection: "row",
                    justifyContent: "space-between",
                    children: [
                      jsx("text", { fg: color, children: ` ${bar(r.percent)}` }),
                      jsx("text", { fg: theme.textMuted, children: r.reset }),
                    ],
                  }),
                ],
              });
            });
          }

          const footer = updated()
            ? jsx("text", {
                fg: theme.textMuted,
                children: ` updated ${updated()}`,
              })
            : null;

          return jsxs("box", {
            flexDirection: "column",
            children: [
              header,
              ...(Array.isArray(body) ? body : [body]),
              footer,
            ],
          });
        },
      },
    });
  });
};

export default { id: "claude-quota", tui };
