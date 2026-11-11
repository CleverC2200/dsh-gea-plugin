import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

export async function prepareOfficialGeaMain(desktop, output) {
  const source = await readFile(join(desktop, "lib/main.js"), "utf8");
  if (!source.includes("DeepSeek Harness")) throw Error("COMPANY_DESKTOP_BRANDING_DRIFT");
  const directory = join(output, "company-main");
  await mkdir(directory, { recursive: true });
  const main = join(directory, "main.js");
  await writeFile(main, source.replaceAll("DeepSeek Harness", "Synear GEA"));
  return main;
}

export function officialGeaBranding(config, { companySeed, brandedMain } = {}) {
  const icon = fileURLToPath(new URL("./build/icon.png", import.meta.url));
  const welcome = fileURLToPath(new URL("./official-welcome", import.meta.url));
  return {
    ...config,
    appId: "com.cleverc2200.gea.desktop",
    productName: "Synear GEA",
    artifactName: "Synear-GEA-${version}-mac-${arch}-local.${ext}",
    extraMetadata: {
      ...config.extraMetadata,
      productName: "Synear GEA",
      dshDesktopAppId: "com.cleverc2200.gea.desktop",
      ...(companySeed ? { main: "official-main.cjs" } : {}),
    },
    mac: {
      ...config.mac,
      icon,
      extendInfo: {
        ...config.mac?.extendInfo,
        NSMicrophoneUsageDescription:
          "Synear GEA uses your microphone to transcribe speech into message drafts.",
      },
    },
    protocols: config.protocols?.map((protocol) => ({
      ...protocol,
      name: protocol.name === "DeepSeek Harness" ? "Synear GEA" : protocol.name,
    })),
    files: [
      ...config.files.filter((file) => !brandedMain || file !== "lib/main.js"),
      ...(brandedMain
        ? [{ from: dirname(brandedMain), to: "lib", filter: [basename(brandedMain)] }]
        : []),
      "!renderer/welcome.html",
      { from: welcome, to: "renderer", filter: ["**/*"] },
      {
        from: fileURLToPath(new URL("./build", import.meta.url)),
        to: "renderer/gea-brand",
        filter: ["icon.png"],
      },
      ...(companySeed
        ? [
            {
              from: fileURLToPath(new URL(".", import.meta.url)),
              to: ".",
              filter: [
                "official-main.cjs",
                "company-bootstrap.mjs",
                "company-gea-refresh.mjs",
                "company-update.mjs",
                "company-archives.mjs",
                "legacy-gea-cleanup.mjs",
                "plugin-storage.mjs",
                "plugin-store-lock.mjs",
                "physical-fs.mjs",
              ],
            },
          ]
        : []),
    ],
    extraResources: [
      ...config.extraResources.map((resource) =>
        resource.to === "icon.png" ? { ...resource, from: icon } : resource,
      ),
      ...(companySeed ? [{ from: companySeed, to: "company-seed", filter: ["**/*"] }] : []),
      ...(companySeed
        ? [
            {
              from: fileURLToPath(new URL("../scripts", import.meta.url)),
              to: "scripts",
              filter: ["ci-core-policy.mjs", "ci-core-policy.json", "supported-cores.json"],
            },
          ]
        : []),
    ],
    ...(companySeed
      ? {
          afterPack: async (context) => {
            await config.afterPack?.(context);
            const resources = context.packager.getResourcesDir(context.appOutDir);
            const path = join(resources, "company-seed/manifest.json");
            const manifest = JSON.parse(await readFile(path, "utf8"));
            const root = join(resources, "app.asar");
            const require = createRequire(join(context.packager.projectDir, "package.json"));
            const asar = createRequire(require.resolve("app-builder-lib/package.json"))(
              "@electron/asar",
            );
            for (const artifact of manifest.core.artifacts)
              artifact.sha256 = createHash("sha256")
                .update(asar.extractFile(root, join(...artifact.path.split("/"))))
                .digest("hex");
            await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
          },
        }
      : {}),
  };
}
