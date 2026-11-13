import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const text = z.string().min(1).max(256);
const record = z.record(z.string(), z.unknown());
const stateSchema = z.object({
  tasks: z.array(record).max(10000),
  runs: z.array(record).max(10000),
  events: z.array(record).max(10000),
});
const inputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("load") }).strict(),
  z.object({ operation: z.literal("save"), state: stateSchema, expectedRevision: text }).strict(),
]);
type Owner = {
  key: string;
  environment: string;
  tenantId: string | null;
  id: string;
  username: string;
  name: string;
};
type Execute = (
  sql: string,
  parameters: Record<string, unknown>,
  requestId: string,
) => Promise<unknown>;
const envelope = z.object({ success: z.literal(true), result: record });
const sqlRow = z.object({ id: text, payload: z.string() }).passthrough();
function parsePayload(value: string) {
  return record.parse(JSON.parse(value));
}
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const revision = (state: z.infer<typeof stateSchema>) =>
  hash(
    Object.fromEntries(
      Object.entries(state).map(([key, rows]) => [
        key,
        [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id))),
      ]),
    ),
  );
const owns = (task: Record<string, unknown>, owner: Owner) =>
  record.safeParse(task.owner).success && record.parse(task.owner).key === owner.key;
function fail(code: string, message: string): never {
  throw Object.assign(Error(message), { code });
}

export async function warningStorage(owner: Owner, input: unknown, execute: Execute) {
  const request = inputSchema.parse(input);
  async function sql(statement: string, parameters: Record<string, unknown> = {}) {
    const id =
      "warning-" +
      (statement.startsWith("SELECT") ? randomUUID() : hash([owner.key, statement, parameters]));
    const raw = await execute(statement, parameters, id);
    const reply = envelope.safeParse(raw);
    if (!reply.success)
      return fail("WARNING_SQL_REQUEST_FAILED", "预警白名单请求失败，未回退数据库直连");
    return reply.data.result;
  }
  async function read(
    table: string,
    order: string,
    where = "",
    parameters: Record<string, unknown> = {},
  ) {
    const result: Record<string, unknown>[] = [];
    for (let offset = 0; offset < 10000; offset += 200) {
      const page = await sql(
        `SELECT t.id AS id, CAST(t.payload AS TEXT) AS payload FROM ${table} AS t${where} ORDER BY ${order} LIMIT :gea_p199 OFFSET :gea_p200`,
        { ...parameters, gea_p199: 200, gea_p200: offset },
      );
      const rows = z.array(sqlRow).parse(page.records ?? page.rows);
      result.push(
        ...rows.map((item) => {
          const payload = parsePayload(item.payload);
          if (payload.id !== item.id) fail("WARNING_RECORD_INVALID", "预警记录标识与正文不一致");
          return payload;
        }),
      );
      if (rows.length < 200) return result;
    }
    return fail("WARNING_READ_LIMIT", "预警记录超过本次读取上限");
  }
  const allTasks = await read("detection_tasks", "t.id");
  const tasks = allTasks.filter((task) => owns(task, owner));

  const runs: Record<string, unknown>[] = [],
    events: Record<string, unknown>[] = [];
  for (let offset = 0; offset < tasks.length; offset += 100) {
    const subset = tasks.slice(offset, offset + 100);
    const parameters = Object.fromEntries(
      subset.map((item, i) => ["gea_p" + (i + 1), text.parse(item.id)]),
    );
    const within = Object.keys(parameters)
      .map((name) => ":" + name)
      .join(", ");
    runs.push(
      ...(await read("detection_runs", "t.id", ` WHERE t.task_id IN (${within})`, parameters)),
    );
    events.push(
      ...(await read("warning_events", "t.id", ` WHERE t.task_id IN (${within})`, parameters)),
    );
  }
  const observed = new Set<string>();
  for (let offset = 0; offset < events.length; offset += 100) {
    const subset = events.slice(offset, offset + 100);
    const parameters = Object.fromEntries(
      subset.map((item, i) => ["gea_p" + (i + 1), text.parse(item.id)]),
    );
    const within = Object.keys(parameters)
      .map((name) => ":" + name)
      .join(", ");
    for (let pageOffset = 0; pageOffset < 10000; pageOffset += 200) {
      const result = await sql(
        `SELECT o.event_id AS event_id, o.run_id AS run_id, CAST(o.payload AS TEXT) AS payload FROM warning_observations AS o WHERE o.event_id IN (${within}) ORDER BY o.event_id, o.run_id LIMIT :gea_p199 OFFSET :gea_p200`,
        { ...parameters, gea_p199: 200, gea_p200: pageOffset },
      );
      const rows = z
        .array(z.object({ event_id: text, run_id: text, payload: z.string() }))
        .parse(result.records ?? result.rows);
      for (const row of rows) {
        const observation = parsePayload(row.payload);
        if (observation.runId !== row.run_id)
          fail("WARNING_RECORD_INVALID", "预警观测标识与正文不一致");
        observed.add(JSON.stringify([row.event_id, row.run_id]));
        const event = events.find((item) => item.id === row.event_id);
        if (!event) fail("WARNING_OWNER_DENIED", "预警观测不属于当前用户");
        const history = z.array(record).parse(event.history ?? []);
        if (!history.some((item) => item.runId === row.run_id))
          event.history = [...history, observation];
      }
      if (rows.length < 200) break;
      if (pageOffset === 9800) fail("WARNING_READ_LIMIT", "预警观测超过本次读取上限");
    }
  }
  async function saveObservations(items: Record<string, unknown>[]) {
    for (const item of items)
      for (const h of z.array(record).parse(item.history ?? [])) {
        const runId = text.parse(h.runId);
        const key = JSON.stringify([item.id, runId]);
        if (observed.has(key)) continue;
        await sql(
          "INSERT INTO warning_observations (event_id, run_id, payload) VALUES (:gea_p1, :gea_p2, CAST(:gea_p3 AS JSONB))",
          { gea_p1: item.id, gea_p2: runId, gea_p3: canonical(h) },
        );
        observed.add(key);
      }
  }
  const current = { tasks, runs, events };
  if (request.operation === "load") return { ...current, revision: revision(current) };
  const incoming = request.state;
  if (revision(current) === revision(incoming)) {
    await saveObservations(incoming.events);
    return { saved: true, revision: revision(current) };
  }
  if (request.expectedRevision !== revision(current))
    fail("WARNING_WRITE_CONFLICT", "预警已被其他会话修改，请重新读取");
  for (const item of incoming.tasks) {
    if (!owns(item, owner)) fail("WARNING_OWNER_DENIED", "不能修改其他用户的预警任务");
    const prior = allTasks.find((old) => old.id === item.id);
    if (prior && !owns(prior, owner)) fail("WARNING_OWNER_DENIED", "预警任务不属于当前用户");
  }
  for (const key of ["tasks", "runs", "events"] satisfies (keyof typeof current)[]) {
    const ids = incoming[key].map((item) => text.parse(item.id));
    if (new Set(ids).size !== ids.length) fail("WARNING_STATE_INVALID", "预警保存包含重复记录");
    if (current[key].some((item) => !ids.includes(text.parse(item.id))))
      fail("WARNING_STATE_INCOMPLETE", "不能移除已有预警执行记录或历史");
  }
  const incomingIds = new Set(incoming.tasks.map((item) => text.parse(item.id)));
  if (tasks.some((item) => !incomingIds.has(text.parse(item.id))))
    fail("WARNING_STATE_INCOMPLETE", "任务删除须保留历史记录，不能提交不完整状态");
  for (const item of incoming.runs)
    if (!incomingIds.has(text.parse(item.taskId)))
      fail("WARNING_OWNER_DENIED", "执行记录不属于当前用户任务");
  for (const item of incoming.events)
    if (!incomingIds.has(text.parse(item.monitorId)))
      fail("WARNING_OWNER_DENIED", "预警事件不属于当前用户任务");
  async function persist(
    table: string,
    item: Record<string, unknown>,
    prior: Record<string, unknown> | undefined,
    columns: Record<string, unknown>,
  ) {
    const id = text.parse(item.id);
    if (prior && canonical(prior) === canonical(item)) return;
    const values: Record<string, unknown> = { ...columns, payload: canonical(item) };
    const names = Object.keys(values);
    const parameters = Object.fromEntries(
      names.map((name, i) => ["gea_p" + (i + 1), values[name]]),
    );
    const placeholders = names.map((name, i) =>
      name === "payload"
        ? `CAST(:gea_p${i + 1} AS JSONB)`
        : ["started_at", "first_triggered_at"].includes(name)
          ? `CAST(:gea_p${i + 1} AS TIMESTAMPTZ)`
          : `:gea_p${i + 1}`,
    );
    let result;
    if (!prior) {
      result = await sql(
        `INSERT INTO ${table} (${names.join(", ")}) VALUES (${placeholders.join(", ")})`,
        parameters,
      );
    } else {
      parameters.gea_p199 = canonical(prior);
      parameters.gea_p200 = id;
      const assignments = names
        .filter((name) => name !== "id")
        .map((name) => `${name} = ${placeholders[names.indexOf(name)]}`);
      delete parameters["gea_p" + (names.indexOf("id") + 1)];
      result = await sql(
        `UPDATE ${table} SET ${assignments.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = :gea_p200 AND payload = CAST(:gea_p199 AS JSONB)`,
        parameters,
      );
    }
    if (Number(result.affectedRows) !== 1)
      fail("WARNING_WRITE_CONFLICT", "预警保存发生冲突，请重新读取后再修改");
  }
  for (const item of incoming.tasks)
    await persist(
      "detection_tasks",
      item,
      tasks.find((old) => old.id === item.id),
      {
        id: item.id,
        metric_name: text.parse(item.metric),
        scope_type: text.parse(item.scope),
        xxl_job_id: item.jobId ?? null,
        enabled: z.boolean().parse(item.enabled),
      },
    );
  for (const item of incoming.runs)
    await persist(
      "detection_runs",
      item,
      runs.find((old) => old.id === item.id),
      {
        id: item.id,
        task_id: item.taskId,
        run_key: text.parse(item.runKey),
        status: text.parse(item.status),
        started_at: text.parse(item.at),
        session_id: item.sessionId ?? null,
      },
    );
  for (const item of [...incoming.events].sort(
    (a, b) => Number(a.eventStatus === "活跃") - Number(b.eventStatus === "活跃"),
  )) {
    await persist(
      "warning_events",
      item,
      events.find((old) => old.id === item.id),
      {
        id: item.id,
        task_id: item.monitorId,
        dedup_key: text.parse(item.monitorKey),
        object_key: text.parse(item.objectKey),
        risk_level: text.parse(item.level),
        event_status: text.parse(item.eventStatus),
        first_triggered_at: text.parse(item.first),
      },
    );
  }
  await saveObservations(incoming.events);
  return { saved: true, revision: revision(incoming) };
}
