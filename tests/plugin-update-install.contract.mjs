import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { installedScenario } from "./fixtures/plugin-updates/installed-runtime.mjs";
const sdk = process.env.GEA_PLUGIN_UPDATE_SDK;
if (!sdk || !isAbsolute(sdk)) throw Error("GEA_PLUGIN_UPDATE_SDK required");
test(
  "public Host routes use real pnpm and confirm fresh Host/client modules",
  { timeout: 120000 },
  async (t) => {
    const paths = [
      "vendor/cordis/lib/index.js",
      "packages/boot/app-boot/lib/index.js",
      "packages/boot/plugin-manager/lib/index.js",
      "packages/boot/plugin-manager/lib/types/operations.js",
      "packages/util/atomic-write/lib/index.js",
    ];
    const proof = {
      kind: "source",
      root: sdk,
      head: execFileSync("git", ["-C", sdk, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      version: JSON.parse(await readFile(join(sdk, "apps/cli/package.json"), "utf8")).version,
      artifacts: await Promise.all(
        paths.map(async (path) => ({
          path,
          sha256: createHash("sha256")
            .update(await readFile(join(sdk, path)))
            .digest("hex"),
        })),
      ),
    };
    for (const options of [
      { customStore: false },
      { customStore: true },
      { customStore: true, allUpdates: true },
    ]) {
      await t.test(
        options.allUpdates
          ? "three packages install and reconcile in a fresh Host/client process"
          : options.customStore
            ? "company-seeded custom store survives online update"
            : "default store survives online update",
        async (t) => {
          const result = await installedScenario(t, proof, sdk, options);
          assert.deepEqual(result.profileRetained, {
            draft: "keep",
            selection: "sales",
          });
        },
      );
    }
  },
);
