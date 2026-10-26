import { profile } from "../profile.mjs";
import { fixtureEnvironment } from "./business-session.mjs";
import { readSourceCombination } from "../../scripts/source-combination-integrity.mjs";
import { installProfileReadinessProbe } from "./profile-readiness-probe.mjs";

/** Explicit caller-owned fake keys must reach the public parent preflight as well as its child. */
export async function modelProfile(t, options = {}) {
  const keys = Object.fromEntries(
    Object.entries(options.env ?? {}).filter(([name]) =>
      [
        "GEA_TEST_MODEL_KEY",
        "GEA_BUDGET_TEST_KEY",
        "GEA_QA_MODEL_KEY",
        "V2_TEST_MODEL_KEY",
        "GEA_V16_MODEL_KEY",
        "GEA_GENUI_TEST_KEY",
        "GEA_PICKER_TEST_KEY",
        "GEA_THEME_TEST_KEY",
        "GEA_SPLIT_TEST_KEY",
      ].includes(name),
    ),
  );
  fixtureEnvironment(t, keys);
  return profile(t, {
    ...options,
    async afterPrepare(input) {
      await options.afterPrepare?.(input);
      if (!input.combination) return;
      const composition = await readSourceCombination(input.runtime, input.combination);
      await installProfileReadinessProbe(input.runtime, composition.profileDefaults);
    },
  });
}
