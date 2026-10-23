import { execFileSync } from "node:child_process";
import { readDesktopInput, desktopCoreHead } from "./input.mjs";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const { values } = parseArgs({
  options: {
    "bundle-url": { type: "string" },
    "bundle-sha256": { type: "string" },
    "build-receipt": { type: "string" },
    input: { type: "string" },
    output: { type: "string" },
    "validate-only": { type: "boolean" },
  },
});
const sha = values["bundle-sha256"],
  url = values["bundle-url"];
if (
  typeof sha !== "string" ||
  !/^[a-f0-9]{64}$/.test(sha) ||
  sha === "0".repeat(64) ||
  typeof url !== "string" ||
  !url.startsWith(
    `https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/verification/${sha}/`,
  ) ||
  !/\/[A-Za-z0-9_-]+\.tgz$/.test(url)
)
  throw Error("DESKTOP_NATIVE_BUNDLE_INVALID");
const parsed = new URL(url);
if (parsed.search || parsed.hash || /[%\\]|\.\./.test(parsed.pathname))
  throw Error("DESKTOP_NATIVE_BUNDLE_INVALID");
if (values["validate-only"]) {
  console.log(JSON.stringify({ status: "input-validated", executed: false, bundleSha256: sha }));
} else {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw Error("DESKTOP_NATIVE_WINDOWS_REQUIRED");
  const buildPath = values["build-receipt"],
    inputPath = values.input,
    output = values.output;
  if (
    ![buildPath, inputPath, output].every(
      (value) => typeof value === "string" && isAbsolute(value),
    ) ||
    existsSync(output)
  )
    throw Error("DESKTOP_NATIVE_OWN_OUTPUT_REQUIRED");
  const buildBytes = await readFile(buildPath),
    build = JSON.parse(buildBytes);
  if (
    build.status !== "packaged-and-runtime-smoke-passed" ||
    build.geaSha !== process.env.GITHUB_SHA ||
    build.coreSha !== desktopCoreHead
  )
    throw Error("DESKTOP_NATIVE_BUILD_REQUIRED");
  const fixed = await readDesktopInput(inputPath, process.env.GITHUB_SHA);
  if (digest(JSON.stringify(fixed)) !== build.inputSha256)
    throw Error("DESKTOP_NATIVE_INPUT_CHANGED");
  const work = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "gea-native-bundle-"));
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120000) });
  if (response.status !== 200 || !response.body)
    throw Error("DESKTOP_NATIVE_BUNDLE_DOWNLOAD_FAILED");
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024 * 1024) throw Error("DESKTOP_NATIVE_BUNDLE_SIZE_LIMIT");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  if (digest(bytes) !== sha) throw Error("DESKTOP_NATIVE_BUNDLE_HASH_MISMATCH");
  const archive = join(work, "bundle.tgz"),
    unpacked = join(work, "unpacked");
  await writeFile(archive, bytes, { flag: "wx" });
  const tar = (args) =>
    execFileSync("tar", args, { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  const entries = tar(["-tzf", archive]).trim().split(/\r?\n/);
  if (
    entries.length > 1024 ||
    new Set(entries).size !== entries.length ||
    !entries.includes("package/windows-run.mjs") ||
    entries.some(
      (file) =>
        !file.startsWith("package/") ||
        /[\\:\r\t]/.test(file) ||
        file.includes("//") ||
        file.split("/").some((part) => part === "." || part === ".."),
    )
  )
    throw Error("DESKTOP_NATIVE_BUNDLE_ARCHIVE_INVALID");
  const listing = tar(["-tvzf", archive]).trim().split(/\r?\n/);
  if (listing.length !== entries.length || listing.some((line) => !["-", "d"].includes(line[0])))
    throw Error("DESKTOP_NATIVE_BUNDLE_LINK_FORBIDDEN");
  await mkdir(unpacked);
  tar(["-xzf", archive, "-C", unpacked]);
  const env = { ...process.env };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
  ])
    delete env[key];
  execFileSync(
    process.execPath,
    [
      join(unpacked, "package/windows-run.mjs"),
      "--build-receipt",
      resolve(buildPath),
      "--input",
      resolve(inputPath),
      "--output",
      resolve(output),
    ],
    { env, stdio: "inherit", timeout: 30 * 60000 },
  );
  const receipt = JSON.parse(await readFile(join(output, "receipt.json"), "utf8"));
  if (
    receipt.status !== "passed" ||
    receipt.actualNativeUpdateAcceptance !== true ||
    receipt.buildReceiptSha256 !== digest(buildBytes) ||
    receipt.inputSha256 !== build.inputSha256
  )
    throw Error("DESKTOP_NATIVE_ACCEPTANCE_NOT_PASSED");
  await writeFile(
    join(output, "bundle-binding.json"),
    JSON.stringify(
      {
        bundleUrl: url,
        bundleSha256: sha,
        buildReceiptSha256: digest(buildBytes),
        inputSha256: build.inputSha256,
        status: "passed",
        actualNativeUpdateAcceptance: true,
      },
      null,
      2,
    ) + "\n",
  );
}
