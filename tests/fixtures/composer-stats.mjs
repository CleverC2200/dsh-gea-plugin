import { resolve } from "node:path";
import { readSupportedCore } from "../../scripts/supported-cores.mjs";

/** The two official axes render the same public dock with different statistic markers. */
export async function composerStatsContract() {
  const core = await readSupportedCore(resolve("../../official-latest-standard"));
  if (core.id !== undefined) throw Error("COMPOSER_OFFICIAL_CORE_REQUIRED");
  if (core.version === "0.2.0-rc.2")
    return { stats: "[data-composer-stats]", dock: "[data-composer-stats]" };
  if (core.version === "0.2.1-alpha.1")
    return { stats: '[data-composer-stat="activity"]', dock: "[data-composer-dock]" };
  throw Error("COMPOSER_CORE_CONTRACT_UNSUPPORTED: " + core.head);
}
