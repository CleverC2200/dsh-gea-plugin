import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const inputPath = process.argv[2];
const archivePath = process.env.GEA_RECOVERY_ACCEPTANCE_ARCHIVE;
const version = "0.0.348024";
const baseDigest = "31a35df75a10d070e9c8e0255f0aa4d7d958c4e369e445f7c4bc675e426f7e10";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const baseUrl = "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/plugin-release/packages/" +
  baseDigest + "/cleverc2200-gea-dsh-prototype-0.0.348.tgz";
const response = await fetch(baseUrl, { redirect: "error", signal: AbortSignal.timeout(120000) });
assert.equal(response.status, 200);
const bytes = Buffer.from(await response.arrayBuffer());
assert.equal(hash(bytes), baseDigest);
const stage = await mkdtemp(join(tmpdir(), "gea-recovery-seed-"));
const archive = join(stage, "base.tgz");
await writeFile(archive, bytes);
execFileSync("tar", ["-xzf", archive, "-C", stage]);
execFileSync(process.execPath, ["scripts/build.mjs", "--target", "host,client"], { stdio: "inherit" });
for (const name of ["host.js", "client.js"]) await cp(join("lib", name), join(stage, "package", "lib", name));
for (const name of ["package.json", "npm-shrinkwrap.json"]) {
  const path = join(stage, "package", name);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.version = version;
  if (manifest.packages?.[""]) manifest.packages[""].version = version;
  await writeFile(path, JSON.stringify(manifest, null, 2));
}
execFileSync("tar", ["-czf", archivePath, "-C", stage, "package"]);
const input = JSON.parse(await readFile(inputPath, "utf8"));
const gea = input.seed.packages.find(({ name }) => name === "@cleverc2200/gea-dsh-prototype");
Object.assign(gea, { version, sha256: hash(await readFile(archivePath)), url: pathToFileURL(archivePath).href });
input.geaSourceSha = process.env.GITHUB_SHA;
delete input.pluginSourceSha;
await writeFile(inputPath, JSON.stringify(input));
