import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

export function officialGeaBranding(config, { companySeed } = {}) {
  const icon = fileURLToPath(new URL("./build/icon.png", import.meta.url));
  const welcome = fileURLToPath(new URL("./official-welcome", import.meta.url));
  return {
    ...config,
    appId: "com.cleverc2200.gea.desktop",
    productName: "GEA Desktop",
    artifactName: "GEA-Desktop-${version}-mac-${arch}-local.${ext}",
    extraMetadata: {
      ...config.extraMetadata,
      productName: "GEA Desktop",
      dshDesktopAppId: "com.cleverc2200.gea.desktop",
      ...(companySeed ? { main: "official-main.cjs" } : {}),
    },
    mac: { ...config.mac, icon },
    files: [
      ...config.files,
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
              filter: ["official-main.cjs", "company-bootstrap.mjs"],
            },
          ]
        : []),
    ],
    extraResources: [
      ...config.extraResources.map((resource) =>
        resource.to === "icon.png" ? { ...resource, from: icon } : resource,
      ),
      ...(companySeed ? [{ from: companySeed, to: "company-seed", filter: ["**/*"] }] : []),
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
                .update(asar.extractFile(root, artifact.path))
                .digest("hex");
            await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
          },
        }
      : {}),
  };
}
