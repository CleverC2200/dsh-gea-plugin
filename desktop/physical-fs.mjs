import * as fs from "node:fs/promises";
import { createRequire } from "node:module";

export const physicalFs = process.versions.electron
  ? createRequire(import.meta.url)("original-fs").promises
  : fs;
