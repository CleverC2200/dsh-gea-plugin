import { appendFileSync } from "node:fs";
import { withSourcePhaseObserver } from "../../scripts/source-phase-observer.mjs";

export async function measureSourceUpdate(t, phase, step, run) {
  const started = performance.now();
  const record = (value) => {
    const row = {
      timestamp: new Date().toISOString(),
      testName: t.name,
      phase,
      step,
      ...value,
    };
    try {
      t.diagnostic(JSON.stringify(row));
    } catch {}
    try {
      if (process.env.GEA_TEST_LIFECYCLE_RECEIPT)
        appendFileSync(process.env.GEA_TEST_LIFECYCLE_RECEIPT, JSON.stringify(row) + "\n", {
          mode: 0o600,
        });
    } catch {}
  };
  record({ event: "source-update-step-started" });
  let status = "failed";
  try {
    const result = await withSourcePhaseObserver((row) => record({ scopeStep: step, ...row }), run);
    status = "passed";
    return result;
  } finally {
    record({
      event: "source-update-step-completed",
      status,
      durationMs: performance.now() - started,
    });
  }
}
