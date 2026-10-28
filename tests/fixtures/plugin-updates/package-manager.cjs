const fs = require("node:fs"),
  path = require("node:path"),
  cp = require("node:child_process");
const args = process.argv.slice(2),
  mode = process.env.FIXTURE_MODE || "success";
fs.appendFileSync(
  path.join(process.cwd(), "invocations.ndjson"),
  JSON.stringify({
    args,
    cwd: process.cwd(),
    marker: process.env.FIXTURE_LAUNCHER_MARKER,
    secretLeaked: Boolean(process.env.FIXTURE_SHOULD_BE_SCRUBBED),
  }) + "\n",
);
console.log("fixture package run started");
setTimeout(() => {
  if (mode === "idle-exit-zero") {
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "slow") {
    process.on("SIGTERM", () => {});
    setInterval(() => console.log("working"), 50);
    return;
  }
  const archives = args
    .filter((arg) => arg.startsWith("file:") && arg.endsWith(".tgz"))
    .map((arg) => arg.slice(5));
  if (!archives.length) process.exit(9);
  for (const archive of archives) {
    const manifest = JSON.parse(
      cp.execFileSync("tar", ["-xOf", archive, "package/package.json"], {
        encoding: "utf8",
      }),
    );
    const target = path.join(process.cwd(), "node_modules", manifest.name);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    cp.execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", target]);
    const profilePath = path.join(process.cwd(), "package.json"),
      profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    profile.dependencies[manifest.name] = "file:" + archive;
    if (mode === "bad-fields") profile.retained.draft = "broken";
    fs.writeFileSync(profilePath, JSON.stringify(profile));
    fs.writeFileSync(
      path.join(process.cwd(), "pnpm-lock.yaml"),
      "lockfileVersion: 9\nupdated: true\n",
    );
    if (mode === "fail-after-first") process.exit(1);
  }
  if (mode === "orphan") {
    const child = cp.spawn(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync(require('node:path').join(process.cwd(),'orphan-ready'),'ready');process.on('SIGTERM',()=>{});setInterval(()=>require('node:fs').writeFileSync(process.env.FIXTURE_LATE_FILE,String(Date.now())),20);setTimeout(()=>process.exit(0),10000)",
      ],
      { stdio: "inherit", env: process.env, detached: process.platform === "win32" },
    );
    fs.writeFileSync(path.join(process.cwd(), "orphan-pid"), String(child.pid));
    child.on("error", (error) => {
      console.error(error);
      process.exit(10);
    });
    const ready = setInterval(() => {
      if (fs.existsSync(path.join(process.cwd(), "orphan-ready"))) {
        clearInterval(ready);
        process.exit(0);
      }
    }, 10);
    return;
  }
  if (mode === "wrong-installed-version") {
    const manifest = JSON.parse(
      cp.execFileSync("tar", ["-xOf", archives[0], "package/package.json"], { encoding: "utf8" }),
    );
    const file = path.join(process.cwd(), "node_modules", manifest.name, "package.json");
    fs.writeFileSync(file, JSON.stringify({ ...manifest, version: "0.0.1" }));
  }
  process.exit(mode === "fail-after-write" ? 1 : 0);
}, 150);
