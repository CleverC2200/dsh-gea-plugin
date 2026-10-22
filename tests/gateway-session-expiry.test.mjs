import test from "node:test";
import assert from "node:assert/strict";
import { readHtmlQuery } from "../src/html-query.ts";

for (const [errorCode, status, expected] of [
  ["AI_GATEWAY_SESSION_MAX_LIFETIME_EXCEEDED", 200, "GEA_GATEWAY_SESSION_REJECTED"],
  ["AI_GATEWAY_SESSION_EXPIRED", 200, "GEA_GATEWAY_SESSION_REJECTED"],
  ["ROW_SCOPE_DENIED", 403, "ROW_SCOPE_DENIED"],
]) {
  test(errorCode + " takes precedence over a generic failure reason", async () => {
    await assert.rejects(
      readHtmlQuery(
        { sql: "SELECT 1", pageNo: 1 },
        {
          endpoint: "https://fixture.invalid/sql",
          token: "fixture-only",
          signal: new AbortController().signal,
          fetch: async () =>
            Response.json(
              {
                success: false,
                errorCode,
                result: { failure: { reasonCode: "AUTHENTICATION_FAILED" } },
              },
              { status },
            ),
        },
      ),
      (error) => error.code === expected,
    );
  });
}
