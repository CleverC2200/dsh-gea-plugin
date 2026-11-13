import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const OPTIONAL_PLUGINS = {
  "dsh-raw-html-v2": { name: "dsh-raw-html-v2" },
  "dsh-worktable": { name: "dsh-worktable" },
  "dsh-personal-memory": { name: "dsh-personal-memory" },
};
const code = (value) => typeof value === "string" && /^[A-Z][A-Z_0-9]+$/.test(value);
const errorCode = (error) =>
  code(error?.message) ? error.message : code(error?.code) ? error.code : "UPDATE_FAILED";

const versionParts = (value) => {
  const [core, pre] = String(value ?? "").split("-", 2);
  return { core: core.split(".").map(Number), pre: pre === undefined ? null : pre.split(".") };
};
export const isNewer = (candidate, current) => {
  if (current === undefined || current === null) return true;
  const next = versionParts(candidate),
    now = versionParts(current);
  for (let index = 0; index < 3; index += 1) {
    const a = next.core[index] ?? 0,
      b = now.core[index] ?? 0;
    if (a !== b) return a > b;
  }
  if (!next.pre && !now.pre) return false;
  if (!next.pre) return true;
  if (!now.pre) return false;
  for (let index = 0; index < Math.max(next.pre.length, now.pre.length); index += 1) {
    const a = next.pre[index],
      b = now.pre[index];
    if (a === undefined) return false;
    if (b === undefined) return true;
    const aNumeric = /^\d+$/.test(a),
      bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      if (Number(a) !== Number(b)) return Number(a) > Number(b);
    } else if (aNumeric !== bNumeric) return !aNumeric;
    else if (a !== b) return a > b;
  }
  return false;
};
const CHANNEL_ATTEMPT_TIMEOUT_MS = 30000;

const channelCandidates = (value) =>
  Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.length > 0)
    : typeof value === "string" && value.length > 0
      ? [value]
      : [];
export async function createUpdates({
  data,
  store,
  desktopVersion,
  releases,
  install,
  restart,
  restartRuntime,
  sources,
  token,
  checkDesktop,
}) {
  const path = join(data, "plugins/update-state.json");
  const optionalPath = join(data, "plugins/optional-state.json");
  await mkdir(join(data, "plugins"), { recursive: true });
  let state = {
    settings: { automatic: true, intervalHours: 2, channel: "stable" },
    history: {},
    updateHistory: [],
    phase: "idle",
    releases: [],
    channelSource: null,
  };

  try {
    state = { ...state, ...JSON.parse(await readFile(path, "utf8")), releases: [] };
  } catch (error) {
    if (error.code !== "ENOENT") throw Error("UPDATE_STATE_INVALID");
  }
  if (["downloading", "installing"].includes(state.phase))
    state = { ...state, phase: "failed", error: "PREPARATION_INTERRUPTED" };
  let checking,
    checkAbort,
    preparing,
    abort,
    restartTimer,
    restartTask,
    autoRestart = false,
    started = false,
    closed = false,
    writes = Promise.resolve();
  const save = () => {
    const bytes = JSON.stringify(state, null, 2);
    const next = writes
      .catch(() => {})
      .then(async () => {
        const temp = path + "." + randomUUID();
        await writeFile(temp, bytes, { mode: 0o600 });
        await rename(temp, path);
      });
    writes = next;
    return next;
  };
  const versions = async () => {
    const selected = await store.selected();
    const require = createRequire(join(selected.path, "package.json"));
    const manifest = JSON.parse(await readFile(join(selected.path, "package.json"), "utf8"));
    const result = {};
    const coreRequire = selected.core
      ? createRequire(join(selected.core.path, "package.json"))
      : null;
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const owner =
        coreRequire && Object.hasOwn(selected.core.metadata.packages, name) ? coreRequire : require;
      result[name] = JSON.parse(
        await readFile(owner.resolve(name + "/package.json"), "utf8"),
      ).version;
    }
    return result;
  };
  let optionalState = {};
  try {
    optionalState = JSON.parse(await readFile(optionalPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw Error("OPTIONAL_STATE_INVALID");
  }
  const saveOptional = () =>
    writeFile(optionalPath, JSON.stringify(optionalState, null, 2), { mode: 0o600 });
  const optionalStatus = async () => {
    const current = await versions();
    return {
      plugins: Object.entries(OPTIONAL_PLUGINS).map(([key, meta]) => ({
        key,
        name: meta.name,
        installed: Boolean(current[key]),
        version: current[key] ?? null,
        enabled: current[key] !== undefined && (optionalState[key] ?? true),
      })),
    };
  };
  const optionalToggle = async (value) => {
    if (
      !value ||
      typeof value.name !== "string" ||
      typeof value.enabled !== "boolean" ||
      !OPTIONAL_PLUGINS[value.name]
    )
      throw Error("INVALID_OPTIONAL_PLUGIN");
    if (preparing || checking || state.phase === "restarting") throw Error("UPDATE_BUSY");
    const current = await versions();
    if (!current[value.name]) throw Error("OPTIONAL_PLUGIN_NOT_INSTALLED");
    optionalState[value.name] = value.enabled;
    await saveOptional();
    if (!restartRuntime) throw Error("OPTIONAL_RESTART_UNAVAILABLE");
    await restartRuntime();
    return optionalStatus();
  };
  const status = async () => {
    return {
      ...state,
      phase: state.phase === "pending" && preparing ? "installing" : state.phase,
      current: await versions(),
      optional: await optionalStatus(),
      checking: Boolean(checking),
      capabilities: {
        batchPrepare: true,
        automaticUpdates: true,
        prepareAndRestart: true,
        optionalPluginToggle: true,
      },
    };
  };

  const fetchChannel = async (channel, host) => {
    const candidates = channelCandidates(sources?.[channel]);
    if (!candidates.length) throw Error("INVALID_RELEASE_URL");
    let failure;
    for (const source of candidates) {
      try {
        const result = await releases.fetchCompanyChannel(source, channel, host, {
          token,
          signal: AbortSignal.any([
            checkAbort.signal,
            AbortSignal.timeout(CHANNEL_ATTEMPT_TIMEOUT_MS),
          ]),
        });
        return { result, source };
      } catch (error) {
        failure = error;

        if (checkAbort.signal.aborted) break;
      }
    }
    throw failure;
  };
  const check = () => {
    if (closed) return Promise.resolve({ error: "DESKTOP_CLOSING" });
    if (checking) return checking;
    if (preparing || state.phase === "restarting") return Promise.resolve({ error: "UPDATE_BUSY" });
    checkAbort = new AbortController();
    checking = (async () => {
      const channel = state.settings.channel;
      const desktopCheck = Promise.resolve()
        .then(() => checkDesktop?.({ channel }))
        .catch(() => {});
      try {
        const current = await versions();
        const { result, source } = await fetchChannel(channel, {
          dsh: current["@deepseek-ai/dsh"],
          workbench: current["@cleverc2200/dsh-agent-workbench"],
          desktop: desktopVersion,
        });
        state.history = releases.verifyReleaseHistory(result, state.history);
        state.releases = result.releases;
        state.channelSource = source;
        state.lastCheck = new Date().toISOString();
        state.checkError = null;

        const key = (entry) => entry.package + "@" + entry.version;
        const attempted = (state.targets ?? []).map(key).sort().join(",");
        const offered = state.releases
          .filter((release) => isNewer(release.version, current[release.package]))
          .map(key)
          .sort()
          .join(",");
        if (state.phase === "failed" && attempted !== offered) {
          state.phase = "idle";
          state.error = null;
          delete state.targets;
          delete state.target;
          delete state.progress;
          delete state.timings;
          delete state.pending;
        }
      } catch (error) {
        state.releases = [];
        state.channelSource = null;
        state.lastCheck = new Date().toISOString();
        state.checkError = errorCode(error);
      }
      await desktopCheck;
      await save();
      return status();
    })().finally(() => {
      checking = undefined;
    });
    return checking;
  };

  const finishHistory = (success) => {
    const items = Array.isArray(state.pendingHistory) ? state.pendingHistory : [];
    if (success && items.length) {
      const updated = new Set(items.map((item) => item.package));
      const previous = (Array.isArray(state.updateHistory) ? state.updateHistory : [])
        .map((entry) => ({
          ...entry,
          items: (Array.isArray(entry.items) ? entry.items : []).filter(
            (item) => !updated.has(item.package),
          ),
        }))
        .filter((entry) => entry.items.length);
      state.updateHistory = [{ appliedAt: new Date().toISOString(), items }, ...previous].slice(
        0,
        20,
      );
    }
    delete state.pendingHistory;
  };
  const settings = async (value) => {
    if (checking || preparing || state.phase === "restarting") throw Error("UPDATE_BUSY");
    if (!value || typeof value !== "object") throw Error("INVALID_UPDATE_SETTINGS");
    if (
      typeof value.automatic !== "boolean" ||
      !Number.isInteger(value.intervalHours) ||
      value.intervalHours < 1 ||
      value.intervalHours > 168 ||
      !["stable", "test"].includes(value.channel)
    )
      throw Error("INVALID_UPDATE_SETTINGS");
    if (value.channel !== state.settings.channel) state.releases = [];
    state.settings = {
      automatic: value.automatic,
      intervalHours: value.intervalHours,
      channel: value.channel,
    };
    await save();
    return status();
  };
  const prepare = async (value) => {
    if (closed || preparing || checking || ["pending", "restarting"].includes(state.phase))
      return { error: "UPDATE_BUSY" };
    if (
      !value ||
      typeof value !== "object" ||
      (value.all !== true && typeof value.package !== "string")
    )
      throw Error("INVALID_UPDATE_REQUEST");
    if (!state.releases.length || state.checkError) throw Error("CHECK_RELEASE_FIRST");
    const current = await versions();
    const selected =
      value.all === true
        ? state.releases
        : state.releases.filter((entry) => entry.package === value.package);
    if (!selected.length) throw Error("CHECK_RELEASE_FIRST");
    const targets = selected.filter((entry) => isNewer(entry.version, current[entry.package]));
    if (!targets.length) return { error: "ALREADY_CURRENT" };
    const batch = { schema: 1, channel: state.settings.channel, releases: targets };
    const host = {
      dsh: current["@deepseek-ai/dsh"],
      workbench: current["@cleverc2200/dsh-agent-workbench"],
      desktop: desktopVersion,
    };
    releases.validateReleaseChannel(batch, state.settings.channel, host);
    const planned = {
      ...current,
      ...Object.fromEntries(targets.map((entry) => [entry.package, entry.version])),
    };
    releases.validateReleaseChannel(batch, state.settings.channel, {
      ...host,
      dsh: planned["@deepseek-ai/dsh"],
      workbench: planned["@cleverc2200/dsh-agent-workbench"],
    });
    if (closed || preparing || checking || ["pending", "restarting"].includes(state.phase))
      return { error: "UPDATE_BUSY" };
    autoRestart = value.restart === true;

    state.phase = "downloading";
    state.targets = targets.map(({ package: name, version }) => ({ package: name, version }));
    state.pendingHistory = targets.map(({ package: name, version }) => ({
      package: name,
      fromVersion: current[name] ?? null,
      toVersion: version,
    }));
    state.target = state.targets[0];
    state.progress = { completed: 0, total: targets.length, package: targets[0].package };
    state.error = null;
    abort = new AbortController();
    const id = "channel-" + randomUUID();
    state.pending = id;
    preparing = (async () => {
      const artifacts = targets.map((_, index) => join(data, "plugins", id + "-" + index + ".tgz"));
      const started = performance.now();
      state.timings = {};
      try {
        await save();
        for (const [index, release] of targets.entries()) {
          state.progress = { completed: index, total: targets.length, package: release.package };
          await save();
          const bytes = await releases.fetchReleasePackage(release, {
            token,
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]),
          });
          await writeFile(artifacts[index], bytes, { mode: 0o600 });
          abort.signal.throwIfAborted();
        }
        state.progress = { completed: targets.length, total: targets.length, package: "" };
        state.timings.downloadMs = Math.round(performance.now() - started);
        state.phase = "installing";
        await save();
        const preparingAt = performance.now();
        const receipt = await store.prepare({
          id,
          signal: abort.signal,
          install: async (directory, owner) => {
            await install(
              directory,
              artifacts.length === 1 ? artifacts[0] : artifacts,
              abort.signal,
              owner.registerProcess,
            );
            const require = createRequire(join(directory, "package.json"));
            for (const release of targets) {
              const actual = JSON.parse(
                await readFile(require.resolve(release.package + "/package.json"), "utf8"),
              );
              if (actual.version !== release.version)
                throw Error("RELEASE_PACKAGE_VERSION_MISMATCH");
            }
          },
        });
        state.timings.prepareMs = Math.round(performance.now() - preparingAt);
        if (targets.some((release) => receipt.versions[release.package] !== release.version))
          throw Error("RELEASE_PACKAGE_VERSION_MISMATCH");
        state.phase = abort.signal.aborted ? "cancelled" : "pending";
      } catch (error) {
        state.phase = abort.signal.aborted ? "cancelled" : "failed";
        state.error = errorCode(error);
      } finally {
        if (state.phase !== "pending") finishHistory(false);
        await Promise.all(artifacts.map((artifact) => rm(artifact, { force: true })));
        await save();
      }
    })().finally(async () => {
      preparing = undefined;
      abort = undefined;
      if (autoRestart && state.phase === "pending" && !closed) {
        autoRestart = false;
        await restartPrepared();
      }
    });
    void preparing.catch(() => {});
    return { accepted: true };
  };
  const restartPrepared = async () => {
    if (state.phase !== "pending" || preparing) throw Error("NO_PREPARED_UPDATE");
    state.phase = "restarting";
    await save();
    restartTimer = setTimeout(() => {
      if (closed) return;
      restartTask = restart(state.pending)
        .then(async () => {
          const selected = await store.status();
          state.phase =
            selected.active === state.pending &&
            selected.verified === state.pending &&
            !selected.booting
              ? "succeeded"
              : "failed";
          state.error = state.phase === "failed" ? "UPDATE_ROLLED_BACK" : null;
          finishHistory(state.phase === "succeeded");
          await save();
        })
        .catch(async (error) => {
          state.phase = "failed";
          state.error = errorCode(error);
          finishHistory(false);
          await save();
        });
    }, 100);
    return { ok: true };
  };
  return {
    status,
    check,
    settings,
    prepare,
    optional: optionalStatus,
    optionalToggle,
    cancel: async () => {
      autoRestart = false;
      abort?.abort();
      if (state.phase === "pending") {
        state.phase = "cancelled";
        finishHistory(false);
        await save();
      }
      return { ok: true };
    },
    restart: restartPrepared,
    start: async () => {
      if (started) return;
      started = true;
      const generation = (await store.status()).dataSchema ?? 1;
      if ((state.dataSchema ?? 1) !== generation) {
        state = {
          settings: state.settings,
          history: state.history,
          updateHistory: Array.isArray(state.updateHistory) ? state.updateHistory : [],
          phase: "idle",
          releases: [],
          channelSource: null,
          dataSchema: generation,
        };
        await save();
      }
      if (state.phase === "restarting") {
        const selection = await store.status();
        state.phase =
          selection.active === state.pending && !selection.booting ? "succeeded" : "failed";
        state.error = state.phase === "failed" ? "UPDATE_ROLLED_BACK" : null;
        finishHistory(state.phase === "succeeded");
        await save();
      }
      void check().catch(() => {});
    },
    close: async () => {
      closed = true;
      clearTimeout(restartTimer);
      abort?.abort();
      checkAbort?.abort();
      await preparing;
      await checking;
      await restartTask;
      await writes;
    },
  };
}
