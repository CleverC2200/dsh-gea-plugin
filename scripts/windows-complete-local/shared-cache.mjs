import { execFileSync } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [operation, directory, destination] = process.argv.slice(2);
const root = resolve(directory);
const profiles = ["official", "windows-runtime"];
const plans = profiles.map((profile) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./core-cache.mjs", import.meta.url)), "plan", root, profile],
      { encoding: "utf8" },
    ),
  ),
);
const keys = plans.map((plan) => plan.key);
const defaultRef = `refs/heads/${process.env.GITHUB_DEFAULT_BRANCH}`;
if (operation === "check-request") {
  if (
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.GITHUB_REF !== defaultRef
  )
    throw Error("DELIVERY_CACHE_DEFAULT_REF_REQUIRED");
  if (process.env.CACHE_REQUEST) {
    const request = JSON.parse(process.env.CACHE_REQUEST);
    if (JSON.stringify(request.keys) !== JSON.stringify(keys))
      throw Error("DELIVERY_CACHE_PREPARATION_INPUT_CHANGED");
  }
  console.log(
    JSON.stringify({ status: "default-ref-input-verified", keys, sourceRef: defaultRef }),
  );
} else if (operation === "preflight") {
  const started = Date.now();
  const report = {
    requested: process.env.DSH_DELIVERY_REUSE_INPUTS !== "false",
    defaultRef,
    reason: "unknown",
    layers: keys.map((key, index) => ({
      profile: profiles[index],
      key,
      available: false,
      sourceRef: "unknown",
      reason: "unknown",
    })),
  };
  const base = `${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${process.env.GITHUB_REPOSITORY}/actions`;
  async function api(path, body) {
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2026-03-10",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Error(`cache-api-${response.status}`);
    return response.json();
  }
  async function inspect() {
    for (const layer of report.layers) {
      const query = new URLSearchParams({ ref: defaultRef, key: layer.key, per_page: "100" });
      const result = await api(`/caches?${query}`);
      if (!Array.isArray(result.actions_caches)) throw Error("cache-api-response-invalid");
      layer.available = result.actions_caches.some(
        (entry) => entry.key === layer.key && entry.ref === defaultRef,
      );
      layer.sourceRef = layer.available ? defaultRef : "unknown";
      layer.reason = layer.available ? "default-ref-key-present" : "readable-scope-empty";
      if (!layer.available) {
        const prefix = layer.key.slice(0, layer.key.lastIndexOf("-") + 1);
        const other = await api(
          `/caches?${new URLSearchParams({ ref: defaultRef, key: prefix, per_page: "100" })}`,
        );
        if (!Array.isArray(other.actions_caches)) throw Error("cache-api-response-invalid");
        if (
          other.actions_caches.some(
            (entry) => entry.ref === defaultRef && entry.key.startsWith(prefix),
          )
        )
          layer.reason = "input-changed";
      }
    }
  }
  try {
    if (!report.requested) report.reason = "reuse-disabled";
    else {
      await inspect();
      report.reason = "default-ref-key-present";
      if (
        report.layers.some((layer) => !layer.available) &&
        process.env.GITHUB_REF !== defaultRef
      ) {
        const dispatched = await api("/workflows/delivery-fixtures.yml/dispatches", {
          ref: process.env.GITHUB_DEFAULT_BRANCH,
          return_run_details: true,
          inputs: { prepare_windows_cache: "true", cache_request: JSON.stringify({ keys }) },
        });
        if (!Number.isSafeInteger(dispatched.workflow_run_id))
          throw Error("cache-dispatch-run-unknown");
        report.preparationRunId = dispatched.workflow_run_id;
        const deadline = Date.now() + 30 * 60 * 1000;
        for (;;) {
          if (Date.now() > deadline) throw Error("cache-preparation-timeout");
          const run = await api(`/runs/${report.preparationRunId}`);
          if (
            run.head_branch !== process.env.GITHUB_DEFAULT_BRANCH ||
            run.event !== "workflow_dispatch"
          )
            throw Error("cache-preparation-ref-mismatch");
          if (run.status === "completed") {
            report.preparationConclusion = run.conclusion;
            await inspect();
            report.reason = report.layers.every((layer) => layer.available)
              ? "default-ref-prepared"
              : run.conclusion === "success"
                ? "preparation-input-changed-or-cache-unavailable"
                : "default-ref-preparation-failed";
            break;
          }
          await new Promise((done) => setTimeout(done, 15000));
        }
      } else if (report.layers.some((layer) => !layer.available))
        report.reason = "readable-scope-empty";
    }
  } catch (error) {
    report.reason = /^(?:cache-|default-ref)/.test(error.message)
      ? error.message
      : "cache-service-unavailable";
    report.fallback = "cold-preparation";
  }
  report.seconds = (Date.now() - started) / 1000;
  await mkdir(dirname(resolve(destination)), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `Windows cache preflight: ${report.reason}; ${report.seconds}s. Main preparation run: ${report.preparationRunId ?? "none"}.\n`,
    );
  console.log(JSON.stringify(report));
} else throw Error("DELIVERY_SHARED_CACHE_OPERATION_INVALID");
