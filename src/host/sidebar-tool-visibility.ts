/** Read the current Agent's public Tools projection without admission or execution. */
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-tools";

export function mountSidebarToolVisibility(
  ctx: Context,
  business: { status(): { authenticated: boolean } },
): () => void {
  const reply = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  return ctx.connection.fetch.register({
    path: "/api/gea-proof/sidebar-tool-visibility",
    methods: ["GET"],
    fetch: (request) => {
      if (!business.status().authenticated)
        return reply({ error: "LOGIN_REQUIRED" }, 401);
      const sessionId = new URL(request.url).searchParams.get("sessionId");
      if (!sessionId || !/^session-[a-zA-Z0-9-]{1,80}$/.test(sessionId))
        return reply({ error: "SESSION_ID_REQUIRED" }, 400);
      const agent = ctx.agents.get(sessionId as SessionId);
      if (!agent) return reply({ error: "SESSION_NOT_READY" }, 404);
      return reply({
        tool: "sidebar_open",
        registered: ctx.tools.schemas().some((tool) => tool.name === "sidebar_open"),
        visible: ctx.tools.schemas(agent).some((tool) => tool.name === "sidebar_open"),
      });
    },
  });
}
