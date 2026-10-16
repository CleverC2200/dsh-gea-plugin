/** Small command/OS boundary only. No fixture executes sudo, mounts or a real system Chrome. */
import fs from "node:fs";
import cp from "node:child_process";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
export function installChromeCommands({ root }) {
  Object.defineProperty(process, "platform", { value: process.env.FIXTURE_PLATFORM ?? "linux" });
  const realNow = performance.now.bind(performance);
  let clockOffset = 0,
    unmountDeadline,
    busySeen = false,
    tailApplied = false,
    unmountedSeen = false;
  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => realNow() + clockOffset,
  });
  const state = join(root, "mount-state.json"),
    read = fs.readFileSync.bind(fs);
  const mounted = () => {
    try {
      return JSON.parse(read(state));
    } catch {
      return null;
    }
  };
  const map = (p) =>
    typeof p === "string" && (p === "/proc" || p.startsWith("/proc/"))
      ? join(root, "proc", p.slice("/proc".length))
      : typeof p === "string" && (p === "/opt/google/chrome" || p.startsWith("/opt/google/chrome/"))
        ? join(
            root,
            mounted() && process.env.WRONG_MOUNT_SOURCE !== "1"
              ? ".quality-system-chrome"
              : "system",
            p.slice("/opt/google/chrome".length),
          )
        : p;
  for (const key of [
    "readFileSync",
    "readdirSync",
    "lstatSync",
    "statSync",
    "readlinkSync",
    "openSync",
    "opendirSync",
    "copyFileSync",
  ]) {
    const original = fs[key].bind(fs);
    fs[key] = (p, ...args) => {
      if (typeof p === "string" && p.startsWith("/proc")) {
        fs.appendFileSync(
          join(root, "proc-access.jsonl"),
          JSON.stringify({ operation: key, path: p }) + "\n",
        );
        if (process.env.PROC_DIAGNOSTIC === "denied")
          throw Object.assign(Error("proc denied"), { code: "EACCES" });
        if (process.env.PROC_DIAGNOSTIC === "vanished")
          throw Object.assign(Error("proc vanished"), { code: "ENOENT" });
        if (key === "opendirSync" && process.env.PROC_DIAGNOSTIC === "timeout") clockOffset += 300;
        if (key === "readlinkSync" && process.env.PROC_DIAGNOSTIC === "broken")
          throw Error("private fixture diagnostic error");
      }
      const result = original(
        key === "lstatSync" && (p === "/opt" || p === "/opt/google") ? root : map(p),
        ...args,
      );
      if (key === "copyFileSync" && process.env.CHANGE_SOURCE === "1")
        fs.writeFileSync(map("/opt/google/chrome/resources.pak"), "source changed");
      if (key === "copyFileSync" && process.env.CHANGE_SOURCE_MODE)
        fs.chmodSync(
          map(
            process.env.CHANGE_SOURCE_MODE === "root"
              ? "/opt/google/chrome"
              : "/opt/google/chrome/locales",
          ),
          0o777,
        );
      if (
        key === "copyFileSync" &&
        process.env.CHANGE_CHROME_PACKAGE &&
        !fs.existsSync(join(root, "package-change-applied"))
      ) {
        fs.writeFileSync(join(root, "package-change-applied"), "changed once during copying");
        if (process.env.CHANGE_CHROME_PACKAGE === "identity")
          fs.writeFileSync(
            join(root, "package-identity.txt"),
            "google-chrome-stable\t154.0.8037.97-2\tamd64\n",
          );
        else {
          const entries = JSON.parse(read(join(root, "package-files.json")));
          if (process.env.CHANGE_CHROME_PACKAGE === "list")
            entries.push("/usr/share/doc/google-chrome-stable/new-package-file");
          else entries.reverse();
          fs.writeFileSync(join(root, "package-files.json"), JSON.stringify(entries));
        }
      }
      return result;
    };
  }
  const real = fs.realpathSync.bind(fs);
  fs.realpathSync = (p) =>
    p === "/opt/google/chrome" && process.env.REDIRECT_CHROME_SOURCE === "1"
      ? join(root, ".quality-system-chrome")
      : p === "/opt" || p === "/opt/google" || p === "/opt/google/chrome"
        ? p
        : typeof p === "string" && p.startsWith("/opt/google/chrome/")
          ? "/opt/google/chrome/" + real(map(p)).slice(real(map("/opt/google/chrome")).length + 1)
          : real(p);
  const spawn = cp.spawnSync;
  cp.spawnSync = (command, args, options = {}) => {
    if (["/opt/google/chrome/chrome", "dpkg-query", "findmnt", "sudo"].includes(command))
      fs.appendFileSync(
        join(root, "chrome-commands.jsonl"),
        JSON.stringify({
          command,
          args,
          timeout: options.timeout,
          ...(command === "sudo" && args.includes("umount")
            ? { locale: options.env?.LC_ALL, lang: options.env?.LANG, timeout: options.timeout }
            : {}),
        }) + "\n",
      );
    if (command === "/opt/google/chrome/chrome")
      return {
        status: 0,
        stdout:
          (process.env.CHROME_VERSION ??
            "Google Chrome " +
              (process.env.WRONG_VERSION
                ? "155.0.8059.39"
                : mounted()
                  ? "154.0.8037.97"
                  : (process.env.SYSTEM_CHROME_VERSION ?? "154.0.8037.97"))) + "\n",
        stderr: "",
      };
    if (command === "dpkg-query")
      return {
        status: 0,
        stdout: args.includes("--listfiles")
          ? JSON.parse(read(join(root, "package-files.json"))).join("\n")
          : fs.existsSync(join(root, "package-identity.txt"))
            ? read(join(root, "package-identity.txt"), "utf8")
            : "google-chrome-stable\t154.0.8037.97-1\tamd64\n",
        stderr: "",
      };
    if (command === "findmnt") {
      if (unmountedSeen && process.env.FAIL_POST_UNMOUNT_INSPECTION === "1")
        return {
          status: null,
          error: Object.assign(Error("findmnt timed out after normal unmount"), {
            code: "ETIMEDOUT",
          }),
          stdout: "",
          stderr: "",
        };
      if (busySeen && process.env.TIMEOUT_INSPECTION_AFTER_BUSY === "1") {
        clockOffset += options.timeout;
        return {
          status: null,
          signal: "SIGTERM",
          error: Object.assign(Error("findmnt deadline"), { code: "ETIMEDOUT" }),
          stdout: "",
          stderr: "",
        };
      }
      if (busySeen && process.env.CLOCK_INSPECTION_TAIL_MS && !tailApplied) {
        clockOffset = unmountDeadline - realNow() - Number(process.env.CLOCK_INSPECTION_TAIL_MS);
        tailApplied = true;
      }
      const s = mounted();
      return s
        ? {
            status: 0,
            stdout: JSON.stringify({
              filesystems: [
                {
                  target: process.env.WRONG_MOUNT_TARGET ? "/wrong" : "/opt/google/chrome",
                  options: s.readonly ? "ro,relatime" : "rw,relatime",
                },
              ],
            }),
            stderr: "",
          }
        : { status: 1, stdout: "", stderr: "" };
    }
    if (command === "sudo") {
      if (process.env.FAIL_MOUNT === "1") return { status: 1, stdout: "", stderr: "mount denied" };
      if (args.includes("umount")) {
        unmountDeadline ??= performance.now() + options.timeout;
        if (busySeen && process.env.TIMEOUT_AFTER_BUSY === "1") {
          clockOffset += options.timeout;
          return {
            status: null,
            signal: "SIGTERM",
            error: Object.assign(Error("spawnSync sudo ETIMEDOUT"), { code: "ETIMEDOUT" }),
            stdout: "",
            stderr: "",
          };
        }
        if (process.env.BUSY_UNMOUNT) {
          const countFile = join(root, "unmount-count.json");
          const count = fs.existsSync(countFile) ? JSON.parse(read(countFile)) + 1 : 1;
          fs.writeFileSync(countFile, JSON.stringify(count));
          if (count === 1 && process.env.CHANGE_AFTER_BUSY) {
            if (process.env.CHANGE_AFTER_BUSY === "missing") fs.rmSync(state);
            else if (process.env.CHANGE_AFTER_BUSY === "redirect")
              process.env.REDIRECT_CHROME_SOURCE = "1";
            else if (process.env.CHANGE_AFTER_BUSY === "source")
              process.env.WRONG_MOUNT_SOURCE = "1";
            else if (process.env.CHANGE_AFTER_BUSY === "readonly")
              fs.writeFileSync(state, JSON.stringify({ readonly: false }));
            else {
              const markerFile = join(root, "quality-system-chrome-mount.json");
              const marker = JSON.parse(read(markerFile));
              if (process.env.CHANGE_AFTER_BUSY === "snapshot")
                marker.snapshot.snapshotSha256 = "b".repeat(64);
              else marker.runAttempt = "2";
              fs.writeFileSync(markerFile, JSON.stringify(marker));
            }
          }
          if (process.env.BUSY_UNMOUNT === "always" || count <= Number(process.env.BUSY_UNMOUNT)) {
            busySeen = true;
            clockOffset += Number(process.env.UNMOUNT_ADVANCE_MS ?? 0);
            if (process.env.CLOCK_AFTER_BUSY_REMAINING)
              clockOffset =
                unmountDeadline - realNow() - Number(process.env.CLOCK_AFTER_BUSY_REMAINING);
            return {
              status: 32,
              stdout: "",
              stderr: "umount: /opt/google/chrome: target is busy.\n",
            };
          }
        }
        if (process.env.FAIL_UNMOUNT === "1")
          return { status: 1, stdout: "", stderr: "umount denied" };
        if (process.env.FAIL_UNMOUNT === "wrong-target")
          return { status: 32, stdout: "", stderr: "umount: /other: target is busy.\n" };
        if (process.env.FAIL_UNMOUNT === "wrong-status")
          return { status: 1, stdout: "", stderr: "umount: /opt/google/chrome: target is busy.\n" };
        if (process.env.FAIL_UNMOUNT === "signal")
          return { status: null, signal: "SIGTERM", stdout: "", stderr: "" };
        if (process.env.FAIL_UNMOUNT === "timeout")
          return {
            status: null,
            error: Object.assign(Error("spawnSync sudo ETIMEDOUT"), { code: "ETIMEDOUT" }),
            stdout: "",
            stderr: "",
          };
        if (process.env.SUCCESS_UNMOUNT_REMAINING)
          clockOffset = unmountDeadline - realNow() - Number(process.env.SUCCESS_UNMOUNT_REMAINING);
        fs.rmSync(state);
        unmountedSeen = true;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args.includes("--bind")) fs.writeFileSync(state, JSON.stringify({ readonly: false }));
      if (args.includes("remount,bind,ro")) {
        if (process.env.FAIL_REMOUNT === "1")
          return { status: 1, stdout: "", stderr: "remount denied" };
        fs.writeFileSync(state, JSON.stringify({ readonly: process.env.NOT_READONLY !== "1" }));
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    return spawn(command, args, options);
  };
  syncBuiltinESMExports();
}
