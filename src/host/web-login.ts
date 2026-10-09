/** GEA Host persists its login inside the current profile without exposing credentials to the browser. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Business } from "./business.ts";

export async function attachWebLogin(business: Business): Promise<{ flush(): Promise<void>; dispose(): Promise<void> }> {
  if (process.env.GEA_WEB_LOGIN_PERSIST === "0" || process.env.GEA_DESKTOP_CONTROL_URL)
    return { flush: async () => {}, dispose: async () => {} };
  const file = resolve(business.config.runtimeDir, "web-login.json");
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    if (saved !== null) business.restorePersistentLogin(saved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("WEB_LOGIN_STORAGE_UNAVAILABLE");
  }
  let pending = Promise.resolve();
  const stop = business.watchIdentity(() => {
    const snapshot = business.persistentLoginSnapshot();
    pending = pending.catch(() => {}).then(async () => {
      await mkdir(resolve(business.config.runtimeDir), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(temporary, file);
    });
    void pending.catch(() => {});
  });
  return { flush: () => pending, dispose: async () => { stop(); await pending; } };
}
