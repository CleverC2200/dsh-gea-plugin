import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import base from "../dsh-agent-manage/vitest.preset-integration.config.ts";
const peerRequire = createRequire(resolve(import.meta.dirname, "../dsh-agent-manage/package.json"));
export default {
  ...base,
  root: import.meta.dirname,
  resolve: {
    ...base.resolve,
    alias: [
      ...base.resolve.alias,
      {
        find: "vitest",
        replacement: resolve(
          dirname(peerRequire.resolve("vitest/package.json")),
          peerRequire("vitest/package.json").exports["."].import.default,
        ),
      },
    ],
  },
  test: { ...base.test, include: ["tests/fixtures/gea-model-core.mjs"], exclude: [] },
};
