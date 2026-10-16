import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { installCompanyPackages } from "./company-bootstrap.mjs";

const [root, support, output, home, input] = process.argv.slice(2);
const config = JSON.parse(await readFile(input, "utf8"));
await mkdir(join(output, "archives"), { recursive: true });
const packages = [];
for (const row of config.packages) {
  const bytes = await readFile(row.path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== row.sha256) throw Error("GEA_INPUT_ARCHIVE_CHANGED");
  const file = basename(row.path);
  await copyFile(row.path, join(output, "archives", file));
  packages.push({ name: row.name, version: row.version, file, sha256 });
}
await writeFile(
  join(output, "manifest.json"),
  JSON.stringify(
    { schema: 1, packages, core: config.core, source: config.source },
    null,
    2,
  ) + "\n",
);
await installCompanyPackages({
  root,
  support,
  home,
  profile: join(home, "profiles/desktop"),
  packages: packages.map((row) => join(output, "archives", row.file)),
  store: join(output, "store"),
  offline: false,
});
await rm(join(output, "store/v11/projects"), { recursive: true, force: true });
await cp(
  join(home, "desktop-company-cache/metadata"),
  join(output, "metadata"),
  { recursive: true, errorOnExist: true, force: false },
);
console.log(
  "Company packages installed through official package operations; dependency store prepared.",
);
