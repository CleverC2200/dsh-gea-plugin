import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const owner = "src/host/prompt-execution-state.ts";
/** Complements private fields/types: reject reintroducing the real past mutation paths. */
export function checkPromptExecutionSource(source, file) {
  const issues = [];
  // Mask literal/comment contents without changing offsets used by diagnostics.
  const code = source.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (literal) => literal.replace(/[^\n]/g, " "),
  );
  const patterns = [
    {
      pattern:
        /\bimport\s*\{[^}]*\bPromptEvidenceStore\b[^}]*\}|\bnew\s+(?:[\w$]+\.)?PromptEvidenceStore\s*\(/g,
      use: "PromptExecutionState.publishEvidence/readEvidence",
    },
    {
      pattern:
        /\.(?:failures|reads|deniedConsumers|catalogFacts|catalogOutputs|evidenceViews|receipts)\s*\.\s*(?:set|add|delete|clear)\s*\(/g,
      use: "PromptExecutionState.recordOutcome/readEvidence/publishEvidence",
    },
    {
      pattern:
        /\.(?:evidence|returned|catalogStalls|catalogGeneration|turnGeneration)\s*(?:\+=(?!=)|-=(?!=)|=(?!=)|\+\+|--)/g,
      use: "PromptExecutionState.begin/startTurn/publishEvidence",
    },
  ];
  for (const [index, { pattern, use }] of patterns.entries()) {
    if (index > 0 && file !== "src/host/prompt-runtime.ts") continue;
    for (const match of code.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      issues.push(
        `${file}:${line}: use ${use}; asynchronous prompt state and persistence belong to ${owner}`,
      );
    }
  }
  return issues;
}
async function sources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sources(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}
export async function checkPromptExecution(root) {
  const issues = [];
  for (const file of await sources(join(root, "src/host"))) {
    const name = relative(root, file).replaceAll("\\", "/");
    if (name === owner || name === "src/host/prompt-evidence.ts") continue;
    issues.push(...checkPromptExecutionSource(await readFile(file, "utf8"), name));
  }
  return issues;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const issues = await checkPromptExecution(resolve(fileURLToPath(new URL("..", import.meta.url))));
  if (issues.length) {
    console.error(issues.join("\n"));
    process.exitCode = 1;
  } else console.log("Prompt execution state has one owner.");
}
