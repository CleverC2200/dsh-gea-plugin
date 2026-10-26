import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const name = "profile-readiness-probe";
export const inject = ["loader"];
const services = [
  "agentPresets",
  "loader",
  "connection",
  "tools",
  "agents",
  "userAgents",
  "agentResources",
];
const available = (ctx, names) =>
  Object.fromEntries(
    names.map((name) => {
      try {
        return [name, ctx.get(name) !== undefined];
      } catch {
        return [name, false];
      }
    }),
  );
const fiberSnapshot = (fiber) =>
  fiber === undefined
    ? null
    : {
        uid: fiber.uid,
        name: fiber.runtime?.name ?? null,
        state: fiber.state,
        parentUid: fiber.parent?.fiber?.uid ?? null,
        inertia: Boolean(fiber.inertia),
        services: available(fiber.ctx, Object.keys(fiber.inject)),
      };
function belongsToManage(fiber) {
  const seen = new Set();
  while (fiber && !seen.has(fiber.uid)) {
    seen.add(fiber.uid);
    if (fiber.runtime?.name === "dsh-agent-manage") return true;
    fiber = fiber.parent?.fiber;
  }
  return false;
}
export function readProfileReadinessSnapshot(ctx) {
  return {
    services: available(ctx, services),
    fibers: [...ctx.registry.values()]
      .flatMap((runtime) => [...runtime.fibers])
      .filter(belongsToManage)
      .map(fiberSnapshot),
    gea: [...ctx.loader.entries()]
      .filter((entry) => entry.options.name === "@cleverc2200/gea-dsh-prototype")
      .map((entry) => ({ disabled: Boolean(entry.disabled), fiber: fiberSnapshot(entry.fiber) })),
    standard: [...ctx.loader.entries()]
      .filter(
        (entry) =>
          entry.options.name === "@deepseek-ai/dsh-agent-preset" &&
          entry.options.config?.id === "standard",
      )
      .map((entry) => ({ disabled: Boolean(entry.disabled), fiber: fiberSnapshot(entry.fiber) })),
  };
}
export async function installProfileReadinessProbe(runtime) {
  const patch = join(runtime, "home/profiles/plugin-split-validation/cordis.patch.yml");
  await mkdir(dirname(patch), { recursive: true });
  const output = process.env.GITHUB_WORKSPACE
    ? join(
        process.env.GITHUB_WORKSPACE,
        "quality-test-results",
        `profile-readiness-${basename(dirname(runtime))}-${basename(runtime)}.ndjson`,
      )
    : join(runtime, "profile-readiness.ndjson");
  await mkdir(dirname(output), { recursive: true });
  try {
    await writeFile(
      patch,
      JSON.stringify([
        {
          insert: [
            {
              id: name,
              name: import.meta.url,
              config: { output },
            },
          ],
        },
      ]) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return false;
  }
}
export async function apply(ctx, { output }) {
  const startedAt = Date.now();
  const record = (phase) =>
    appendFile(
      output,
      JSON.stringify({
        observerOnly: true,
        pid: process.pid,
        phase,
        elapsedMs: Date.now() - startedAt,
        ...readProfileReadinessSnapshot(ctx),
      }) + "\n",
      { mode: 0o600 },
    );
  await record("mounted");
  const timers = [1000, 5000, 20000].map((ms) =>
    setTimeout(() => {
      void record("after-" + ms).catch(() =>
        ctx.logger.warn("[DEBUG-MPS-C5] readiness journal write failed"),
      );
    }, ms).unref(),
  );
  ctx.effect(() => async () => {
    timers.forEach(clearTimeout);
    await record("dispose");
  });
}
