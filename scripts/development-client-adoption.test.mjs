import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { adoptClientSkillFix, retainedPayloadDigest } from "./development-client-adoption.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(join(os.tmpdir(), "client-skill-adoption-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, "home/profiles/desktop/node_modules/dsh-agent-manage");
  fs.mkdirSync(join(pkg, "lib/runtime"), { recursive: true });
  fs.writeFileSync(join(pkg, "package.json"), '{"files":["lib"]}');
  const module = join(pkg, "lib/runtime/skill-directories.js");
  fs.writeFileSync(module, "old");
  fs.writeFileSync(join(pkg, "lib/necessary-local.js"), "unpublished necessary behavior");
  const archive = join(root, "package.tgz");
  fs.writeFileSync(archive, "fixture package");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const file = join(root, "pending.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      clientRoot: root,
      archive,
      oldModuleSha256: hash("old"),
      newModuleSha256: hash("new"),
      archiveSha256: hash("fixture package"),
      retainedPayloadSha256: retainedPayloadDigest(pkg),
    }),
  );
  const calls = [];
  const state = {
    running: true,
    browser: "before",
    close() {},
    async restart() {
      calls.push("restart");
    },
  };
  state.rpc = async (method) => {
    calls.push(method);
    if (method === "session/list")
      return { items: [{ sessionId: "kept-session", running: state.running }] };
    if (method === "pluginManager/installBundle") {
      fs.writeFileSync(module, "new");
      return { application: "restart-required", packageResult: { exitCode: 0 } };
    }
    throw Error("unexpected write or retry");
  };
  return { root, pkg, file, module, state, calls, connect: async () => state };
}

test("normal adoption waits for the current session and never reinstalls before restart verification", async (t) => {
  const x = fixture(t);
  assert.equal((await adoptClientSkillFix(x.file, x.connect)).status, "waiting-in-use");
  assert.deepEqual(x.calls, ["session/list"]);
  x.state.running = false;
  assert.equal((await adoptClientSkillFix(x.file, x.connect)).status, "waiting-for-restart");
  assert.equal(x.calls.filter((method) => method === "pluginManager/installBundle").length, 1);
  x.state.browser = "after";
  const snapshots = join(
    x.root,
    "home/agent-plugins/data/selected-resources.json.skills/snapshots/shared-tree",
  );
  fs.mkdirSync(snapshots, { recursive: true });
  assert.equal((await adoptClientSkillFix(x.file, x.connect)).status, "completed");
  assert.equal(x.calls.filter((method) => method === "pluginManager/installBundle").length, 1);
  assert.equal(
    fs.readFileSync(join(x.pkg, "lib/necessary-local.js"), "utf8"),
    "unpublished necessary behavior",
  );
});

test("intervening local package edits stop adoption without overwriting them", async (t) => {
  const x = fixture(t);
  x.state.running = false;
  fs.writeFileSync(join(x.pkg, "lib/necessary-local.js"), "new user change");
  await assert.rejects(adoptClientSkillFix(x.file, x.connect), /CLIENT_OTHER_FILES_CHANGED/);
  assert.equal(fs.readFileSync(x.module, "utf8"), "old");
});
