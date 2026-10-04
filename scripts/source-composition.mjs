/** The plugin source composition; order also defines build dependencies. */
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
    configs: ["tsconfig.json", "tsconfig.client.json"],
    build: "manage",
    resources,
    digests: [],
    bundleOrder: 1,
  },
  {
    repo: "dsh-gea-plugin",
    configs: ["tsconfig.json"],
    build: "build:plugin",
    resources,
    digests: [],
    bundleOrder: 4,
  },
  {
    repo: "dsh-genui",
    configs: ["tsconfig.json"],
    build: "build",
    resources: [...resources, "SKILL.md", "docs", "src", "pnpm-lock.yaml"],
    digests: ["SKILL.md", "pnpm-lock.yaml"],
    bundleOrder: 2,
  },
  {
    repo: "dsh-better-sidebar",
    configs: ["tsconfig.json"],
    build: "build",
    resources: [...resources, "locale", "icon.svg", "src", "pnpm-lock.yaml"],
    digests: ["pnpm-lock.yaml", "locale/en.json", "locale/zh.json", "icon.svg"],
    bundleOrder: 3,
  },
];

/** Read the same core package set for type checks, snapshot links and launch inventory. */
export async function corePackages(core) {
  const packages = [];
  for await (const file of glob(
    [
      "packages/*/*/package.json",
      "apps/*/package.json",
      "vendor/*/package.json",
    ],
    { cwd: core },
  )) {
    packages.push({
      directory: resolve(core, file, ".."),
      manifest: JSON.parse(await readFile(resolve(core, file), "utf8")),
    });
  }
  return packages;
}
