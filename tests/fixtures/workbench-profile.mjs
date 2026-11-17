import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function fixtureWorkbench(roots) {
  return async ({ runtime }) => {
    const directory = join(runtime, "home/profiles/plugin-split-validation");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "cordis.patch.yml"),
      JSON.stringify([
        { id: "agent-workbench", config: { cwd: join(runtime, "workspace"), htmlRoots: roots } },
      ]),
    );
  };
}
