import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { refreshCompanyCore } from "../desktop/company-bootstrap.mjs";

const optional = async (path) => {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

export async function repairPluginStore({
  profile,
  YAML,
  withFileLock,
  writeFileAtomic,
  apply = false,
}) {
  if (!isAbsolute(profile)) throw Error("PROFILE_PATH_REQUIRED");
  return withFileLock(
    join(profile, "package.json"),
    async () => {
      if (await optional(join(profile, ".plugin-manager/run.json")))
        throw Error("PROFILE_WRITER_UNCONFIRMED");
      const latest = await optional(
        join(profile, "gea/plugin-updates/latest.json"),
      );
      if (latest) {
        const pointer = JSON.parse(latest.toString("utf8"));
        if (
          typeof pointer?.id !== "string" ||
          !/^[-a-f0-9]{36}$/.test(pointer.id)
        )
          throw Error("UPDATE_JOURNAL_INVALID");
        const operation = JSON.parse(
          await readFile(
            join(
              profile,
              "gea/plugin-updates/operations",
              pointer.id,
              "receipt.json",
            ),
            "utf8",
          ),
        );
        if (
          operation.id !== pointer.id ||
          !["completed", "restored", "failed"].includes(operation.stage)
        )
          throw Error("UPDATE_RECOVERY_REQUIRED");
      }
      const metadata = await optional(
        join(profile, "node_modules/.modules.yaml"),
      );
      if (!metadata) throw Error("PROFILE_STORE_UNAVAILABLE");
      const store = YAML.parse(metadata.toString("utf8"))?.storeDir;
      if (
        typeof store !== "string" ||
        !isAbsolute(store) ||
        /[\r\n\u0000]/.test(store) ||
        store.includes("${")
      )
        throw Error("PROFILE_STORE_INVALID");
      await access(store, constants.R_OK | constants.W_OK | constants.X_OK);
      const config = join(profile, "pnpm-workspace.yaml"),
        before = await optional(config);
      const document = YAML.parseDocument(before?.toString("utf8") ?? "{}");
      if (
        document.errors.length ||
        !document.toJS() ||
        typeof document.toJS() !== "object" ||
        Array.isArray(document.toJS())
      )
        throw Error("PROFILE_WORKSPACE_INVALID");
      if (document.get("storeDir") === store)
        return { status: "already-configured", changed: false };
      if (!apply) return { status: "ready", changed: false };
      const id = createHash("sha256")
        .update(before ?? "")
        .digest("hex");
      const directory = join(profile, "gea/plugin-updates/store-repairs", id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const backup = join(directory, "workspace-before.yaml");
      const existing = await optional(backup);
      if (existing && !existing.equals(before ?? Buffer.alloc(0)))
        throw Error("STORE_REPAIR_BACKUP_CHANGED");
      if (!existing)
        await writeFileAtomic(backup, before ?? Buffer.alloc(0), {
          mode: 0o600,
          dirMode: 0o700,
        });
      await writeFileAtomic(
        join(directory, "receipt.json"),
        JSON.stringify({
          schema: 1,
          status: "prepared",
          originalConfigExisted: before !== null,
          originalSha256: id,
        }) + "\n",
        { mode: 0o600, dirMode: 0o700 },
      );
      document.set("storeDir", store);
      await writeFileAtomic(config, document.toString(), {
        mode: 0o600,
        dirMode: 0o700,
      });
      await writeFileAtomic(
        join(directory, "receipt.json"),
        JSON.stringify({
          schema: 1,
          status: "configured",
          originalConfigExisted: before !== null,
          originalSha256: id,
        }) + "\n",
        { mode: 0o600, dirMode: 0o700 },
      );
      return { status: "configured", changed: true, backup };
    },
    { waitMs: 10000 },
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const { values } = parseArgs({
    options: {
      profile: { type: "string" },
      anchor: { type: "string" },
      apply: { type: "boolean", default: false },
      "configure-source": { type: "boolean", default: false },
    },
  });
  const resources =
    process.platform === "darwin"
      ? resolve(dirname(process.execPath), "../Resources")
      : join(dirname(process.execPath), "resources");
  const anchor = values.anchor ?? join(resources, "app.asar/dsh/package.json");
  const require = createRequire(anchor);
  const { withFileLock, writeFileAtomic } = await import(
    pathToFileURL(require.resolve("@deepseek-ai/dsh-atomic-write"))
  );
  const profile =
    values.profile ??
    join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "profiles/desktop");
  const root = dirname(dirname(anchor));
  const result = await repairPluginStore({
    profile,
    YAML: require("yaml"),
    withFileLock,
    writeFileAtomic,
    apply: values.apply,
  });
  const source = values["configure-source"]
    ? await refreshCompanyCore({
        root,
        seed: join(dirname(root), "company-seed"),
        home: dirname(dirname(profile)),
        apply: values.apply,
      })
    : undefined;
  console.log(JSON.stringify({ store: result, ...(source ? { source } : {}) }));
}
