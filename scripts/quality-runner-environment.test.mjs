import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { readRunnerEnvironment, verifyRunnerCompatibility } from "./quality-runner-environment.mjs";

function withLinuxFacts(environment, observe) {
  const previousEnvironment = Object.fromEntries(
    ["ImageOS", "ImageVersion"].map((key) => [key, process.env[key]]),
  );
  const descriptors = [
    [process, "platform", "linux"],
    [process, "arch", environment.FIXTURE_ARCH ?? "arm64"],
    [process.versions, "node", environment.FIXTURE_NODE ?? "24.21.0"],
    [process.versions, "modules", environment.FIXTURE_MODULES ?? "137"],
    [process.versions, "napi", environment.FIXTURE_NAPI ?? "10"],
  ].map(([object, key, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, {
      ...descriptor,
      value: key === "platform" ? (environment.FIXTURE_PLATFORM ?? value) : value,
    });
    return { object, key, descriptor };
  });
  const readFile = fs.readFileSync;
  const report = process.report.getReport;
  try {
    process.env.ImageOS = environment.ImageOS ?? "fixture-os";
    process.env.ImageVersion = environment.ImageVersion ?? "fixture-image";
    process.report.getReport = () => ({
      header: { glibcVersionRuntime: environment.FIXTURE_GLIBC ?? "2.39" },
    });
    fs.readFileSync = (file, ...args) => {
      if (file !== "/etc/os-release") return readFile(file, ...args);
      if (environment.FIXTURE_OS_RELEASE === "MISSING")
        throw Object.assign(Error("missing os-release"), { code: "ENOENT" });
      const value =
        environment.FIXTURE_OS_RELEASE ??
        'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.5 LTS"\n';
      return args[0] === "utf8" ? value : Buffer.from(value);
    };
    syncBuiltinESMExports();
    return observe();
  } finally {
    fs.readFileSync = readFile;
    process.report.getReport = report;
    syncBuiltinESMExports();
    for (const { object, key, descriptor } of descriptors)
      Object.defineProperty(object, key, descriptor);
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the public runner environment validates local Linux facts without preparing a worker", async (t) => {
  const producer = withLinuxFacts({}, readRunnerEnvironment);
  assert.deepEqual(
    {
      node: producer.node,
      platform: producer.platform,
      osId: producer.osId,
      osVersionId: producer.osVersionId,
      glibc: producer.glibc,
    },
    { node: "24.21.0", platform: "linux", osId: "ubuntu", osVersionId: "24.04", glibc: "2.39" },
  );
  assert.equal(
    verifyRunnerCompatibility(producer, { ...producer, imageVersion: "next-image-release" })
      .imageVersionChanged,
    true,
  );
  const cases = [
    { ImageOS: "other-image-os" },
    { FIXTURE_OS_RELEASE: 'ID=debian\nVERSION_ID="24.04"\n' },
    { FIXTURE_OS_RELEASE: 'ID=ubuntu\nVERSION_ID="24.10"\n' },
    { FIXTURE_ARCH: "other-arch" },
    { FIXTURE_PLATFORM: "other-os" },
    { FIXTURE_NODE: "24.0.0" },
    { FIXTURE_MODULES: "138" },
    { FIXTURE_NAPI: "11" },
    { FIXTURE_GLIBC: "2.40" },
    { ImageOS: "" },
    { ImageVersion: "" },
    { FIXTURE_MODULES: "" },
    { FIXTURE_NAPI: "" },
    { FIXTURE_GLIBC: "" },
    { FIXTURE_OS_RELEASE: "MISSING" },
    { FIXTURE_OS_RELEASE: 'VERSION_ID="24.04"\n' },
    { FIXTURE_OS_RELEASE: "ID=ubuntu\n" },
    { FIXTURE_OS_RELEASE: 'ID="ubuntu\nVERSION_ID=24.04\n' },
  ];
  for (const environment of cases)
    await t.test(JSON.stringify(environment), () => {
      assert.throws(
        () =>
          withLinuxFacts(environment, () =>
            verifyRunnerCompatibility(producer, readRunnerEnvironment()),
          ),
        /QUALITY_RUNNER_ENVIRONMENT_REJECTED/,
      );
    });
});
