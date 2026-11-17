const { join, resolve } = require("node:path");
const { existsSync, readdirSync } = require("node:fs");
const assert = require("node:assert/strict");
const [modules, project, prepackaged, templates, output] = process.argv
  .slice(2)
  .map((p) => resolve(p));
assert.equal(require(join(modules, "app-builder-lib/package.json")).version, "26.15.3");
const builder = require(join(modules, "electron-builder"));
const { NsisTarget } = require(join(modules, "app-builder-lib/out/targets/nsis/NsisTarget.js"));
const original = NsisTarget.prototype.executeMakensis;
const fastMove = existsSync(join(templates, "include/installer-transfer.nsh"));

process.env.GEA_LEGACY_NSIS_DIAGNOSTIC = "1";
const maxRelativePath = fastMove
  ? readdirSync(prepackaged, { recursive: true }).reduce(
      (max, name) => Math.max(max, name.length),
      0,
    )
  : 0;
NsisTarget.prototype.executeMakensis = function (defines, commands, script, options) {
  if (!Object.prototype.hasOwnProperty.call(defines, "BUILD_UNINSTALLER")) {
    if (fastMove) defines.GEA_MAX_RELATIVE_PATH = maxRelativePath;
    for (const name of ["installSection.nsh", "include/installUtil.nsh"]) {
      const needle = `!include "${name.split("/").at(-1)}"`;
      assert.equal(script.split(needle).length - 1, 1, "Pinned installer include changed");
      script = script.replace(needle, `!include "${join(templates, name)}"`);
    }
  }
  return original.call(this, defines, commands, script, options);
};
builder
  .build({
    projectDir: project,
    prepackaged,
    publish: "never",
    targets: builder.Platform.WINDOWS.createTarget("nsis", builder.Arch.x64),
    config: {
      extends: join(project, "electron-builder.cjs"),
      directories: { output },
      artifactName: "Synear-GEA-${version}-${os}-${arch}-full-diagnostic.exe",
    },
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
