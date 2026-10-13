import { readFileSync } from "node:fs";

/** Select immutable official inputs for one CI lane. Compatibility never changes required gates. */
export function ciCores(lane) {
  if (!["required", "compatibility"].includes(lane)) throw Error("CI_CORE_POLICY_LANE_REQUIRED");
  const policy = JSON.parse(
    readFileSync(new URL("./ci-core-policy.json", import.meta.url), "utf8"),
  );
  const registered = JSON.parse(
    readFileSync(new URL("./supported-cores.json", import.meta.url), "utf8"),
  );
  if (policy.schemaVersion !== 1 || !Array.isArray(registered))
    throw Error("CI_CORE_POLICY_INVALID");
  const selected = {};
  const heads = new Set();
  for (const kind of ["required", "compatibility"]) {
    const entries = policy[kind];
    if (
      !Array.isArray(entries) ||
      entries.length === 0 ||
      (kind === "required" && entries.length !== 1)
    )
      throw Error("CI_CORE_POLICY_INVALID");
    selected[kind] = entries.map((entry) => {
      if (!entry || !/^[a-f0-9]{40}$/.test(entry.head) || heads.has(entry.head))
        throw Error("CI_CORE_POLICY_INVALID");
      heads.add(entry.head);
      const cores = registered.filter((core) => core.head === entry.head);
      if (cores.length !== 1 || cores[0].id || cores[0].version !== entry.version)
        throw Error("CI_CORE_POLICY_OFFICIAL_INPUT_REQUIRED");
      return cores[0];
    });
  }
  return selected[lane];
}
