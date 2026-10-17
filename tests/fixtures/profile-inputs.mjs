import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { requireSourceInputs, resolveSourceInputs } from "../../scripts/source-profile.mjs";

/** Profile callers provide an external, fixed source record file. */
export async function readProfileSourceRecords(file) {
  if (!file) throw new Error("EXPLICIT_SOURCE_INPUTS_REQUIRED");
  const records = requireSourceInputs(JSON.parse(await readFile(file, "utf8")));
  if (
    records.some(
      (record) =>
        !/^[a-f0-9]{40}$/.test(record.commit ?? "") ||
        typeof record.dependencies !== "string" ||
        !isAbsolute(record.dependencies),
    )
  )
    throw new Error("PROFILE_PINNED_SOURCE_INPUT_REQUIRED");
  for (const record of records)
    if (!(await stat(record.dependencies)).isDirectory())
      throw new Error("PROFILE_DEPENDENCY_DIRECTORY_REQUIRED");
  return records;
}

export async function readProfileSources(file) {
  return resolveSourceInputs(await readProfileSourceRecords(file), { requireEntries: true });
}
