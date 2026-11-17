const { join } = require("node:path");
const target = process.env.GEA_DESKTOP_TARGET;
const macIdentity = process.env.GEA_MAC_SIGNING_IDENTITY || "-";
const notarize = process.env.GEA_MAC_NOTARIZE === "1";
if (notarize && macIdentity === "-")
  throw Error("Notarization requires a Developer ID Application identity");
const payloadRoot =
  process.env.GEA_DESKTOP_PAYLOAD_ROOT || join(__dirname, "../.runtime/electron-build");
if (!["mac", "win"].includes(target)) throw new Error("Set GEA_DESKTOP_TARGET to mac or win");
if (target === "win" && !process.env.ELECTRON_BUILDER_7Z_FILTER)
  process.env.ELECTRON_BUILDER_7Z_FILTER = "BCJ";
const windowsSigningCertificate = process.env.WIN_CSC_LINK || process.env.CSC_LINK;
const windowsSigningEnabled = target === "win" && Boolean(windowsSigningCertificate);
const requireWindowsSigning = process.env.GEA_WIN_REQUIRE_SIGNING === "1";
if (requireWindowsSigning && !windowsSigningEnabled)
  throw Error("GEA_WIN_REQUIRE_SIGNING=1 requires WIN_CSC_LINK or CSC_LINK");
const nsis = {
  oneClick: false,
  allowToChangeInstallationDirectory: true,
  deleteAppDataOnUninstall: false,
  differentialPackage: true,
  include: join(__dirname, "build/installer-navigation.nsh"),
};
if (process.env.GEA_INSTALL_TIMING_LOG === "1")
  nsis.include = join(__dirname, "build/installer-timing.nsh");
const directoryInstall = process.env.GEA_LEGACY_NSIS_DIAGNOSTIC !== "1";
if (directoryInstall) nsis.include = join(__dirname, "build/installer-directory.nsh");
module.exports = {
  appId: "com.cleverc2200.gea.desktop",
  productName: "Synear GEA",
  electronVersion: "44.0.0",
  protocols: [{ name: "GEA Client Navigation", schemes: ["aionui"] }],
  directories: { output: join(__dirname, "../.runtime/electron-build/final", target) },
  artifactName: "Synear-GEA-${version}-${os}-${arch}.${ext}",
  asar: true,
  electronFuses: { runAsNode: true },
  npmRebuild: false,
  electronLanguages: ["en-US", "zh-CN", "zh_CN", "zh-TW", "zh_TW"],
  files: [
    "navigation.cjs",
    "permissions.cjs",
    "startup-state.cjs",
    "boot-watch.cjs",
    "updates.mjs",
    "client-installer.mjs",
    "installer-cache.mjs",
    "installer-blockmap.mjs",
    "installer-signature.mjs",
    "download-differential.cjs",
    "download-differential.LICENSE.txt",
    "windows-update-trust.json",
    "THIRD_PARTY_DESKTOP_NOTICES.txt",
    "desktop-release-sources.json",
    "release-sources.json",
    "control-server.mjs",
    "plugin-store.mjs",
    "plugin-store-lock.mjs",
    "plugin-storage.mjs",
    "core-layer.mjs",
    "core-file-mode.mjs",
    "core-asar-reader.cjs",
    "physical-fs.mjs",
    "copy-graph.mjs",
    "installer.mjs",
    "runtime-cookies.cjs",
    "main.cjs",
    "config.cjs",
    "company.config.json",
    "package.json",
    "!node_modules/**",
  ],
  extraResources: [
    {
      from: join(payloadRoot, target, "payload"),
      to: "payload",
      filter: ["**/*", "!node_modules/**/*"],
    },
    {
      from: join(payloadRoot, target, "payload/node_modules"),
      to: "payload/node_modules",
      filter: ["**/*"],
    },
  ],

  mac: {
    icon: join(__dirname, "build/icon.png"),
    target: [{ target: "dmg", arch: ["arm64"] }],
    category: "public.app-category.productivity",
    identity: macIdentity,
    hardenedRuntime: macIdentity !== "-",
    notarize,
  },
  beforePack: async () => {
    require("./verify-client-artifacts.cjs")(join(payloadRoot, target, "payload"));
    if (target === "win" && directoryInstall)
      await require("./windows-directory-installer.cjs").installWindowsDirectoryInstaller();
  },
  afterSign: require("./verify-macos-signature.cjs"),
  dmg: { sign: false },
  win: {
    icon: join(__dirname, "build/icon.png"),
    target: [{ target: "nsis", arch: ["x64"] }],
    signExecutable: windowsSigningEnabled,
    forceCodeSigning: requireWindowsSigning,
  },
  nsis,
  publish: null,
};
