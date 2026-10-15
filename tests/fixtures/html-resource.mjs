import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeHtmlDeclarations(root, { page, capability, prompt }) {
  for (const [file, value] of Object.entries({
    "page.json": page,
    "capability.json": capability,
    "prompt.json": prompt,
  })) {
    await writeFile(join(root, file), JSON.stringify(value));
  }
}
