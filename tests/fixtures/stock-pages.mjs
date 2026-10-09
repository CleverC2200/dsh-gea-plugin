import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Register these installed current HTML packages through Workbench's public profile config. */
export function stockPages(roots) {
  return async ({ runtime }) => {
    const directory = resolve(runtime, "home/profiles/plugin-split-validation");
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, "cordis.patch.yml"),
      JSON.stringify([
        { id: "agent-workbench", config: { cwd: runtime + "/workspace", htmlRoots: roots } },
      ]),
    );
  };
}
