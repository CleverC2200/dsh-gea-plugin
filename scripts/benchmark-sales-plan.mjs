import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";

const execFile = promisify(execFileCallback);
const budgetMs = 5000;
const expiryWaitMs = 61_000;
const uiTimeout = 35_000;
const queryPath = "/api/gea-proof/workbench/query";
const nativePath = "/api/agent-workbench/native";
const listRow = 'tbody td [class*="categoryProgressCell"]';
const skuLabel = "按大类 / SKU";
const salesButton = /^(销售计划|Sales plan)$/;
const scenarios = ["first", "expired", "volume"];

const { values: options } = parseArgs({
  options: {
    "launch-log": { type: "string" },
    restart: { type: "string" },
    out: { type: "string" },
    scenario: { type: "string", default: "all" },
    runs: { type: "string", default: "5" },
    "min-plans": { type: "string", default: "5" },
    "plan-type": { type: "string", default: "月初" },
    month: { type: "string" },
    help: { type: "boolean" },
  },
});

if (options.help) {
  console.log(`node scripts/benchmark-sales-plan.mjs --launch-log FILE --out NEW_FILE [--restart SCRIPT]
  --scenario all|first|expired|volume (default all)
  --runs 5 --min-plans 5 --plan-type 月初|纠偏 [--month 2026年12月]

Use an isolated running desktop client with the candidate installed, live read access,
and its launcher stdout log. The restart script takes no arguments and must wait
for the restarted client's loopback URL to be logged. It is required for first/all.
First restarts the isolated client and records whether the index needed a scan.
Expired rebuilds the page in the same signed-in browser context and waits 61
seconds beyond the observed index read. It requires a physical upstream scan.
Volume waits for the selected list to settle before clicking SKU, and checks
that the requested minimum number of distinct plans actually reach SKU review.
The output records failed attempts and contains timings, counts and trace IDs.
An existing output path is rejected. Exit 1 means a case failed coverage or budget.`);
  process.exit(0);
}

const selected = options.scenario === "all" ? scenarios : [options.scenario];
const repeatCount = Number(options.runs);
const minimumPlans = Number(options["min-plans"]);
assert.ok(
  selected.every((scenario) => scenarios.includes(scenario)),
  "Unknown scenario",
);
assert.ok(Number.isSafeInteger(repeatCount) && repeatCount > 0, "Invalid --runs");
assert.ok(Number.isSafeInteger(minimumPlans) && minimumPlans >= 2, "Invalid --min-plans");
assert.ok(["月初", "纠偏"].includes(options["plan-type"]), "Invalid --plan-type");
assert.ok(options["launch-log"] && options.out, "--launch-log and --out are required");
assert.ok(!selected.includes("first") || options.restart, "--restart is required for first");
assert.ok(!options.month || /^\d{4}年\d{1,2}月$/.test(options.month), "Invalid --month");

const safeError = (error) =>
  String(error.message ?? error)
    .split("\n")[0]
    .replace(/token=[^\s"&]+/gi, "token=<redacted>");
const listKey = (query) =>
  JSON.stringify([query.status, query.pageNo, query.summaryOnly, query.orderType]);
const idPattern = /^[a-z0-9-]{8,80}$/i;
const number = (value) => (Number.isFinite(value) ? Math.round(value) : null);
const delta = (end, start) => (end != null && start != null ? number(end - start) : null);

async function launchUrl() {
  const log = await readFile(options["launch-log"], "utf8");
  const url = [...log.matchAll(/^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/gm)].at(-1)?.[1];
  assert.ok(url, "No isolated loopback URL in client launch log");
  return url;
}

function installClickClock(labels) {
  window.salesBench = { clicks: {}, list: [] };
  const now = () => performance.timeOrigin + performance.now();
  addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const control = event.target.closest('button,[role="tab"]');
      const text = control?.textContent.trim();
      if (window === top && ["销售计划", "Sales plan"].includes(text))
        window.salesBench.clicks.sales = now();
      if (window !== top && text === labels.sku) window.salesBench.clicks.sku = now();
    },
    { capture: true },
  );

  if (window === top) return;

  const fetchPage = window.fetch;
  window.fetch = async function (input, init) {
    const response = await fetchPage.apply(this, arguments);
    if (!String(input).includes(labels.queryPath) || !init?.body) return response;
    const payload = JSON.parse(init.body);
    if (payload.kind !== "list") return response;
    const { status, pageNo, summaryOnly, orderType } = payload.query;
    const receipt = {
      key: JSON.stringify([status, pageNo, summaryOnly, orderType]),
      http: response.status,
    };
    window.salesBench.list.push(receipt);
    if (response.headers.get("content-type")?.includes("application/x-ndjson")) {
      receipt.chunks = [];
      const getReader = response.body.getReader.bind(response.body);
      response.body.getReader = (...args) => {
        const reader = getReader(...args);
        const read = reader.read.bind(reader);
        reader.read = async (...readArgs) => {
          const next = await read(...readArgs);
          if (next.done) receipt.end = now();
          else receipt.chunks.push(next.value);
          return next;
        };
        return reader;
      };
    } else {
      const json = response.json.bind(response);
      response.json = async () => {
        const result = await json();
        receipt.end = now();
        receipt.result = { ok: result.ok, rows: result.value?.records?.length };
        return result;
      };
    }
    return response;
  };
}

function networkCapture(page) {
  const capture = { records: [], jobs: [] };
  const byRequest = new Map();
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/") || path.includes("/api-log/")) return;
    const body = path === queryPath && request.method() === "POST" ? request.postDataJSON() : null;
    const query = body?.query ?? {};
    const row = {
      request,
      path: path.replace(/\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?=\/|$)/gi, "/:id"),
      kind:
        path === queryPath
          ? body?.kind
          : path.endsWith("/workflow/config")
            ? "workflow"
            : undefined,
      start: Date.now(),
      ...(body?.kind === "list"
        ? {
            listKey: listKey(query),
            statusPartition: query.status,
            page: query.pageNo,
            summary: query.summaryOnly,
          }
        : {}),
      ...(body?.kind === "skuReview" ? { plan: String(query.planId) } : {}),
      ...(body?.kind === "periods"
        ? { indexReuseRequested: request.headers()["x-gea-sales-plan-period-index"] === "reuse" }
        : {}),
    };
    byRequest.set(request, row);
    capture.records.push(row);
  });
  page.on("response", (response) => {
    const row = byRequest.get(response.request());
    if (row) row.http = response.status();
  });
  page.on("requestfinished", (request) => {
    const row = byRequest.get(request);
    if (!row) return;
    row.end = Date.now();
    if (!row.kind || row.kind === "list") return;
    const job = request
      .response()
      .then((response) => response.json())
      .then(({ ok, value }) => {
        row.ok = ok === true;
        row.rows =
          value?.records?.length ??
          value?.rows?.length ??
          (Array.isArray(value) ? value.length : undefined);
        row.shipmentUnavailable = value?.shipmentUnavailable === true;
      })
      .catch(() => {
        row.receiptError = true;
      });
    capture.jobs.push(job);
  });
  page.on("requestfailed", (request) => {
    const row = byRequest.get(request);
    if (!row) return;
    row.end = Date.now();
    row.cancelled = request.failure()?.errorText === "net::ERR_ABORTED";
    if (!row.cancelled) row.receiptError = true;
  });
  return capture;
}

function browserListReceipts(frame) {
  return frame.evaluate(() =>
    window.salesBench.list.map(({ chunks, ...receipt }) => {
      if (!chunks || !receipt.end) return receipt;
      const decoder = new TextDecoder();
      const wire =
        chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
      const frames = wire
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const [final] = frames.slice(-1);
      const partial = frames.find((value) => value.page)?.page;
      return {
        ...receipt,
        result: { ok: final?.ok, rows: final?.value?.records?.length },
        partialRows: partial?.records.length,
        pendingValuesValid: partial?.records.every(
          (row) => !row.shipmentPending || (row.shipQty === null && row.shipAmount === null),
        ),
      };
    }),
  );
}

function sqlKind(record) {
  const sql = String(record.request.body?.sql ?? "");
  if (sql.includes("AS ship_qty0")) return "skuHistory";
  if (sql.includes("qtyshipped")) return "shipmentQuantity";
  if (sql.includes("income_excl_tax_local")) return "shipmentAmount";
  if (sql.includes("material_name")) return "materialName";
  return record.catalogId ?? (record.request.path.endsWith("/sql/execute") ? "sql" : undefined);
}

async function upstreamRequests(page, from, to) {
  const response = await page.request.post("/api/gea-proof/api-log/snapshot", {
    data: {},
    timeout: 15_000,
  });
  assert.equal(response.status(), 200, "Upstream log unavailable");
  const payload = await response.json();
  return (payload.value ?? payload).records
    .filter((record) => {
      const start = Date.parse(record.startedAt);
      return start >= from - 5 && start <= to;
    })
    .map((record) => {
      const start = Date.parse(record.startedAt);
      const end = Date.parse(record.endedAt);
      const ids = Object.fromEntries(
        Object.entries({ ...record.request.headers, ...record.response?.headers })
          .filter(
            ([key, value]) =>
              /^x-(?:gea-)?(?:trace|request)-id$/i.test(key) &&
              typeof value === "string" &&
              idPattern.test(value),
          )
          .map(([key, value]) => [key.toLowerCase(), value]),
      );
      const data =
        record.response?.body?.data ??
        record.response?.body?.result ??
        record.response?.body?.value ??
        record.response?.body;
      const rows = data?.rows ?? data?.records ?? data;
      return {
        kind: sqlKind(record),
        path: record.request.path.replace(
          /\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?=\/|$)/gi,
          "/:id",
        ),
        ids,
        start,
        end,
        status: record.response?.status,
        rows: Array.isArray(rows) ? rows.length : undefined,
        outcome: record.outcome,
        cancelled: record.error?.name === "AbortError",
        periodScan:
          record.catalogId === "plans.list" &&
          !record.request.query?.periodId &&
          !record.request.query?.status &&
          !record.request.query?.orderType,
      };
    })
    .filter((record) => record.kind);
}

async function waitForMark(frame, group, name) {
  const marker = await frame.waitForFunction(
    ([group, name]) => window.salesBench?.[group]?.[name],
    [group, name],
    { timeout: uiTimeout },
  );
  try {
    return await marker.jsonValue();
  } finally {
    await marker.dispose();
  }
}

async function renderedAt(frame, selector) {
  const marker = await frame.waitForFunction(
    (selector) => {
      if (document.querySelector(selector)?.getClientRects().length) {
        return performance.timeOrigin + performance.now();
      }
    },
    selector,
    { timeout: uiTimeout },
  );
  try {
    return await marker.jsonValue();
  } finally {
    await marker.dispose();
  }
}

async function leaveSales(page) {
  const iframe = page.locator(`iframe[src*="${nativePath}?"]`);
  if (await iframe.isVisible()) {
    await page.getByText("AI工作台", { exact: true }).click({ timeout: uiTimeout });
    await iframe.waitFor({ state: "hidden", timeout: uiTimeout });
  }
}

async function resetRenderer(page) {
  await leaveSales(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: salesButton, exact: true })
    .waitFor({ timeout: uiTimeout });
  assert.equal(
    page.frames().some((frame) => new URL(frame.url()).pathname === nativePath),
    false,
    "Sales renderer remained mounted before the reopen",
  );
}

async function openSales(page, run) {
  const clickFrom = Date.now();
  await page.getByRole("button", { name: salesButton, exact: true }).click({ timeout: uiTimeout });
  run.salesClick = await waitForMark(page, "clicks", "sales");
  assert.ok(run.salesClick >= clickFrom - 5, "Missing fresh Sales Plan click");
  const iframe = page.locator(`iframe[src*="${nativePath}?"]`).first();
  const content = iframe.contentFrame();
  await content.getByTestId("regional-approval-workbench").waitFor({ timeout: uiTimeout });
  const frame = await (await iframe.elementHandle()).contentFrame();
  return { frame, content };
}

async function chooseVolumeScope(content) {
  const month = content.getByRole("combobox", { name: "销售计划周期", exact: true });
  await month.waitFor({ timeout: uiTimeout });
  if (options.month && (await month.innerText()).trim() !== options.month) {
    await month.click({ timeout: uiTimeout });
    await content
      .getByRole("option", { name: options.month, exact: true })
      .click({ timeout: uiTimeout });
  }
  const type = content.getByRole("tab", { name: options["plan-type"], exact: true });
  if ((await type.getAttribute("aria-selected")) !== "true")
    await type.click({ timeout: uiTimeout });
  return (await month.innerText()).trim();
}

function relative(record, origin, done) {
  const { start, end, ...details } = record;
  return {
    ...details,
    startMs: delta(start, origin),
    endMs: delta(end, origin),
    durationMs: delta(end ?? done, start),
  };
}

function stat(samples, metric) {
  const qualified = metric === "listVisibleMs" ? "listQualified" : "skuQualified";
  const sorted = samples
    .filter((sample) => sample[qualified] && sample[metric] !== null)
    .map((sample) => sample[metric])
    .sort((a, b) => a - b);
  const n = sorted.length;
  const withinBudget = sorted.filter((value) => value <= budgetMs).length;
  return {
    measured: n,
    attempts: samples.length,
    withinBudget,
    median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
  };
}

async function measure(page, capture, scenario, attempt) {
  const run = { scenario, attempt, errors: [] };
  const from = Date.now();
  let frame,
    content,
    phase = "open";
  try {
    ({ frame, content } = await openSales(page, run));
    phase = "list visible";
    run.listAt = await renderedAt(frame, listRow);
    run.listVisibleMs = delta(run.listAt, run.salesClick);
    if (scenario === "volume") {
      phase = "volume scope";
      await content
        .locator('[data-sales-plan-shipments="settled"]')
        .waitFor({ timeout: uiTimeout });
      run.month = await chooseVolumeScope(content);
      run.planType = options["plan-type"];
      await content
        .locator('[data-sales-plan-shipments="settled"]')
        .waitFor({ timeout: uiTimeout });
      await content.locator(listRow).first().waitFor({ timeout: uiTimeout });
    } else {
      run.month = (
        await content.getByRole("combobox", { name: "销售计划周期", exact: true }).innerText()
      ).trim();
    }
    phase = "SKU tab click";
    await content.getByRole("tab", { name: skuLabel, exact: true }).click({ timeout: uiTimeout });
    run.skuClick = await waitForMark(frame, "clicks", "sku");
    phase = "SKU usable";
    run.skuAt = await renderedAt(
      frame,
      `section[aria-label="${skuLabel}"][aria-busy="false"]:has([role="combobox"][aria-label="大类"][aria-disabled="false"]) tbody tr`,
    );
    run.skuFromOpenMs = delta(run.skuAt, run.salesClick);
    run.skuFromTabMs = delta(run.skuAt, run.skuClick);
    phase = "list shipment completion";
    await content.locator('[data-sales-plan-shipments="settled"]').waitFor({ timeout: uiTimeout });
  } catch (error) {
    run.errors.push(`${phase}: ${safeError(error)}`);
  }
  const to = Date.now();
  const origin = run.salesClick ?? from;
  await Promise.all(capture.jobs);
  const records = capture.records.filter((record) => record.start >= from && record.start <= to);
  const list = records.filter((record) => record.kind === "list" && !record.summary);
  const sku = records.filter(
    (record) => record.kind === "skuReview" && run.skuClick && record.start >= run.skuClick - 5,
  );
  const periods = records.filter((record) => record.kind === "periods");
  const period = periods[0];
  run.periodReadAt = period?.end ?? null;
  run.plans = new Set(
    sku.filter((record) => record.ok && record.http === 200).map((record) => record.plan),
  ).size;
  const skuCompleted =
    sku.length > 0 &&
    sku.every(
      (record) =>
        record.http === 200 && record.ok && !record.shipmentUnavailable && !record.receiptError,
    );
  if (!skuCompleted) run.errors.push("Required SKU responses missing, unavailable, or failed");
  const upstream = await upstreamRequests(page, origin, to).catch((error) => {
    run.errors.push(safeError(error));
    return [];
  });
  const scans = upstream.filter(
    (record) =>
      record.periodScan &&
      period?.end &&
      record.start >= period.start - 5 &&
      record.start <= period.end,
  );
  run.periodScans = scans.length;
  run.periodIndexReuseRequested = period?.indexReuseRequested ?? false;
  const periodQualified =
    period?.ok &&
    period.rows > 0 &&
    run.periodIndexReuseRequested &&
    (scenario !== "expired" || scans.some((record) => record.status === 200 && !record.cancelled));
  if (!periodQualified) {
    run.errors.push("Period read missing, or expired index did not scan upstream");
  }
  const receipts =
    frame && !frame.isDetached() ? await browserListReceipts(frame).catch(() => []) : [];
  for (const request of list) {
    const index = receipts.findIndex((receipt) => receipt.key === request.listKey);
    if (index < 0) continue;
    const [receipt] = receipts.splice(index, 1);
    Object.assign(request, {
      http: receipt.http,
      consumed: Boolean(receipt.end && receipt.result?.ok),
      rows: receipt.result?.rows,
      partialRows: receipt.partialRows,
      pendingValuesValid: receipt.pendingValuesValid,
      end: receipt.end ?? request.end,
    });
  }
  run.visibleListRows = list.reduce(
    (total, record) => total + (record.partialRows ?? record.rows ?? 0),
    0,
  );
  const listCompleted =
    run.visibleListRows > 0 &&
    list.length > 0 &&
    list.every(
      (record) => record.http === 200 && record.consumed && record.pendingValuesValid !== false,
    );
  if (!listCompleted) run.errors.push("Required list responses missing, failed, or not consumed");
  const history = upstream.filter(
    (record) => record.kind === "skuHistory" && record.status === 200 && !record.cancelled,
  );
  if (!history.length) {
    run.errors.push("No successful upstream SKU history query for this action");
  }
  if (scenario === "volume" && run.plans < minimumPlans)
    run.errors.push(`Volume coverage ${run.plans}/${minimumPlans}`);
  run.listVisibleMs ??= null;
  run.skuFromOpenMs ??= null;
  run.skuFromTabMs ??= null;
  const volumeQualified = scenario !== "volume" || run.plans >= minimumPlans;
  run.listQualified = Boolean(run.listAt && periodQualified && listCompleted && volumeQualified);
  run.skuQualified = Boolean(
    run.skuAt && periodQualified && skuCompleted && history.length && volumeQualified,
  );
  run.cancelled = records.filter((record) => record.cancelled && !record.consumed).length;
  run.failedUpstream = upstream.filter(
    (record) => record.outcome === "error" && !record.cancelled,
  ).length;
  run.network = records
    .map(({ request, plan: _plan, listKey: _listKey, ...record }) => {
      const timing = request.timing();
      return relative(
        {
          ...record,
          method: request.method(),
          ttfbMs: timing.responseStart >= 0 ? number(timing.responseStart) : null,
        },
        origin,
        to,
      );
    })
    .sort((a, b) => a.startMs - b.startMs);
  run.upstream = upstream
    .map((record) => relative(record, origin, to))
    .sort((a, b) => a.startMs - b.startMs);
  run.overBudget = [
    ["listVisibleMs", run.salesClick, run.listAt],
    [
      scenario === "volume" ? "skuFromTabMs" : "skuFromOpenMs",
      scenario === "volume" ? run.skuClick : run.salesClick,
      run.skuAt,
    ],
  ]
    .filter(([metric, click]) => click && (run[metric] == null || run[metric] > budgetMs))
    .map(([metric, click, ready]) => {
      const cutoff = delta(ready ?? to, origin);
      const relevant = [
        ...run.network.filter(
          (record) =>
            record.kind ||
            /\/api\/(agent-manage|session|agentPresets|workspace)\//.test(record.path),
        ),
        ...run.upstream,
      ].filter(
        (record) => record.startMs <= cutoff && (record.endMs ?? cutoff) >= delta(click, origin),
      );
      return {
        metric,
        deadlineMs: delta(click + budgetMs, origin),
        waitingAtDeadline: relevant.filter(
          (record) =>
            record.startMs <= delta(click + budgetMs, origin) &&
            (record.endMs ?? cutoff) >= delta(click + budgetMs, origin),
        ),
        longest: relevant.sort((a, b) => b.durationMs - a.durationMs).slice(0, 5),
      };
    });
  return run;
}

const output = {
  startedAt: new Date().toISOString(),
  budgetMs,
  expiryWaitMs,
  cpu: availableParallelism(),
  startLoad: loadavg(),
  minimumPlans,
  runs: [],
  summary: {},
};
await writeFile(options.out, JSON.stringify(output, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const { chromium } = await import("@playwright/test");
const browser = await chromium.launch({ headless: true });
async function save(run) {
  output.runs.push(run);
  const samples = output.runs.filter((sample) => sample.scenario === run.scenario);
  output.summary[run.scenario] = Object.fromEntries(
    ["listVisibleMs", "skuFromOpenMs", "skuFromTabMs"].map((metric) => [
      metric,
      stat(samples, metric),
    ]),
  );
  await writeFile(options.out, JSON.stringify(output, null, 2) + "\n");
  console.log(
    JSON.stringify({
      attempt: run.attempt,
      scenario: run.scenario,
      listMs: run.listVisibleMs,
      skuFromOpenMs: run.skuFromOpenMs,
      skuFromTabMs: run.skuFromTabMs,
      plans: run.plans,
      scans: run.periodScans,
      errors: run.errors,
    }),
  );
}

try {
  for (let attempt = 1; attempt <= repeatCount; attempt++) {
    if (options.restart) await execFile("bash", [options.restart], { timeout: 45_000 });
    const url = await launchUrl();
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1464, height: 874 },
      baseURL: new URL(url).origin,
    });
    try {
      await context.addInitScript(installClickClock, { sku: skuLabel, queryPath });
      const page = await context.newPage();
      const network = networkCapture(page);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const welcome = page.getByRole("button", { name: /^(Continue|继续)$/ });
      if (await welcome.isVisible()) await welcome.click();
      assert.equal(
        page.frames().some((frame) => new URL(frame.url()).pathname === nativePath),
        false,
        "Use an isolated client that starts outside Sales Plan",
      );
      if (selected.includes("first")) {
        const run = await measure(page, network, "first", attempt);
        await save(run);
      }
      if (selected.includes("expired")) {
        if (!selected.includes("first")) await measure(page, network, "first", attempt);
        await resetRenderer(page);
        const started = Date.now();
        await delay(expiryWaitMs);
        const run = await measure(page, network, "expired", attempt);
        run.waitedAfterLeaveMs = run.salesClick ? delta(run.salesClick, started) : null;
        await save(run);
      }
      if (selected.includes("volume")) {
        await resetRenderer(page);
        await save(await measure(page, network, "volume", attempt));
      }
    } finally {
      await context.close();
    }
  }
} catch (error) {
  output.harnessError = safeError(error);
  console.error(output.harnessError);
} finally {
  await browser.close();
  output.endLoad = loadavg();
  await writeFile(options.out, JSON.stringify(output, null, 2) + "\n");
}
if (output.harnessError || output.runs.some((run) => run.errors.length || run.overBudget.length))
  process.exitCode = 1;
