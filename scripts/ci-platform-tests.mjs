export const macosIsolationTests = Object.freeze([
  "scripts/isolated-validation.test.mjs",
  "tests/host-config-keychain.test.mjs",
]);

export function selectPlatformTests(plan, platform = process.platform) {
  return {
    ...plan,
    files: plan.files.filter(
      (file) => platform === "darwin" || !macosIsolationTests.includes(file),
    ),
    platformTasks: [
      {
        platform: "darwin",
        phase: "macos-isolation",
        files: [...macosIsolationTests],
      },
    ],
  };
}

export function requiresDependencyReview(changes, event) {
  return (
    event === "pull_request" &&
    changes.some(
      ({ repo, file }) =>
        repo === "dsh-gea-plugin" &&
        /^(?:package\.json|pnpm-lock\.yaml|npm-shrinkwrap\.json|desktop\/(?:package\.json|diagnostic-package\.json|tools\/(?:package\.json|package-lock\.json)))$/.test(
          file,
        ),
    )
  );
}
