import { profile } from "../profile.mjs";
import { fixtureEnvironment } from "./business-session.mjs";

/** Explicit caller-owned fake keys must reach the public parent preflight as well as its child. */
export async function modelProfile(t, options = {}) {
  const keys = Object.fromEntries(
    Object.entries(options.env ?? {}).filter(([name]) =>
      [
        "GEA_TEST_MODEL_KEY",
        "GEA_BUDGET_TEST_KEY",
        "GEA_QA_MODEL_KEY",
        "V2_TEST_MODEL_KEY",
      ].includes(name),
    ),
  );
  fixtureEnvironment(t, keys);
  return profile(t, options);
}
