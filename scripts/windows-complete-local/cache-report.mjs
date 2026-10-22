import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2]);
const output = join(
  root,
  "apps/desktop/.desktop-build/targets/win-x64",
  process.env.DSH_DELIVERY_PREPARE_ONLY === "true" ? "gea-preparation" : "gea-local",
);
await mkdir(output, { recursive: true });
async function read(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
const result = await read(join(output, "result.json"));
const preflight = await read(join(process.env.RUNNER_TEMP, "windows-cache-preflight.json"));
const layers = await Promise.all(
  ["core", "runtime"].map(async (name) => ({
    name,
    ...(await read(join(output, `${name}-reuse.json`))),
  })),
);
const rejections = [];
for (const file of await readdir(output))
  if (/^cache-rejection-.*\.json$/.test(file)) rejections.push(await read(join(output, file)));
for (const layer of layers) {
  const lookup = preflight?.layers?.find(
    (entry) => entry.profile === (layer.name === "core" ? "official" : "windows-runtime"),
  );
  const rejection = rejections.find(
    (entry) => entry.profile === (layer.name === "core" ? "official" : "windows-runtime"),
  );
  layer.key ??= lookup?.key ?? "unknown";
  if (layer.reason === "readable-scope-empty" && lookup?.reason === "input-changed")
    layer.reason = "input-changed";
  if (rejection) Object.assign(layer, rejection);
}
const report = {
  status: result?.status ?? "incomplete",
  tools: {
    key: process.env.DSH_DELIVERY_TOOLS_KEY,
    hit: process.env.DSH_DELIVERY_TOOLS_HIT === "true",
    sourceRef: "unknown",
    requested: true,
    reason:
      process.env.DSH_DELIVERY_TOOLS_HIT === "true"
        ? "restored-key-hit"
        : process.env.DSH_DELIVERY_TOOLS_RESTORE === "failure"
          ? "restore-failed"
          : "unknown",
    integrity:
      process.env.DSH_DELIVERY_TOOLS_PREFLIGHT === "success" ? "tools-preflight-passed" : "unknown",
  },
  preflight: preflight ?? { reason: "unknown" },
  layers,
  rejections,
  skipped: result?.skipped ?? [],
  stages: (await read(join(output, "stages.json"))) ?? [],
  jobSteps: [],
};
try {
  const response = await fetch(
    `${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/jobs?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok) throw Error();
  const jobs = await response.json();
  const job = jobs.jobs.find((entry) => entry.name === process.env.GITHUB_JOB);
  if (!job) throw Error();
  report.jobSteps = job.steps.map((step) => ({
    name: step.name,
    conclusion: step.conclusion,
    seconds:
      step.started_at && step.completed_at
        ? (Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000
        : null,
  }));
  report.jobStartedAt = job.started_at;
} catch {
  report.jobTiming = "unknown";
}
await writeFile(join(output, "cache-report.json"), JSON.stringify(report, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = [{ name: "tools", ...report.tools }, ...layers]
    .map(
      (layer) =>
        `| ${layer.name} | ${layer.key ?? "unknown"} | ${layer.sourceRef ?? "unknown"} | ${layer.reason ?? "unknown"} | ${layer.integrity ?? "unknown"} |`,
    )
    .join("\n");
  const steps = report.jobSteps
    .map(
      (step) => `| ${step.name} | ${step.conclusion ?? "unknown"} | ${step.seconds ?? "unknown"} |`,
    )
    .join("\n");
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `\nWindows delivery cache: ${report.status}\n\nPreflight: ${report.preflight.reason}; ${report.preflight.seconds ?? "unknown"}s including any wait for main preparation.\n\n| Layer | Key | Source ref | Reason | Integrity |\n| --- | --- | --- | --- | --- |\n${rows}\n\nSkipped: ${report.skipped.join(", ") || "none"}.\n\n| Job step | Conclusion | Seconds |\n| --- | --- | --- |\n${steps}\n\nBuild stages: ${JSON.stringify(report.stages)}\n`,
  );
}
console.log(JSON.stringify(report));
