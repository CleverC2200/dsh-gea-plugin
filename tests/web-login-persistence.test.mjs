import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { createRequire } from "node:module";

const { outputFiles } = await build({
  stdin: {
    contents:
      "export {Business} from './src/host/business.ts'; export {attachWebLogin} from './src/host/web-login.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const compiled = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(
  createRequire(import.meta.url),
  compiled,
  compiled.exports,
);
const { Business, attachWebLogin } = compiled.exports;

test("ordinary plugin login without launcher flags survives restart and clears on logout and expiration", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gea-login-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.GEA_WEB_LOGIN_PERSIST;
  delete process.env.GEA_WEB_LOGIN_PERSIST;
  t.after(() => {
    if (previous === undefined) delete process.env.GEA_WEB_LOGIN_PERSIST;
    else process.env.GEA_WEB_LOGIN_PERSIST = previous;
  });
  const config = { geaBaseUrl: "https://gea.example.test/gea-boot", runtimeDir: dir };
  const saved = {
    schema: 1,
    environment: "production",
    base: config.geaBaseUrl,
    auth: { token: "fixture-secret", tenantId: "0", name: "Tester", id: "1", username: "tester" },
  };
  const first = new Business(config);
  const storage = await attachWebLogin(first);
  first.restorePersistentLogin(saved);
  await storage.flush();
  assert.equal((await stat(join(dir, "web-login.json"))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(first.status()).includes("fixture-secret"));
  await storage.dispose();
  first.dispose();
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
  await next.dispose();
  second.dispose();
  const third = new Business(config);
  const last = await attachWebLogin(third);
  assert.equal(third.status().authenticated, false);
  await last.dispose();
  third.dispose();
});

test("ordinary plugin login survives a controlled process stop and restart without launcher login variables", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "gea-login-process-"));
  const moduleDir = await mkdtemp(join(process.cwd(), ".scratch-login-process-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(moduleDir, { recursive: true, force: true });
  });
  const moduleFile = join(moduleDir, "login.cjs");
  await writeFile(moduleFile, outputFiles[0].text);
  const worker = `
    const {Business,attachWebLogin}=require(process.argv[1]);
    globalThis.fetch=async()=>{throw Error('UNEXPECTED_NETWORK');};
    (async()=>{
      const config={geaBaseUrl:'https://fixture.example.test/gea',runtimeDir:process.argv[2]};
      const business=new Business(config);
      const storage=await attachWebLogin(business);
      if(process.argv[3]==='login')business.restorePersistentLogin({schema:1,environment:'production',base:config.geaBaseUrl,auth:{token:'synthetic-process-fixture',tenantId:'0',name:'Fixture',id:'1',username:'fixture'}});
      if(process.argv[3]==='logout')business.logout({});
      await storage.dispose();
      process.stdout.write(JSON.stringify({authenticated:business.status().authenticated}));
      business.dispose();
    })().catch(error=>{process.stderr.write(error.message);process.exitCode=1;});
  `;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GEA_")),
  );
  const run = (action) =>
    JSON.parse(
      execFileSync(process.execPath, ["-e", worker, moduleFile, dir, action], {
        env,
        encoding: "utf8",
      }),
    );
  assert.deepEqual(run("login"), { authenticated: true });
  assert.deepEqual(run("restart"), { authenticated: true });
  assert.deepEqual(run("logout"), { authenticated: false });
  assert.deepEqual(run("restart"), { authenticated: false });
});
