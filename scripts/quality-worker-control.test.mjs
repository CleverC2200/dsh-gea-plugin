import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

const expected = {
  repository: "CleverC2200/dsh-gea-plugin",
  runId: "123",
  runAttempt: "2",
  headSha: "a".repeat(40),
};
const core = "b".repeat(40);
async function api(t, reply) {
  const server = createServer((request, response) => {
    const body = reply(request.url);
    response.writeHead(body?.error ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return "http://127.0.0.1:" + server.address().port;
}
test("the worker waits for this attempt's successful producer and returns unique immutable artifact identities", async (t) => {
  let polls = 0;
  const apiBase = await api(t, (url) => {
    if (url.endsWith("/attempts/2"))
      return { id: 123, run_attempt: 2, head_sha: expected.headSha, status: "in_progress" };
    if (url.includes("/jobs?"))
      return {
        total_count: 1,
        jobs: [
          {
            id: 7,
            run_id: 123,
            head_sha: expected.headSha,
            name: "prepare-" + core,
            status: ++polls === 1 ? "in_progress" : "completed",
            conclusion: polls === 1 ? null : "success",
          },
        ],
      };
    return {
      total_count: 2,
      artifacts: ["index", "bundle"].map((kind, i) => ({
        id: i + 20,
        name: `quality-a2-${kind}-${core}`,
        expired: false,
        workflow_run: { id: 123, head_sha: expected.headSha },
      })),
    };
  });
  const { waitForWorkerArtifacts } = await import("./quality-worker-control.mjs");
  const result = await waitForWorkerArtifacts({
    expected,
    core,
    apiBase,
    timeoutMs: 1000,
    pollMs: 5,
  });
  assert.equal(polls, 2);
  assert.equal(result.index.id, 20);
  assert.equal(result.bundle.id, 21);
  assert.equal(result.producer.id, 7);
});

test("a producer without an actual job ID cannot authorize received artifacts", async (t) => {
  const apiBase = await api(t, (url) =>
    url.endsWith("/attempts/2")
      ? { id: 123, run_attempt: 2, head_sha: expected.headSha, status: "in_progress" }
      : url.includes("/jobs?")
        ? {
            total_count: 1,
            jobs: [
              {
                run_id: 123,
                head_sha: expected.headSha,
                name: "prepare-" + core,
                status: "completed",
                conclusion: "success",
              },
            ],
          }
        : {
            total_count: 2,
            artifacts: ["index", "bundle"].map((kind, i) => ({
              id: i + 20,
              name: `quality-a2-${kind}-${core}`,
              expired: false,
              workflow_run: { id: 123, head_sha: expected.headSha },
            })),
          },
  );
  const { waitForWorkerArtifacts } = await import("./quality-worker-control.mjs");
  await assert.rejects(waitForWorkerArtifacts({ expected, core, apiBase }), /producer identity/);
});

test("the early browser CLI inventories its real three-package closure and detects shipped bytes outside metadata", async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worker-browser-deps-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), "{}");
  for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
    const directory = join(root, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name,
        version: "1.58.2",
        dependencies:
          name === "@playwright/test"
            ? { playwright: "1.58.2" }
            : name === "playwright"
              ? { "playwright-core": "1.58.2" }
              : {},
        ...(name === "playwright" ? { optionalDependencies: { fsevents: "2.3.2" } } : {}),
        bin: { [name === "playwright-core" ? "playwright-core" : "playwright"]: "cli.js" },
      }),
    );
    writeFileSync(
      join(directory, "cli.js"),
      "require('node:fs').writeFileSync(process.argv[2], 'real CLI');",
    );
    writeFileSync(join(directory, "shipped.txt"), "original bytes");
  }
  const { readBrowserDependencyClosure } = await import("./quality-worker-control.mjs");
  const first = readBrowserDependencyClosure({ directory: root, version: "1.58.2" });
  assert.equal(first.status, "passed");
  execFileSync(process.execPath, [first.executable, join(root, "executed")]);
  assert.equal(readFileSync(join(root, "executed"), "utf8"), "real CLI");
  assert.deepEqual(
    readBrowserDependencyClosure({ directory: root, version: "1.58.2" }).inventory,
    first.inventory,
  );
  writeFileSync(join(root, "node_modules/playwright-core/shipped.txt"), "changed bytes");
  assert.notDeepEqual(
    readBrowserDependencyClosure({ directory: root, version: "1.58.2" }).inventory,
    first.inventory,
  );
});

test("same-attempt waits reject failed/cancelled producers, wrong identities, API errors, duplicate or missing artifacts and unknown status", async (t) => {
  const { waitForWorkerArtifacts } = await import("./quality-worker-control.mjs");
  for (const scenario of [
    "wrong-attempt",
    "wrong-head",
    "producer-failed",
    "producer-cancelled",
    "duplicate-producer",
    "missing-artifact",
    "duplicate-artifact",
    "expired",
    "wrong-artifact-run",
    "api",
    "unknown-status",
  ]) {
    await t.test(scenario, async (t) => {
      const apiBase = await api(t, (url) => {
        if (scenario === "api") return { error: 503 };
        if (url.endsWith("/attempts/2"))
          return {
            id: 123,
            run_attempt: scenario === "wrong-attempt" ? 1 : 2,
            head_sha: scenario === "wrong-head" ? "c".repeat(40) : expected.headSha,
            status: scenario === "unknown-status" ? "unrecognized" : "in_progress",
          };
        if (url.includes("/jobs?")) {
          const job = {
            id: 7,
            run_id: 123,
            head_sha: expected.headSha,
            name: "prepare-" + core,
            status: "completed",
            conclusion:
              scenario === "producer-failed"
                ? "failure"
                : scenario === "producer-cancelled"
                  ? "cancelled"
                  : "success",
          };
          return {
            total_count: scenario === "duplicate-producer" ? 2 : 1,
            jobs: scenario === "duplicate-producer" ? [job, { ...job, id: 8 }] : [job],
          };
        }
        const artifacts = ["index", "bundle"].map((kind, i) => ({
          id: i + 20,
          name: `quality-a2-${kind}-${core}`,
          expired: scenario === "expired",
          workflow_run: {
            id: scenario === "wrong-artifact-run" ? 122 : 123,
            head_sha: expected.headSha,
          },
        }));
        if (scenario === "missing-artifact") artifacts.pop();
        if (scenario === "duplicate-artifact") artifacts.push({ ...artifacts[0], id: 22 });
        return { total_count: artifacts.length, artifacts };
      });
      await assert.rejects(
        waitForWorkerArtifacts({ expected, core, apiBase, timeoutMs: 1000, pollMs: 5 }),
        /QUALITY_WORKER_CONTROL_REJECTED/,
      );
    });
  }
});

test("wait deadlines and cancellation abort pending requests rather than leaving them active", async (t) => {
  const { waitForWorkerArtifacts } = await import("./quality-worker-control.mjs");
  let active = 0,
    closed = 0;
  const server = createServer((request, response) => {
    active++;
    response.on("close", () => {
      active--;
      closed++;
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.closeAllConnections());
  t.after(() => server.close());
  const apiBase = "http://127.0.0.1:" + server.address().port;
  await assert.rejects(
    waitForWorkerArtifacts({ expected, core, apiBase, timeoutMs: 35, pollMs: 5 }),
    /API read failed/,
  );
  const controller = new AbortController();
  const pending = waitForWorkerArtifacts({
    expected,
    core,
    apiBase,
    timeoutMs: 5000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 35);
  await assert.rejects(pending, /API read failed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(closed >= 1);
  assert.ok(active <= 1, "aborted request closes; no background polling");
});

test("pnpm local bin wiring is inventoried separately while shipped nested node_modules remains in the exact closure", async (t) => {
  const fs = await import("node:fs"),
    { join, relative, dirname } = await import("node:path"),
    { tmpdir } = await import("node:os");
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "browser-pnpm-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const names = ["@playwright/test", "playwright", "playwright-core"];
  const create = (consumer) => {
    const root = join(base, consumer);
    fs.mkdirSync(root);
    fs.writeFileSync(join(root, "package.json"), "{}");
    const roots = names.map((name) =>
      join(root, "node_modules/.pnpm", name.replace("/", "+") + "@1.58.2", "node_modules", name),
    );
    roots.forEach((path, i) => {
      fs.mkdirSync(path, { recursive: true });
      const name = names[i];
      fs.writeFileSync(
        join(path, "package.json"),
        JSON.stringify({
          name,
          version: "1.58.2",
          dependencies:
            i === 0 ? { playwright: "1.58.2" } : i === 1 ? { "playwright-core": "1.58.2" } : {},
          ...(i === 1 ? { optionalDependencies: { fsevents: "2.3.2" } } : {}),
          bin: { [i === 2 ? "playwright-core" : "playwright"]: "cli.js" },
        }),
      );
      fs.writeFileSync(join(path, "cli.js"), "process.stdout.write('declared CLI');");
      fs.mkdirSync(join(path, "lib/node_modules/vendor"), { recursive: true });
      fs.writeFileSync(join(path, "lib/node_modules/vendor/resource.js"), "shipped nested bytes");
    });
    fs.mkdirSync(join(root, "node_modules/@playwright"), { recursive: true });
    fs.symlinkSync(
      relative(join(root, "node_modules/@playwright"), roots[0]),
      join(root, "node_modules/@playwright/test"),
    );
    roots.slice(0, 2).forEach((path, i) => {
      const edge = join(dirname(i === 0 ? dirname(path) : path), names[i + 1]);
      fs.symlinkSync(relative(dirname(edge), roots[i + 1]), edge);
      fs.mkdirSync(join(path, "node_modules/.bin"), { recursive: true });
      fs.writeFileSync(
        join(path, "node_modules/.bin", i === 0 ? "playwright" : "playwright-core"),
        "#!/bin/sh\n# consumer-specific " + root + "\n",
      );
      fs.chmodSync(
        join(path, "node_modules/.bin", i === 0 ? "playwright" : "playwright-core"),
        0o755,
      );
    });
    return { root, roots };
  };
  const a = create("manage"),
    b = create("gea");
  const { readBrowserDependencyClosure } = await import("./quality-worker-control.mjs");
  const first = readBrowserDependencyClosure({ directory: a.root, version: "1.58.2" }),
    other = readBrowserDependencyClosure({ directory: b.root, version: "1.58.2" });
  assert.equal(first.status, "passed");
  assert.deepEqual(first.inventory, other.inventory);
  assert.notDeepEqual(
    first.localWiring,
    other.localWiring,
    "manager-generated shim bytes are consumer-local, not shipped payload",
  );
  assert.ok(
    first.inventory.packages[0].entries.some(
      (x) => x.path === "lib/node_modules/vendor/resource.js",
    ),
  );
  const { execFileSync } = await import("node:child_process");
  assert.equal(
    execFileSync(process.execPath, [first.executable], { encoding: "utf8" }),
    "declared CLI",
  );
  const ownDependency = join(a.roots[0], "node_modules/playwright");
  fs.symlinkSync(relative(dirname(ownDependency), a.roots[1]), ownDependency);
  assert.equal(
    readBrowserDependencyClosure({ directory: a.root, version: "1.58.2" }).status,
    "passed",
  );
  fs.rmSync(ownDependency);
  fs.symlinkSync(b.roots[1], ownDependency);
  assert.throws(
    () => readBrowserDependencyClosure({ directory: a.root, version: "1.58.2" }),
    /escaped resolved closure|escaped owned modules/,
  );
  fs.rmSync(ownDependency);
  fs.writeFileSync(join(a.roots[0], "node_modules/unknown"), "unknown dependency");
  assert.throws(
    () => readBrowserDependencyClosure({ directory: a.root, version: "1.58.2" }),
    /unexpected browser local dependency/,
  );
  fs.rmSync(join(a.roots[0], "node_modules/unknown"));

  fs.writeFileSync(join(a.roots[0], "node_modules/.bin/playwright"), "changed generated shim");
  assert.notDeepEqual(
    readBrowserDependencyClosure({ directory: a.root, version: "1.58.2" }).localWiring,
    first.localWiring,
  );
  fs.writeFileSync(join(a.roots[0], "node_modules/.bin/unknown"), "unknown executable");
  assert.throws(
    () => readBrowserDependencyClosure({ directory: a.root, version: "1.58.2" }),
    /unexpected browser local bin/,
  );
  fs.rmSync(join(a.roots[0], "node_modules/.bin/unknown"));
  fs.mkdirSync(join(a.roots[0], "node_modules/.bin/playwright-extra"));
  assert.throws(
    () => readBrowserDependencyClosure({ directory: a.root, version: "1.58.2" }),
    /unexpected browser local bin/,
  );
  fs.rmSync(join(a.roots[0], "node_modules/.bin/playwright-extra"), { recursive: true });
  fs.rmSync(join(a.roots[0], "node_modules/.bin/playwright"));
  fs.symlinkSync(join(b.roots[1], "cli.js"), join(a.roots[0], "node_modules/.bin/playwright"));
  assert.throws(
    () => readBrowserDependencyClosure({ directory: a.root, version: "1.58.2" }),
    /browser local bin escaped/,
  );
  fs.rmSync(join(a.roots[0], "node_modules/.bin/playwright"));
  fs.mkdirSync(join(a.roots[0], "node_modules/.bin/playwright"));
  assert.throws(
    () => readBrowserDependencyClosure({ directory: a.root, version: "1.58.2" }),
    /unexpected browser local bin/,
  );
  fs.rmSync(join(a.roots[0], "node_modules/.bin/playwright"), { recursive: true });
  fs.symlinkSync(join(a.roots[1], "cli.js"), join(a.roots[0], "node_modules/.bin/playwright"));
  assert.equal(
    readBrowserDependencyClosure({ directory: a.root, version: "1.58.2" }).status,
    "passed",
  );
  fs.chmodSync(join(a.roots[0], "cli.js"), 0o4755);
  assert.throws(
    () => readBrowserDependencyClosure({ directory: a.root, version: "1.58.2" }),
    /special mode/,
  );
  fs.chmodSync(join(a.roots[0], "cli.js"), 0o644);
  fs.writeFileSync(
    join(a.roots[0], "lib/node_modules/vendor/resource.js"),
    "changed shipped vendored bytes",
  );
  assert.notDeepEqual(
    readBrowserDependencyClosure({ directory: a.root, version: "1.58.2" }).inventory,
    first.inventory,
  );
  fs.rmSync(join(a.roots[0], "lib/node_modules/vendor/resource.js"));
  fs.symlinkSync(
    join(b.roots[0], "cli.js"),
    join(a.roots[0], "lib/node_modules/vendor/resource.js"),
  );
  assert.throws(
    () => readBrowserDependencyClosure({ directory: a.root, version: "1.58.2" }),
    /link escaped package/,
  );
  const manifest = join(a.roots[0], "package.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest)), version: "corrupted" }),
  );
  assert.throws(
    () => readBrowserDependencyClosure({ directory: a.root, version: "1.58.2" }),
    /identity changed/,
  );
});
