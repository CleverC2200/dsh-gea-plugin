import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { createRequire } from "node:module";

const { outputFiles } = await build({
  stdin: {
    contents: "export {Business} from './src/host/business.ts'; export {attachWebLogin} from './src/host/web-login.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const compiled = {exports:{}};
new Function("require", "module", "exports", outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { Business, attachWebLogin } = compiled.exports;

test("local web login survives restart and clears on logout and expiration", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gea-login-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.GEA_WEB_LOGIN_PERSIST;
  process.env.GEA_WEB_LOGIN_PERSIST = "1";
  t.after(() => { if (previous === undefined) delete process.env.GEA_WEB_LOGIN_PERSIST; else process.env.GEA_WEB_LOGIN_PERSIST = previous; });
  const config = { geaBaseUrl: "https://gea.example.test/gea-boot", runtimeDir: dir };
  const saved = { schema: 1, environment: "production", base: config.geaBaseUrl, auth: { token: "fixture-secret", tenantId: "0", name: "Tester", id: "1", username: "tester" } };
  const first = new Business(config);
  const storage = await attachWebLogin(first);
  first.restorePersistentLogin(saved);
  await storage.flush();
  assert.equal((await stat(join(dir, "web-login.json"))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(first.status()).includes("fixture-secret"));
  await storage.dispose(); first.dispose();
  const second = new Business(config);
  const next = await attachWebLogin(second);
  assert.equal(second.status().authenticated, true);
  second.logout({});
  await next.flush();
  assert.equal(JSON.parse(await readFile(join(dir, "web-login.json"), "utf8")), null);
  second.restorePersistentLogin(saved);
  await next.flush();
  second.expireModelLogin();
  await next.flush();
  await next.dispose(); second.dispose();
  const third = new Business(config);
  const last = await attachWebLogin(third);
  assert.equal(third.status().authenticated, false);
  await last.dispose(); third.dispose();
});
