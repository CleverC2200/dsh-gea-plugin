import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

const gea = (rows) => {
  const matches = rows.filter(
    (row) => row.id === "gea-proof" || row.name === "@cleverc2200/gea-dsh-prototype",
  );
  assert.equal(matches.length, 1, "DESKTOP_UPDATE_GEA_CONFIGURATION_REQUIRED");
  return matches[0];
};

export function compareDesktopUpdateData(before, after, installedCore) {
  assert.ok(
    before.sessions.length > 0 && before.sessions.some((row) => row.events.length > 0),
    "DESKTOP_UPDATE_EXISTING_HISTORY_REQUIRED",
  );
  const patch = structuredClone(after.patch);
  assert.ok(
    isDeepStrictEqual(gea(patch).config.pluginUpdates.core, installedCore),
    "DESKTOP_UPDATE_CORE_PROOF_MISMATCH",
  );
  gea(patch).config.pluginUpdates.core = gea(before.patch).config.pluginUpdates.core;
  assert.ok(isDeepStrictEqual(patch, before.patch), "DESKTOP_UPDATE_USER_CONFIGURATION_CHANGED");
  let events = 0;
  for (const original of before.sessions) {
    const current = after.sessions.find((row) => row.header.id === original.header.id);
    assert.ok(
      current &&
        isDeepStrictEqual(current.header, original.header) &&
        isDeepStrictEqual(current.events.slice(0, original.events.length), original.events),
      "DESKTOP_UPDATE_HISTORICAL_SESSION_CHANGED",
    );
    events += original.events.length;
  }
  return {
    status: "passed",
    fromVersion: before.version,
    toVersion: after.version,
    configuration: {
      status: "passed",
      allUserPatchValuesPreserved: true,
      onlyExpectedCoreProofRefreshed: true,
      coreProofMatchesVerifiedInstalledSeed: true,
    },
    history: {
      status: "passed",
      historicalSessions: before.sessions.length,
      historicalEvents: events,
      allOriginalHeadersAndEventsPreserved: true,
      readWithNewBundledCore: true,
    },
  };
}

async function capture(home) {
  assert.ok(process.versions.electron, "DESKTOP_UPDATE_USE_INSTALLED_APP_NODE");
  const appRoot =
    process.platform === "darwin"
      ? resolve(dirname(process.execPath), "../Resources/app.asar")
      : resolve(dirname(process.execPath), "resources/app.asar");
  const require = createRequire(join(appRoot, "dsh/package.json"));
  const { Context } = await import(pathToFileURL(require.resolve("@deepseek-ai/cordis")));
  const { default: Backend } = await import(
    pathToFileURL(require.resolve("@deepseek-ai/dsh-session-persistence-jsonl"))
  );
  const YAML = require("yaml");
  const app = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
  const seed = JSON.parse(await readFile(join(appRoot, "../company-seed/manifest.json"), "utf8"));
  for (const artifact of seed.core.artifacts)
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(appRoot, artifact.path)))
        .digest("hex"),
      artifact.sha256,
      "DESKTOP_UPDATE_INSTALLED_CORE_CHANGED",
    );
  const installedCore = { ...seed.core, root: appRoot, kind: "desktop" };
  const patch = YAML.parse(await readFile(join(home, "profiles/desktop/cordis.patch.yml"), "utf8"));
  const sessions = [];
  const ctx = new Context();
  try {
    await ctx.plugin(Backend, { root: join(home, "sessions"), compression: "zstd" });
    for (const item of await ctx.sessionPersistence.list()) {
      const handle = await ctx.sessionPersistence.open(item.header.id, "read");
      try {
        sessions.push({ header: handle.header, events: (await handle.read()).events });
      } finally {
        await handle.close();
      }
    }
  } finally {
    await ctx.fiber.dispose();
  }
  return { version: app.version, patch, sessions, installedCore };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        home: { type: "string" },
        capture: { type: "string" },
        before: { type: "string" },
        output: { type: "string" },
      },
    });
    assert.ok(
      values.home &&
        (values.capture ? !values.before && !values.output : values.before && values.output),
      "DESKTOP_UPDATE_DATA_ARGUMENTS_REQUIRED",
    );
    const current = await capture(resolve(values.home));
    let result;
    if (values.capture) {
      await writeFile(values.capture, JSON.stringify(current), { flag: "wx", mode: 0o600 });
      result = {
        status: "captured",
        version: current.version,
        sessions: current.sessions.length,
        events: current.sessions.reduce((count, row) => count + row.events.length, 0),
      };
    } else {
      result = compareDesktopUpdateData(
        JSON.parse(await readFile(values.before, "utf8")),
        current,
        current.installedCore,
      );
      await writeFile(values.output, JSON.stringify(result, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(
      error.message?.match(/^DESKTOP_UPDATE_[A-Z_]+/)?.[0] ?? "DESKTOP_UPDATE_DATA_FAILED",
    );
    process.exitCode = 1;
  }
}
