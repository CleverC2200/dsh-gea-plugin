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
