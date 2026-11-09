import assert from "node:assert/strict";
import { lstat, mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

const files = ["developer-id-application.p12", "AuthKey.p8", ".env.macos"];
const required = [
  "DSH_DESKTOP_APP_ID",
  "DSH_DESKTOP_MACOS_SIGNING_IDENTITY",
  "DSH_DESKTOP_MACOS_TEAM_ID",
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
];

function directory(environment) {
  assert.ok(isAbsolute(environment.RUNNER_TEMP ?? ""), "MACOS_RUNNER_TEMP_REQUIRED");
  return join(environment.RUNNER_TEMP, "gea-macos-signing");
}

function decode(value) {
  assert.ok(typeof value === "string", "MACOS_SIGNING_SECRET_MISSING");
  const encoded = value.replace(/\s/g, "");
  const bytes = Buffer.from(encoded, "base64");
  assert.ok(
    bytes.length > 0 && bytes.length <= 128 * 1024 && bytes.toString("base64") === encoded,
    "MACOS_SIGNING_SECRET_INVALID_BASE64",
  );
  return bytes;
}

export async function prepareMacSigningCredentials(environment = process.env) {
  const path = directory(environment);
  const config = environment.GEA_MACOS_SIGNING_ENV;
  assert.ok(typeof config === "string" && !config.includes("\0"), "MACOS_SIGNING_SECRET_MISSING");
  let settings;
  try {
    settings = parseEnv(config);
  } catch {
    throw Error("MACOS_SIGNING_CONFIG_INVALID");
  }
  assert.ok(
    required.every((name) => settings[name]?.trim()),
    "MACOS_SIGNING_CONFIG_INCOMPLETE",
  );
  assert.equal(settings.CSC_LINK, files[0], "MACOS_SIGNING_CERTIFICATE_PATH_INVALID");
  assert.equal(settings.APPLE_API_KEY, files[1], "MACOS_SIGNING_API_KEY_PATH_INVALID");
  assert.equal(settings.DSH_DESKTOP_APP_ID, "com.cleverc2200.gea.desktop");
  const certificate = decode(environment.GEA_MACOS_SIGNING_P12_BASE64);
  const key = decode(environment.GEA_MACOS_NOTARY_KEY_BASE64);
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, files[0]), certificate, { mode: 0o600, flag: "wx" });
  await writeFile(join(path, files[1]), key, { mode: 0o600, flag: "wx" });
  await writeFile(join(path, files[2]), config, { mode: 0o600, flag: "wx" });
  return path;
}

export async function cleanupMacSigningCredentials(environment = process.env) {
  const path = directory(environment);
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), "MACOS_SIGNING_DIRECTORY_INVALID");
  for (const name of files) {
    try {
      await unlink(join(path, name));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await rmdir(path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 3, "MACOS_SIGNING_ACTION_REQUIRED");
    if (process.argv[2] === "prepare") await prepareMacSigningCredentials();
    else if (process.argv[2] === "cleanup") await cleanupMacSigningCredentials();
    else throw Error("MACOS_SIGNING_ACTION_INVALID");
  } catch {
    console.error("MACOS_SIGNING_CREDENTIALS_FAILED");
    process.exitCode = 1;
  }
}
