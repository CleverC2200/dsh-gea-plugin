import test from "node:test";
import { execFileSync } from "node:child_process";

test("published pickup SQL resolves only complete unique canonical relationships", () => {
  execFileSync("python3", ["scripts/test_fc_dms_pickup.py"], { stdio: "pipe" });
});
