const { spawn } = require("node:child_process");
const { writeFileSync, watch } = require("node:fs");
const { join } = require("node:path");
const root = process.env.QUALITY_STAGE_FIXTURE_ROOT ?? process.env.GITHUB_WORKSPACE;
process.stdout.write("browser install output\n");
process.stderr.write("browser install diagnostic\n");
if (process.env.BROWSER_SCENARIO === "fail") process.exit(19);
if (process.env.BROWSER_SCENARIO === "hang") {
  process.on("SIGTERM", () => {});
  writeFileSync(join(root, "browser-leader-ready"), String(process.pid));
  spawn(
    process.execPath,
    [
      "-e",
      `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(join(root, "browser-grandchild-ready"))},String(process.pid));fs.watch(${JSON.stringify(root)},()=>{});`,
    ],
    { stdio: "inherit" },
  );
  watch(root, () => {});
}
