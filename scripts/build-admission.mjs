import fs from "node:fs";
import os from "node:os";
import { dirname, join, resolve, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";

export const buildPolicy = Object.freeze({
  safetyBytes: 20 * 1024 ** 3,
  reserveBytes: Object.freeze({
    prepare: 3 * 1024 ** 3,
    build: 1024 ** 3,
    package: 1024 ** 3,
    desktop: 8 * 1024 ** 3,
    sdk: 8 * 1024 ** 3,
    watch: 1024 ** 3,
  }),
});
const fail = (code) => {
  throw Error(code);
};
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};
function existing(path) {
  let current = resolve(path);
  while (!fs.existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) fail("BUILD_OUTPUT_VOLUME_UNKNOWN");
    current = parent;
  }
  return current;
}
function volume(path) {
  const target = fs.realpathSync(existing(path));
  const device = String(fs.statSync(target).dev);
  const root = join(os.tmpdir(), `dsh-build-admission-${process.getuid?.() ?? "user"}`);
  return { target, device, root };
}
export function readBuildAdmissions(path = process.cwd()) {
  const { root } = volume(path);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const entry = JSON.parse(fs.readFileSync(join(root, file), "utf8"));
      if (
        !Number.isSafeInteger(entry.reserveBytes) ||
        entry.reserveBytes < 0 ||
        !Array.isArray(entry.scopes) ||
        entry.scopes.some((path) => typeof path !== "string")
      )
        fail("BUILD_ADMISSION_INVALID");
      return { ...entry, active: alive(entry.pid) };
    });
}
export function acquireBuild({
  operation,
  cwd = process.cwd(),
  output = cwd,
  scopes = [cwd, output],
}) {
  const reserveBytes = buildPolicy.reserveBytes[operation];
  if (reserveBytes === undefined) fail("BUILD_OPERATION_UNKNOWN");
  const scope = resolve(fs.realpathSync(existing(cwd)), relative(existing(cwd), resolve(cwd)));
  const roots = [
    ...new Set(
      scopes.map((path) =>
        resolve(fs.realpathSync(existing(path)), relative(existing(path), resolve(path))),
      ),
    ),
  ];
  const overlaps = (a, b) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
  const { target, device, root } = volume(output);
  const inherited = process.env.DSH_BUILD_ADMISSION;
  if (inherited && /^[a-f0-9-]{36}$/.test(inherited)) {
    const file = join(root, `${inherited}.json`);
    if (fs.existsSync(file)) {
      const entry = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        entry.token === inherited &&
        entry.device === device &&
        alive(entry.pid) &&
        entry.reserveBytes >= reserveBytes &&
        roots.every((path) =>
          entry.scopes.some((parent) => path === parent || path.startsWith(parent + sep)),
        )
      )
        return () => {};
    }
    fail("BUILD_ADMISSION_EXPIRED");
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const mutex = join(root, "admitting");
  try {
    fs.mkdirSync(mutex, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") fail("BUILD_ADMISSION_BUSY");
    throw error;
  }
  const token = randomUUID();
  const file = join(root, `${token}.json`);
  try {
    const claims = readBuildAdmissions(output);
    if (claims.some((entry) => !entry.active)) fail("BUILD_ADMISSION_REQUIRES_REVIEW");
    if (
      claims.some((entry) =>
        roots.some((path) => entry.scopes.some((other) => overlaps(path, other))),
      )
    )
      fail("BUILD_OUTPUT_BUSY");
    if (
      operation !== "watch" &&
      claims.some((entry) => entry.device === device && entry.operation !== "watch")
    )
      fail("BUILD_VOLUME_BUSY");
    const stats = fs.statfsSync(target);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const reservedBytes = claims
      .filter((entry) => entry.device === device)
      .reduce((sum, entry) => sum + entry.reserveBytes, 0);
    const requiredBytes = buildPolicy.safetyBytes + reservedBytes + reserveBytes;
    if (availableBytes < requiredBytes) {
      const error = Error("BUILD_CAPACITY_INSUFFICIENT");
      Object.assign(error, { availableBytes, requiredBytes, reserveBytes, reservedBytes });
      throw error;
    }
    fs.writeFileSync(
      file,
      JSON.stringify({
        token,
        pid: process.pid,
        cwd: scope,
        scopes: roots,
        device,
        operation,
        reserveBytes,
        createdAt: new Date().toISOString(),
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  } finally {
    fs.rmdirSync(mutex);
  }
  const previous = process.env.DSH_BUILD_ADMISSION;
  process.env.DSH_BUILD_ADMISSION = token;
  return () => {
    if (previous === undefined) delete process.env.DSH_BUILD_ADMISSION;
    else process.env.DSH_BUILD_ADMISSION = previous;
    if (JSON.parse(fs.readFileSync(file, "utf8")).token !== token) fail("BUILD_ADMISSION_CHANGED");
    fs.unlinkSync(file);
  };
}
export async function withBuildAdmission(options, execute) {
  const release = acquireBuild(options);
  try {
    return await execute();
  } finally {
    release();
  }
}
export function holdBuildAdmission(options) {
  const release = acquireBuild(options);
  process.once("exit", release);
}
