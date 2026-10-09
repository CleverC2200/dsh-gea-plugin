import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Declare fixture package roots through the stopped temporary profile's public bundle patch. */
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
