import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Parsed business numbers retain their lexical value, including unsafe IDs and decimal precision. */
export function exactResult(text: string): unknown {
  return JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === "number" &&
    (!Number.isSafeInteger(value) || /[.eE]/.test(context?.source ?? ""))
      ? (context?.source ?? String(value))
      : value,
  );
}

/** Host retry/batch envelopes must not smuggle another consumer's historical data into a new grant. */
export function withoutHistoricalEvidence(text: string): string {
  if (!text.includes("availableEvidence")) return text;
  let changed = false;
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (typeof value === "string" && value.includes("availableEvidence")) {
      try {
        return JSON.stringify(clean(exactResult(value)));
      } catch {
        return value;
      }
    }
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (
      typeof record.source === "string" &&
      record.source.startsWith("GEA_") &&
      "availableEvidence" in record
    ) {
      delete record.availableEvidence;
      changed = true;
    }
    // Envelope paths only; do not rewrite business rows or user-provided JSON columns.
    for (const key of ["results", "result", "content", "text"])
      if (key in record) record[key] = clean(record[key]);
    return record;
  };
  try {
    const value = clean(exactResult(text));
    return changed ? JSON.stringify(value) : text;
  } catch {
    return text;
  }
}

/** Reduce at record boundaries; the original is always separately recoverable. */
export function projectEvidence(
  text: string,
  evidenceId: string,
  limit = 6000,
  view?: unknown,
): string {
  if (text.length <= limit) return text;
  let data: unknown;
  try {
    data = view ?? exactResult(text);
  } catch {
    data = undefined;
  }
  const omitted: string[] = [];
  if (view !== undefined) {
    const fullView = JSON.stringify({
      evidenceId,
      projection: "complete",
      data: view,
      note: "已展示本次收到的结构化内容；数据是否全量以来源覆盖信息为准。",
    });
    if (fullView.length <= limit) return fullView;
  }
  const bounded = (value: unknown, path: string, depth: number): unknown => {
    if (depth > 12) {
      omitted.push(path);
      return "[读取原产物查看此部分]";
    }
    if (Array.isArray(value)) {
      if (value.length > 3) omitted.push(path);
      return value
        .slice(0, 3)
        .map((item, i) => bounded(item, `${path}[${i}]`, depth + 1));
    }
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          bounded(item, `${path}.${key}`, depth + 1),
        ]),
      );
    if (typeof value === "string" && value.length > 800) {
      omitted.push(path);
      return value.slice(0, 800) + "…";
    }
    return value;
  };
  const preview =
    data === undefined ? { text: text.slice(0, 2500) } : bounded(data, "$", 0);
  const result = {
    evidenceId,
    projection: "partial",
    totalChars: text.length,
    nextOffset: 0,
    nextRead: {
      tool: "gea_evidence_read",
      args: { evidenceId, offset: 0, limit: 4000 },
    },
    note: "仅为结果投影，不是完整明细，不能据此重算全量。完整正文用 gea_evidence_read 按原 evidenceId 续读；不要重跑查询。",
    omittedPaths: omitted.slice(0, 30),
    data: preview,
  };
  if (
    preview &&
    typeof preview === "object" &&
    !Array.isArray(preview) &&
    !Object.keys(result).some((key) => key in preview)
  ) {
    const compatible = { ...preview, ...result };
    delete (compatible as Record<string, unknown>).data;
    if (JSON.stringify(compatible).length <= limit)
      return JSON.stringify(compatible);
  }
  if (JSON.stringify(result).length <= limit) return JSON.stringify(result);
  return JSON.stringify({ ...result, data: undefined, omittedPaths: ["$"] });
}

/** Content-addressed per identity/session, bounded in memory; files hold the original for review. */
export type EvidenceGrant = {
  owner: string;
  kind?: "mcp" | "local";
  consumer?: string;
  resourceTool?: string;
  resources?: string;
  query?: Record<string, unknown>;
  valueHash?: string;
  ephemeral?: string;
  computation?: { inputHash: string; version: string };
};
type EvidenceRecord = {
  scope: string;
  revision: number;
  tool: string;
  length: number;
  at: number;
  digest: string;
  grant?: EvidenceGrant;
};
export class PromptEvidenceStore {
  private revision = 0;
  private readonly records = new Map<string, EvidenceRecord>();
  private readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  clear(): void {
    this.revision++;
    this.records.clear();
  }
  epoch(): number {
    return this.revision;
  }
  async put(
    scope: string,
    tool: string,
    text: string,
    revision = this.revision,
    grant?: EvidenceGrant,
  ): Promise<string> {
    if (revision !== this.revision)
      throw Error("GEA_EVIDENCE_IDENTITY_CHANGED");
    if (Buffer.byteLength(text) > 8_000_000)
      throw Error("GEA_EVIDENCE_TOO_LARGE");
    const digest = createHash("sha256").update(text).digest("hex");
    const id =
      "ev-" +
      createHash("sha256")
        .update(
          `${scope}\0${revision}\0${tool}\0${JSON.stringify(grant)}\0${digest}`,
        )
        .digest("hex")
        .slice(0, 24);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(join(this.directory, id + ".txt"), text, { mode: 0o600 });
    if (revision !== this.revision)
      throw Error("GEA_EVIDENCE_IDENTITY_CHANGED");
    const record = {
      scope,
      revision,
      tool,
      length: text.length,
      at: Date.now(),
      digest,
      grant,
    };
    await writeFile(
      join(this.directory, id + ".json"),
      JSON.stringify(record),
      { mode: 0o600 },
    );
    if (revision !== this.revision)
      throw Error("GEA_EVIDENCE_IDENTITY_CHANGED");
    this.records.set(id, record);
    while (this.records.size > 128)
      this.records.delete(this.records.keys().next().value!);
    return id;
  }
  async read(
    scope: string,
    id: string,
    offset = 0,
    limit = 4000,
    authorize?: (grant: EvidenceGrant, tool: string) => Promise<void>,
    render?: (raw: string) => Record<string, unknown>,
  ) {
    if (!/^ev-[a-f0-9]{24}$/.test(id)) throw Error("GEA_EVIDENCE_UNAVAILABLE");
    let record = this.records.get(id);
    const revision = this.revision;
    if (!record && authorize) {
      try {
        record = JSON.parse(
          await readFile(join(this.directory, id + ".json"), "utf8"),
        );
      } catch {
        /* Unknown reference stays unavailable. */
      }
    }
    if (
      !record ||
      record.scope !== scope ||
      (!record.grant && record.revision !== revision) ||
      !Number.isFinite(record.at) ||
      Date.now() - record.at > 30 * 60_000
    )
      throw Error(
        "GEA_EVIDENCE_UNAVAILABLE: 引用已失效或不属于当前会话，请重新核对来源。",
      );
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 6000
    )
      throw Error("GEA_EVIDENCE_RANGE: offset >= 0；limit 为 1–6000。");
    if (record.grant) {
      if (!authorize) throw Error("GEA_EVIDENCE_AUTHORIZATION_REQUIRED");
      await authorize(record.grant, record.tool);
    }
    const text = await readFile(join(this.directory, id + ".txt"), "utf8");
    if (revision !== this.revision)
      throw Error("GEA_EVIDENCE_IDENTITY_CHANGED");
    if (createHash("sha256").update(text).digest("hex") !== record.digest)
      throw Error("GEA_EVIDENCE_CORRUPT");
    if (render) return { evidenceId: id, tool: record.tool, ...render(text) };
    return {
      evidenceId: id,
      tool: record.tool,
      projection: offset === 0 && text.length <= limit ? "complete" : "partial",
      offset,
      totalChars: text.length,
      nextOffset: offset + limit < text.length ? offset + limit : null,
      nextRead:
        offset + limit < text.length
          ? {
              tool: "gea_evidence_read",
              args: { evidenceId: id, offset: offset + limit, limit },
            }
          : null,
      content: text.slice(offset, offset + limit),
    };
  }
}
