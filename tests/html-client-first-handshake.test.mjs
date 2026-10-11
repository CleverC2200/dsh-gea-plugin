import test from "node:test";
import { runWorkbenchContracts } from "./fixtures/workbench-contract.mjs";

// Handshake, Session replacement, theme and sample assertions run at the current owner.
test("the frozen Workbench preserves HTML handshake, state, cancellation and theme contracts", async (t) => {
  t.diagnostic(JSON.stringify(await runWorkbenchContracts(["tests/html-frame-contract.test.mjs"])));
});
