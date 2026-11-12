import { mkdir, writeFile, link, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export async function withPluginStoreLock(root, operation, { purpose = "write" } = {}) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, token: randomUUID(), purpose };
  const path = join(root, "prepare.lock"),
    claim = join(root, "claim-" + owner.token);
  await writeFile(claim, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await link(claim, path);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let holder;
        try {
          holder = JSON.parse(await readFile(path, "utf8"));
        } catch (error) {
          if (error.code === "ENOENT") continue;
        }

        if (purpose !== "maintenance" && holder?.purpose === "maintenance" && attempt < 100) {
          await new Promise((r) => setTimeout(r, 20));
          continue;
        }
        throw Error("PLUGIN_UPDATE_BUSY");
      }
    }
  } finally {
    await rm(claim, { force: true });
  }
  try {
    return await operation(owner, path);
  } finally {
    const current = JSON.parse(await readFile(path, "utf8"));
    if (current.token === owner.token) await rm(path, { force: true });
  }
}
