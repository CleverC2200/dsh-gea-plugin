import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyRuntimeModules } from "./runtime-environment.mjs";

function fixture(t) {
  const core = mkdtempSync(join(tmpdir(), "runtime-readiness-"));
  t.after(() => rmSync(core, { recursive: true, force: true }));
  const put = (name, content) => {
    const path = join(core, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  };
  put("package.json", JSON.stringify({ type: "module" }));
  put(
    "packages/boot/app-boot/lib/index.js",
    "import 'js-yaml'; export const initProfile = () => {};\n",
  );
  put(
    "packages/boot/plugin-manager/lib/types/operations.js",
    "export const runProfilePnpm = () => {};\n",
  );
  put("apps/cli/lib/profile-boot.js", "export const runProfile = () => {};\n");
  put(
    "node_modules/js-yaml/package.json",
    JSON.stringify({ name: "js-yaml", type: "module", exports: "./index.js" }),
  );
  put("node_modules/js-yaml/index.js", "export default {};\n");
  return { core, put };
}

test("a previously prepared Core is refused immediately after its runtime dependency is cleaned", (t) => {
  const { core } = fixture(t);
  assert.equal(verifyRuntimeModules({ core }).status, "ready");
  rmSync(join(core, "node_modules/js-yaml"), { recursive: true });
  assert.throws(
    () => verifyRuntimeModules({ core }),
    /RUNTIME_CORE_NOT_READY:.*ERR_MODULE_NOT_FOUND js-yaml.*prepare-official-sdk/,
  );
});

test("existing Boot outputs cannot conceal a missing CLI runtime entry", (t) => {
  const { core } = fixture(t);
  rmSync(join(core, "apps/cli/lib/profile-boot.js"));
  assert.throws(
    () => verifyRuntimeModules({ core }),
    /RUNTIME_CORE_NOT_READY: apps\/cli\/lib\/profile-boot.js/,
  );
});

test("source validation requires its declared companions while ordinary three-package reception does not", (t) => {
  const { core, put } = fixture(t);
  assert.equal(verifyRuntimeModules({ core }).companions, false);
  assert.throws(
    () => verifyRuntimeModules({ core, consumer: core }),
    /RUNTIME_COMPANIONS_NOT_READY:.*quality:upstreams/,
  );
  for (const name of ["@changfenhuang/dsh-genui", "dsh-better-sidebar"]) {
    put(
      `node_modules/${name}/package.json`,
      JSON.stringify({
        name,
        version: "0.11.3",
        type: "module",
        exports: { ".": "./index.js", "./package.json": "./package.json" },
      }),
    );
    put(`node_modules/${name}/index.js`, "export default {};\n");
  }
  assert.equal(verifyRuntimeModules({ core, consumer: core }).companions, true);
});

test("external module failures cannot expose credentials in public readiness errors", (t) => {
  const { core, put } = fixture(t);
  put(
    "packages/boot/app-boot/lib/index.js",
    "throw Error('https://private.example/?token=SECRET_TOKEN');\n",
  );
  assert.throws(
    () => verifyRuntimeModules({ core }),
    (error) => {
      assert.match(error.message, /RUNTIME_CORE_NOT_READY/);
      assert.doesNotMatch(error.message, /private.example|SECRET_TOKEN/);
      return true;
    },
  );
});
