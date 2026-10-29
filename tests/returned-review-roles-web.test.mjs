import test from "./fixtures/source-test.mjs";
import { returnedReviewRole } from "./fixtures/returned-review-role.mjs";

test(
  "the rejecting role cannot approve a return addressed to the previous node: region/6",
  { timeout: 90000 },
  (t) => returnedReviewRole(t, "region", 6),
);
