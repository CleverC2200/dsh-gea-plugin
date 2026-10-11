import test from "node:test";
import { runWorkbenchContracts } from "./fixtures/workbench-contract.mjs";

// Catalog visibility, resource binding and discovery cleanup use the current public owner.
test("the frozen Workbench preserves HTML catalog, hidden-page and discovery contracts", async (t) => {
  t.diagnostic(
    JSON.stringify(
      await runWorkbenchContracts([
        "tests/html-discovery-contract.test.mjs",
        "tests/html-pages.test.mjs",
      ]),
    ),
  );
});
