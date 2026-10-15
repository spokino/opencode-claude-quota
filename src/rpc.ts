// RPC contract between the server half (fetches) and the TUI half (renders).
// Plain object: Rpc.define() from @opencode/plugin/rpc is an identity function,
// so the contract needs no runtime import.
export const QuotaRpc = {
  id: "claude-quota",
  methods: {
    // Freshest usage for rendering. Cheap to call often: it is served from the
    // shared cache and only hits Anthropic when the adaptive interval is due.
    snapshot: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object" },
    },
  },
  events: {},
} as const;
