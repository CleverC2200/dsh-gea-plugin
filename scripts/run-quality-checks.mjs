/** Run every independent quality check and preserve each non-success result. */
export function runQualityChecks(checks) {
  return checks.map(({ name, execute }) => {
    try {
      execute();
      return { name, status: "passed" };
    } catch (error) {
      return { name, status: "failed", error: error.message };
    }
  });
}
