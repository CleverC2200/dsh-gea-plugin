import test from "./fixtures/source-test.mjs";
import { pageReferenceColumn } from "./fixtures/page-reference-column.mjs";

test(
  "a quantity change preserves the click-time row snapshot",
  { skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 90000 },
  (t) => pageReferenceColumn(t, "quantity"),
);
