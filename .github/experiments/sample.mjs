import fs from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const file = join(process.argv[2], "resources.jsonl");
const read = (p) => fs.readFileSync(p, "utf8");
const sample = () => fs.appendFileSync(file, JSON.stringify({
  timestamp: new Date().toISOString(), stat: read("/proc/stat").split("\n").filter(l => /^cpu |^procs_/.test(l)),
  meminfo: read("/proc/meminfo").split("\n").filter(l => /^(MemTotal|MemAvailable|SwapTotal|SwapFree|Dirty|Writeback):/.test(l)),
  pressure: Object.fromEntries(["cpu", "io", "memory"].map(n => [n, read(`/proc/pressure/${n}`)])),
  diskstats: read("/proc/diskstats"),
  processes: execFileSync("ps", ["-eo", "pid,ppid,pgid,comm,rss,pcpu"], { encoding: "utf8" }),
}) + "\n");
sample();
const timer = setInterval(sample, 5000);
process.on("SIGTERM", () => { clearInterval(timer); sample(); process.exit(0); });
