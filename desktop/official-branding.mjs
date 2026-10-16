import { fileURLToPath } from "node:url";

export function officialGeaBranding(config) {
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
    },
    mac: { ...config.mac, icon },
    files: [
      ...config.files,
      "!renderer/welcome.html",
      { from: welcome, to: "renderer", filter: ["**/*"] },
      { from: icon, to: "renderer/gea-logo.png" },
    ],
    extraResources: config.extraResources.map((resource) =>
      resource.to === "icon.png" ? { ...resource, from: icon } : resource,
    ),
  };
}
