import { glob, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const resources = [
  "package.json",
  "cordis.patch.yml",
  "lib",
  "client",
  "schemas",
  "presets",
  "default-presets",
  "business-skills",
  "business-resources",
  "scripts/deployment.mjs",
  "src/shared",
];

export const sourcePlugins = [
  {
    repo: "dsh-agent-workbench",
    name: "@cleverc2200/dsh-agent-workbench",
    configs: ["tsconfig.json"],
    build: "workbench",
    resources,
    digests: [],
    bundleOrder: 0,
    typeEntries: {
      "@cleverc2200/dsh-agent-workbench": "lib/types/host.d.ts",
      "@cleverc2200/dsh-agent-workbench/client": "lib/types/client.d.ts",
    },
  },
  {
    repo: "dsh-agent-manage",
    name: "dsh-agent-manage",
    configs: ["tsconfig.json", "tsconfig.client.json"],
    build: "manage",
    resources,
    digests: [],
    bundleOrder: 1,
  },
  {
    repo: "dsh-gea-plugin",
    name: "@cleverc2200/gea-dsh-prototype",
    configs: ["tsconfig.json"],
    build: "build:plugin",
    resources,
    digests: [],
    bundleOrder: 4,
  },
  {
    repo: "dsh-genui",
    name: "@changfenhuang/dsh-genui",
    configs: ["tsconfig.json"],
    build: "build",
    resources: [
      ...resources,
      "SKILL.md",
      "ICON-NAMES.md",
      "THIRD_PARTY_NOTICES.md",
      "assets",
      "docs",
      "src",
    ],
    digests: ["SKILL.md", "ICON-NAMES.md", "THIRD_PARTY_NOTICES.md", "assets/genui-icon.svg"],
    bundleOrder: 2,
  },
  {
    repo: "dsh-better-sidebar",
    name: "dsh-better-sidebar",
    configs: ["tsconfig.json"],
    build: "build",
    resources: [...resources, "locale", "icon.svg", "src"],
    digests: ["locale/en.json", "locale/zh.json", "icon.svg"],
    bundleOrder: 3,
  },
];

export async function corePackages(core) {
  const packages = [];
  for await (const file of glob(
    ["packages/*/*/package.json", "apps/*/package.json", "vendor/*/package.json"],
    { cwd: core },
  )) {
    packages.push({
      directory: resolve(core, file, ".."),
      manifest: JSON.parse(await readFile(resolve(core, file), "utf8")),
    });
  }
  return packages;
}
