import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-connection";
import type { createPluginUpdateController } from "./plugin-update-controller.ts";
import { updateObject, updatePackageName } from "../shared/plugin-update-wire.ts";
import { updatablePackageNames } from "../shared/plugin-release.mjs";

export function mountDesktopUpdateOperations(
  ctx: Context,
  ready: () => Promise<ReturnType<typeof createPluginUpdateController>>,
): () => void {
  const releaseAdmission = ctx.on("connection/request", async (request, response, next) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname === "/api/desktop/update") {
      response.writeHead(403);
      response.end();
      return;
    }
    await next();
  });
  const releaseRoute = ctx.connection.fetch.register({
    path: "/api/desktop/update",
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      try {
        const controller = await ready();
        const payload = updateObject(await request.json());
        let value: object;
        switch (payload.action) {
          case "plugins-status":
            if (
              Object.keys(payload).some((key) => !["action", "operationId"].includes(key)) ||
              (payload.operationId !== undefined &&
                (typeof payload.operationId !== "string" ||
                  !/^[a-f0-9-]{36}$/.test(payload.operationId)))
            )
              throw Error("UPDATE_REQUEST_INVALID");
            value = controller.operationStatus(payload.operationId);
            break;
          case "plugins-install": {
            if (
              Object.keys(payload).length !== 2 ||
              !Array.isArray(payload.plans) ||
              !payload.plans.length ||
              payload.plans.length > updatablePackageNames.length
            )
              throw Error("UPDATE_REQUEST_INVALID");
            const plans = payload.plans.map((raw) => {
              const plan = updateObject(raw);
              if (
                Object.keys(plan).length !== 2 ||
                typeof plan.planId !== "string" ||
                !/^[a-f0-9-]{36}$/.test(plan.planId)
              )
                throw Error("UPDATE_REQUEST_INVALID");
              return { packageName: updatePackageName(plan.packageName), planId: plan.planId };
            });
            const operation = await controller.submitBatch(plans);
            value = { operationId: operation.id };
            break;
          }
          case "desktop-prepare":
            if (
              Object.keys(payload).length !== 2 ||
              typeof payload.desktopVersion !== "string" ||
              !payload.desktopVersion ||
              payload.desktopVersion.length > 200
            )
              throw Error("UPDATE_REQUEST_INVALID");
            await controller.prepareDesktop(payload.desktopVersion);
            value = {};
            break;
          case "desktop-cancel":
            if (Object.keys(payload).length !== 1) throw Error("UPDATE_REQUEST_INVALID");
            await controller.cancelDesktop();
            value = {};
            break;
          default:
            throw Error("UPDATE_REQUEST_INVALID");
        }

        return Response.json({ ok: true, value }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        const code =
          error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
            ? error.message
            : "UPDATE_REQUEST_FAILED";
        return Response.json({ ok: false, error: { code } }, { status: 409 });
      }
    },
  });
  return () => {
    releaseRoute();
    releaseAdmission();
  };
}
