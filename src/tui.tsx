// opencode-claude-quota
// Renders the real Claude subscription usage panel (the one at
// https://claude.ai/settings/usage) in the OpenCode TUI sidebar.
//
// Data source: GET https://api.anthropic.com/api/oauth/usage
//   Authorization: Bearer <OpenCode Anthropic OAuth access token>
//   anthropic-beta: oauth-2025-04-20
// This is the same endpoint claude.ai and Claude Code's statusline use.
// The OAuth token comes from OpenCode's Anthropic integration via the server
// half (src/server.ts, over plugin RPC); auth.json is only the TUI-only fallback.
//
// See README for the ToS note: this reads YOUR own quota with YOUR own token,
// read-only, and stores nothing. Use at your own risk.
//
// ---------------------------------------------------------------------------
// Rate limiting (measured 2026-09-09)
// ---------------------------------------------------------------------------
// The 429 bucket is PER CREDENTIAL and allows roughly ONE request per ~90s.
// Evidence: at a fixed 90s cadence the plugin 429'd on 2 of 7 consecutive
// polls (~29%). A second consumer using the same OAuth token 429'd on 4 of 4
// probes spaced 100s apart, while the plugin kept succeeding - i.e. the two
// contend for one shared budget. A browser session cookie has its own,
// separate bucket.
//
// Two consequences drive the design below:
//   1. A fixed 90s poll sits exactly ON the limit, so it fails intermittently.
//      -> The interval is now self-tuning (AIMD), converging on the fastest
//         rate that does NOT 429.
//   2. Quota percentages move by fractions of a percent per minute, so hiding
//      cached numbers behind a transient "rate limited" message is strictly
//      worse than showing slightly stale data.
//      -> Transient errors NEVER replace the panel body.
import { createSignal } from "solid-js";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
import { QuotaRpc } from "./rpc.js";
import {
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
  getUsage,
  type Result,
  type Row,
} from "./usage.js";

// OpenCode v2 TUI plugin: default export { id, setup(context) }.
// Slots: context.ui.slot({ append: "sidebar.content", render }).
// Persisted UI state: context.storage.store(). Theme: context.theme (v2 tokens).
const setup = (api: any) => {
  log(
    `start v${VERSION}; cache=${CACHE_FILE}; ` +
      `mode=${FIXED_POLL_MS ? `fixed ${FIXED_POLL_MS}ms` : "adaptive"}`,
  );

  // Register keymap/slot directly in setup, NOT inside a detached createRoot():
  // the host resolves them through Solid context, and a fresh root has none
  // ("Keymap.Provider is missing").
  const [rows, setRows] = createSignal<Row[]>([]);
  // notice = there is nothing to show at all, so this replaces the body.
  const [notice, setNotice] = createSignal<string>("");
  // warn = we DO have numbers, but something is wrong with them. Rendered as
  // an extra line under the rows so the data stays visible and explained.
  const [warn, setWarn] = createSignal<string>("");
  const [stale, setStale] = createSignal<boolean>(false);
  const [updated, setUpdated] = createSignal<string>("");
  // Kept as a raw timestamp so the rendered age recomputes on every tick
  // rather than freezing at whatever it was when the fetch failed.
  const [updatedAt, setUpdatedAt] = createSignal<number>(0);

  const [prefs, updatePrefs] = api.storage.store("prefs", {
    initial: { expanded: true },
  });
  const expanded = () => prefs.expanded !== false;
  const toggle = () =>
    updatePrefs((d: { expanded: boolean }) => {
      d.expanded = !expanded();
    });

  function prettyErr(m: string): string {
    if (m === "no-token") return "no Anthropic login in OpenCode";
    if (m === "auth expired") return "token expired - send a Claude prompt to refresh";
    return m || "fetch failed";
  }

  // Prefer the server half (token from OpenCode's Anthropic integration,
  // works against remote servers). Without it - plugin configured only in
  // cli.json - fetch locally with the auth.json token instead.
  let rpc: any;
  try {
    rpc = api.client?.rpc?.(QuotaRpc);
  } catch {
    rpc = undefined;
  }
  let useLocal = !rpc;

  async function load(): Promise<Result> {
    if (!useLocal) {
      try {
        return (await rpc.snapshot({})) as Result;
      } catch (e: any) {
        useLocal = true;
        log(`rpc unavailable (${e?.message ?? e}) - fetching locally`);
      }
    }
    return getUsage();
  }

  async function refresh() {
    const res = await load();
    // Cache was mid-write. Leave the display exactly as it is.
    if (res.skip) return;

    if (res.rows.length) setRows(res.rows);

    // No error must ever blank a panel that has numbers in it. If we have
    // rows, they stay on screen and the problem is reported alongside them;
    // only a completely empty panel gets replaced by the message. An earlier
    // version replaced the body on any terminal error, which hid perfectly
    // good figures behind "token expired".
    const nothingToShow = res.rows.length === 0;
    setNotice(res.error && nothingToShow ? prettyErr(res.error) : "");
    setWarn(res.error && !nothingToShow ? prettyErr(res.error) : "");
    setStale(res.stale && res.rows.length > 0);

    if (res.fetchedAt) {
      setUpdated(new Date(res.fetchedAt).toLocaleTimeString());
      setUpdatedAt(res.fetchedAt);
    }
  }

  refresh();
  const timer = setInterval(refresh, TICK_MS);

  api.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "claude-quota.toggle",
        title: "Claude Quota: Toggle panel",
        group: "Claude Quota",
        bind: "alt+q",
        palette: true,
        run: toggle,
      },
    ],
    bindings: ["claude-quota.toggle"],
  }));

  // v2 slot render is a Solid component (called once); the function child
  // below is the reactive part, re-evaluated when signals/prefs change.
  const removeSlot = api.ui.slot({
    append: "sidebar.content",
    render: () =>
      jsx("box", {
        flexDirection: "column",
        children: () => {
        const t = api.theme;
        const theme = {
          text: t.text.base,
          textMuted: t.text.muted,
          error: t.text.feedback?.error?.base,
          warning: t.text.feedback?.warning?.base,
          success: t.text.feedback?.success?.base,
        };

        function colorFor(r: Row) {
          // Prefer the server's own severity when the endpoint provides it.
          switch (r.severity) {
            case "critical":
            case "error":
              return theme.error ?? theme.text;
            case "warning":
            case "warn":
              return theme.warning ?? theme.text;
            case "normal":
              return theme.success ?? theme.text;
          }
          return r.percent >= 90
            ? (theme.error ?? theme.text)
            : r.percent >= 70
              ? (theme.warning ?? theme.text)
              : (theme.success ?? theme.text);
        }

        const header = jsxs("box", {
          flexDirection: "row",
          justifyContent: "space-between",
          onMouseDown: toggle,
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

        if (!expanded()) return [header];

        // Filtering happens at render time, not at fetch time: the shared
        // cache stays canonical so instances with different settings agree.
        const visible = rows().filter((r) => !isHidden(r));

        let body: any;
        if (notice()) {
          body = jsx("text", { fg: theme.textMuted, children: ` ${notice()}` });
        } else if (rows().length === 0) {
          body = jsx("text", { fg: theme.textMuted, children: " loading..." });
        } else if (visible.length === 0) {
          body = jsx("text", { fg: theme.textMuted, children: " all rows hidden" });
        } else {
          body = visible.map((r) => {
            const color = colorFor(r);
            return jsxs("box", {
              flexDirection: "column",
              children: [
                jsxs("box", {
                  flexDirection: "row",
                  justifyContent: "space-between",
                  children: [
                    jsx("text", {
                      fg: theme.text,
                      children: ` ${r.label}${r.active ? " \u00B7" : ""}`,
                    }),
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
                    jsx("text", { fg: theme.textMuted, children: r.resetsAt ? fmtReset(r.resetsAt) : r.reset }),
                  ],
                }),
              ],
            });
          });
        }

        // Age is computed at render time so it keeps counting up while the
        // data is frozen. "stale" on its own once concealed a six-hour gap.
        const ageMs = updatedAt() ? Date.now() - updatedAt() : 0;
        const badlyStale = ageMs > STALE_ALERT_MS;

        // Problems are reported next to the numbers, never instead of them.
        const warnLine =
          warn() || badlyStale
            ? jsx("text", {
                fg: badlyStale ? (theme.warning ?? theme.textMuted) : theme.textMuted,
                children: ` ${warn() || "not refreshing"} \u00B7 ${fmtAge(ageMs)} old`,
              })
            : null;

        const footer = updated()
          ? jsx("text", {
              fg: theme.textMuted,
              children: ` updated ${updated()}${stale() && !warnLine ? " \u00B7 stale" : ""}`,
            })
          : null;

        return [header, ...(Array.isArray(body) ? body : [body]), warnLine, footer];
        },
      }),
  });

  return () => {
    clearInterval(timer);
    removeSlot();
  };
};

export default { id: "claude-quota", setup };
