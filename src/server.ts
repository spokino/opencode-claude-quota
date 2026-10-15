// Server half. Resolves the OAuth token from OpenCode's own Anthropic
// integration (no auth.json scraping) and serves usage over plugin RPC, so the
// TUI also works against a remote OpenCode server.
import { QuotaRpc } from "./rpc.js";
import { getUsage, readAuth, log, type Auth } from "./usage.js";

const PROVIDER = "anthropic";

export default {
  id: "claude-quota",
  async setup(ctx: any) {
    async function integrationAuth(): Promise<Auth | undefined> {
      const connection = await ctx.integration.connection.active(PROVIDER);
      const credential = connection
        ? await ctx.integration.connection.resolve(connection)
        : undefined;
      if (credential?.type === "oauth" && typeof credential.access === "string") {
        return { token: credential.access, expires: credential.expires };
      }
      // API-key logins have no subscription quota; legacy auth.json may still.
      return readAuth();
    }

    await ctx.rpc.register(QuotaRpc, {
      snapshot: async () => {
        try {
          // RPC output must be plain JSON: v2 rejects `undefined` fields
          // (e.g. errorKind on success) with rpc.invalid_output.
          return JSON.parse(JSON.stringify(await getUsage(integrationAuth)));
        } catch (e: any) {
          log(`server snapshot failed: ${e?.message ?? e}`);
          return { rows: [], error: "fetch failed", stale: true };
        }
      },
    });
  },
};
