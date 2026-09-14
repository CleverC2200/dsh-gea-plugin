/** Authenticated deployment settings for the browser workbench. */
import { isAbsolute } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-connection";
export const inject = ["connection"];
/** The workspace directory used for new business Sessions. */
export interface Config {
  cwd: string;
}
/** Publish configuration through the normal authenticated DSH connection. */
export function apply(ctx: Context, config: Config): void {
  if (!config || typeof config.cwd !== "string" || !isAbsolute(config.cwd))
    throw new Error("agent-workbench: cwd must be absolute");
  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: "/api/agent-workbench/config",
      methods: ["GET"],
      requestBody: "buffered",
      fetch: async () =>
        Response.json(
          { cwd: config.cwd },
          { headers: { "Cache-Control": "no-store" } },
        ),
    }),
  );
}
