import { exactResult } from "./prompt-evidence.ts";
import { PERMISSION_NOTICE_PREFIX } from "./mcp-client.ts";
import { parseFirstJsonObject } from "./gateway-catalog.ts";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row =>
  !!value && typeof value === "object" && !Array.isArray(value);
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return exactResult(value);
  } catch {
    return value;
  }
}

export function permissionDenied(text: string): boolean {
  const data = parsed(text);
  if (text.startsWith(PERMISSION_NOTICE_PREFIX)) return true;
  return (
    record(data) &&
    (["no-authorized-resources", "permission-required"].includes(
      String(data.availability),
    ) ||
      (Array.isArray(data.results) &&
        data.results.some(
          (r) =>
            record(r) &&
            (String(r.code).includes("NOT_AUTHORIZED") ||
              (typeof r.result === "string" && permissionDenied(r.result))),
        )))
  );
}
export function resultOutcome(
  text: string,
): "returned" | "partial" | "blocked" {
  const value = parsed(text);
  if (text.startsWith(PERMISSION_NOTICE_PREFIX)) return "blocked";
  if (!record(value)) return "returned";
  if (
    [
      "no-authorized-resources",
      "permission-required",
      "known-gap",
      "channel-stopped",
      "turn-stopped",
    ].includes(String(value.availability))
  )
    return "blocked";
  if (value.source === "GEA_CUBE_BATCH" && Array.isArray(value.results)) {
    const returned = value.results.filter(
      (r) => record(r) && r.status === "returned",
    );
    if (!returned.length) return "blocked";
    return returned.length < value.results.length ||
      returned.some(
        (r) =>
          record(r) &&
          resultOutcome(
            typeof r.result === "string" ? r.result : JSON.stringify(r.result),
          ) !== "returned",
      )
      ? "partial"
      : "returned";
  }
  if (
    value.source === "GEA_MCP_CONTENT" &&
    Array.isArray(value.payloads) &&
    value.payloads.length === 0
  )
    return "blocked";
  if (
    value.source === "GEA_MCP_CONTENT" &&
    record(value.delivery) &&
    value.delivery.sourceReadComplete !== true
  )
    return "partial";
  return "returned";
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : record(v)
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
function tablePage(page: Row): Row {
  if (
    Object.hasOwn(page, "displayTable") ||
    !Array.isArray(page.rows) ||
    page.rows.length < 5 ||
    !page.rows.every(record)
  )
    return page;
  const columns = Object.keys(page.rows[0]);
  if (
    !page.rows.every(
      (row) =>
        Object.keys(row).length === columns.length &&
        columns.every((key) => Object.hasOwn(row, key)),
    )
  )
    return page;
  const { rows, ...rest } = page;
  return {
    ...rest,
    displayTable: {
      columns,
      values: (rows as Row[]).map((row) => columns.map((key) => row[key])),
    },
  };
}

/** Presentation only. The store retains the original bytes; rows and unknown JSON columns are never rewritten. */
export function resultView(value: unknown, depth = 0): unknown {
  if (depth > 10) return value;
  value = parsed(value);
  if (!record(value)) return value;
  if (value.source === "GEA_CUBE_BATCH" && Array.isArray(value.results))
    return {
      ...value,
      results: value.results.map((item) =>
        record(item)
          ? { ...item, result: resultView(item.result, depth + 1) }
          : item,
      ),
    };
  if (value.source === "GEA_MCP_CONTENT" && Array.isArray(value.payloads))
    return {
      source: value.source,
      delivery: value.delivery ?? { sourceReadComplete: null },
      // Missing delivery metadata cannot be upgraded to a complete result.
      ...(!record(value.delivery) ? { presentation: value.presentation } : {}),
      payloads: value.payloads.map((item) => resultView(item, depth + 1)),
    };
  if (
    record(value.queryArtifact) &&
    Array.isArray(value.queryArtifact.resources)
  ) {
    const pages: Row[] = [];
    for (const resource of value.queryArtifact.resources) {
      if (!record(resource) || !Array.isArray(resource.contents)) return value;
      for (const content of resource.contents) {
        if (!record(content)) return value;
        const page = parsed(content.text);
        if (!record(page)) return value;
        const { contents, ...resourceMetadata } = resource;
        const { text, ...contentMetadata } = content;
        pages.push({
          ...page,
          sourceResource: resourceMetadata,
          sourceContent: contentMetadata,
        });
      }
    }
    // Preserve every non-body field, including status/error/coverage; redundant rendered bodies stay in the original.
    const { queryArtifact, ...metadata } = value;
    const { resources, ...artifactMetadata } = queryArtifact as Row;
    if (Array.isArray(metadata.datasets))
      metadata.datasets = metadata.datasets.map((dataset) => {
        if (!record(dataset) || !Array.isArray(dataset.previewRows))
          return dataset;
        const matching = pages.filter(
          (page) => page.datasetName === dataset.name,
        );
        if (
          !matching.length ||
          !matching.every((page) => Array.isArray(page.rows))
        )
          return dataset;
        if (
          JSON.stringify(canonical(dataset.previewRows)) !==
          JSON.stringify(
            canonical(matching.flatMap((page) => page.rows as unknown[])),
          )
        )
          return dataset;
        const { previewRows, ...info } = dataset;
        return { ...info, rowsLocation: "queryArtifact.pages" };
      });
    return {
      ...metadata,
      queryArtifact: { ...artifactMetadata, pages: pages.map(tablePage) },
    };
  }
  return value;
}

/** Unknown/knowledge sources without a reusable authorization receipt get bounded one-time excerpts, never a fake evidence ID. */
export function transientResult(
  text: string,
  limit = 6000,
  knowledge = false,
): string {
  if (text.length <= limit) return text;
  if (knowledge) {
    let payload: unknown = text;
    let sourceComplete = true;
    // LightRAG may wrap JSON in result and append a transport note. Decode only this known envelope.
    try {
      payload = parseFirstJsonObject(text, exactResult);
    } catch {
      sourceComplete = false;
    }
    if (record(payload) && typeof payload.result === "string") {
      const inner = payload.result;
      try {
        payload = exactResult(inner);
      } catch {
        payload = inner;
        sourceComplete = false;
      }
    }
    let chunks: unknown[] =
      record(payload) && Array.isArray(payload.chunks) ? payload.chunks : [];
    if (typeof payload === "string") {
      // Recover complete chunk objects only; never invent a citation for a cut-off object.
      const start = /"chunks"\s*:\s*\[/.exec(payload);
      let cursor = start ? start.index + start[0].length : -1;
      while (cursor >= 0 && chunks.length < 8) {
        while (/\s/.test(payload[cursor] ?? "") && cursor < payload.length)
          cursor++;
        if (payload[cursor] !== "{") break;
        try {
          let consumed = 0;
          const chunk = parseFirstJsonObject(payload.slice(cursor), (text) => {
            consumed = text.length;
            return exactResult(text);
          });
          if (
            !record(chunk) ||
            typeof chunk.chunk_id !== "string" ||
            typeof chunk.content !== "string"
          )
            break;
          chunks.push(chunk);
          cursor += consumed;
          while (/\s/.test(payload[cursor] ?? "") && cursor < payload.length)
            cursor++;
          if (payload[cursor] !== ",") break;
          cursor++;
        } catch {
          break;
        }
      }
    }
    const excerpts: Row[] = [];
    const result: Row = {
      source: "GEA_KNOWLEDGE_EXCERPTS",
      projection: "partial",
      rawAvailable: false,
      sourceComplete,
      totalChars: text.length,
      excerpts,
      note: "仅为当前授权检索的相关片段，不是全文或已确认规则。sourceComplete=false表示源返回本身不完整；需要其它内容应在同一授权知识工具中收窄问题，不能声称已核验全文。",
    };
    for (const chunk of chunks) {
      if (!record(chunk) || typeof chunk.content !== "string") continue;
      const excerpt = {
        chunkId: chunk.chunk_id,
        referenceId: chunk.reference_id,
        documentId: chunk.document_id,
        filePath: chunk.file_path,
        content: chunk.content.slice(0, 1200),
        truncated: chunk.content.length > 1200,
      };
      excerpts.push(excerpt);
      if (JSON.stringify(result).length > limit) {
        excerpts.pop();
        break;
      }
      if (excerpts.length >= 4) break;
    }
    if (excerpts.length) return JSON.stringify(result);
  }
  const result = {
    projection: "partial",
    rawAvailable: false,
    totalChars: text.length,
    note: "仅为当前授权调用的节选，不是全文。需要其它内容请在同一授权工具内收窄问题；没有本地全文回读引用。",
    excerpt: text.slice(0, Math.floor(limit / 2)),
  };
  while (JSON.stringify(result).length > limit && result.excerpt.length)
    result.excerpt = result.excerpt.slice(
      0,
      Math.floor(result.excerpt.length * 0.75),
    );
  return JSON.stringify(result);
}

/** A short, factual receipt. It does not infer business completion from successful transport. */
export function resultReceipt(
  tool: string,
  args: Row,
  id: string,
  raw: string,
): string {
  const data = parsed(raw);
  const facts: Row = { evidenceId: id, tool, outcome: resultOutcome(raw) };
  if (typeof args.kind === "string") facts.kind = args.kind;
  if (record(args.query)) facts.scope = args.query;
  if (Array.isArray(args.queries))
    facts.queries = args.queries
      .map((q) => (record(q) ? q.name : undefined))
      .slice(0, 8);
  if (record(data)) {
    if (data.coverage !== undefined) facts.coverage = data.coverage;
    if (data.availability !== undefined) facts.availability = data.availability;
    if (Array.isArray(data.results))
      facts.results = data.results
        .map((r) =>
          record(r) ? { model: r.model, names: r.names, status: r.status } : r,
        )
        .slice(0, 8);
  }
  const text = JSON.stringify(facts);
  return text.length <= 500
    ? text
    : JSON.stringify({
        evidenceId: id,
        tool,
        outcome: resultOutcome(raw),
        kind: args.kind,
        note: "已有结果，范围查看原回执",
      });
}

type DatasetPage = { key: string; name: string; rows: Row[]; source: Row };
/** Decode only documented envelopes and keep source identity through every batch and artifact. */
function datasetPages(
  raw: unknown,
  depth = 0,
  path = "root",
  provenance: Row = {},
): DatasetPage[] {
  if (depth > 10) return [];
  const value = parsed(raw);
  if (!record(value)) return [];
  if (value.source === "GEA_CUBE_BATCH" && Array.isArray(value.results))
    return value.results.flatMap((r, i) =>
      record(r) && r.status === "returned"
        ? datasetPages(r.result, depth + 1, `${path}/query${i}`, {
            ...provenance,
            model: r.model,
            queryNames: r.names,
            resourceCode: r.resourceCode,
          })
        : [],
    );
  if (value.source === "GEA_MCP_CONTENT" && Array.isArray(value.payloads))
    return value.payloads.flatMap((x, i) =>
      datasetPages(x, depth + 1, `${path}/payload${i}`, {
        ...provenance,
        delivery: value.delivery,
      }),
    );
  if (
    record(value.queryArtifact) &&
    Array.isArray(value.queryArtifact.resources)
  ) {
    const pages: DatasetPage[] = [];
    value.queryArtifact.resources.forEach((resource, i) => {
      if (!record(resource) || !Array.isArray(resource.contents)) return;
      const names = new Map<string, number>();
      for (const c of resource.contents) {
        if (!record(c)) continue;
        const p = parsed(c.text);
        if (!record(p) || !Array.isArray(p.rows) || !p.rows.every(record))
          continue;
        const name = String(p.datasetName ?? resource.datasetName ?? "result");
        if (!names.has(name)) names.set(name, names.size);
        const { rows, ...source } = p;
        pages.push({
          key: `${path}/resource${i}/dataset${names.get(name)}`,
          name,
          rows: rows as Row[],
          source: { ...source, ...provenance, pageCount: resource.pageCount },
        });
      }
    });
    if (pages.length) return pages;
  }
  if (Array.isArray(value.datasets))
    return value.datasets.flatMap((d, i) => {
      if (!record(d)) return [];
      const rows = Array.isArray(d.rows)
        ? d.rows
        : Array.isArray(d.previewRows)
          ? d.previewRows
          : undefined;
      if (!rows?.every(record)) return [];
      const { rows: ignoredRows, previewRows, ...source } = d;
      return [
        {
          key: `${path}/dataset${i}`,
          name: String(d.name ?? d.datasetName ?? "result"),
          rows: rows as Row[],
          source: {
            ...source,
            ...provenance,
            previewOnly: !Array.isArray(d.rows),
          },
        },
      ];
    });
  if (Array.isArray(value.rows) && value.rows.every(record)) {
    const { rows, ...source } = value;
    return [
      {
        key: `${path}/dataset0`,
        name: String(value.datasetName ?? "result"),
        rows: rows as Row[],
        source: { ...source, ...provenance },
      },
    ];
  }
  return [];
}
export function datasetIndex(raw: string, evidenceId: string) {
  const pages = datasetPages(raw);
  const keys = [...new Set(pages.map((p) => p.key))];
  return keys.map((key) => {
    const group = pages.filter((p) => p.key === key);
    return {
      key,
      name: group[0]!.name,
      model: group[0]!.source.model,
      availableRows: group.reduce((n, p) => n + p.rows.length, 0),
      nextRead: {
        tool: "gea_evidence_read",
        args: { evidenceId, dataset: key, rowOffset: 0, rowLimit: 30 },
      },
    };
  });
}
export function indexProjection(
  projected: string,
  evidenceId: string,
  datasets: ReturnType<typeof datasetIndex>,
  limit = 6000,
): string {
  if (!datasets.length) return projected;
  try {
    const display = JSON.parse(projected);
    if (!record(display)) return projected;
    const fields = {
      evidenceId,
      evidenceDatasets: datasets,
      ...(display.projection === "partial"
        ? { nextRead: datasets[0]?.nextRead }
        : {}),
    };
    const combined = JSON.stringify(
      Object.hasOwn(display, "evidenceDatasets")
        ? { data: display, ...fields }
        : { ...display, ...fields },
    );
    if (combined.length <= limit) return combined;
    if (display.projection === "partial") {
      const indexOnly = JSON.stringify({
        ...fields,
        projection: "partial",
        note: "按evidenceDatasets的nextRead读取业务行；原文仍可按offset/limit回读，数据覆盖不等于文件读完。",
      });
      if (indexOnly.length <= limit) return indexOnly;
    }
  } catch {}
  return projected;
}
export function readDataset(
  raw: string,
  evidenceId: string,
  dataset: string,
  rowOffset = 0,
  rowLimit = 30,
): Row {
  if (
    !Number.isSafeInteger(rowOffset) ||
    rowOffset < 0 ||
    !Number.isSafeInteger(rowLimit) ||
    rowLimit < 1 ||
    rowLimit > 100
  )
    throw Error(
      "GEA_EVIDENCE_ROW_RANGE: rowOffset为0起点；rowLimit为1–100，默认30。",
    );
  const all = datasetPages(raw);
  let pages = all.filter((p) => p.key === dataset);
  if (!pages.length) {
    pages = all.filter((p) => p.name === dataset);
    if (new Set(pages.map((p) => p.key)).size > 1)
      throw Error(
        "GEA_EVIDENCE_DATASET_AMBIGUOUS: 同名数据来自不同来源，请使用evidenceDatasets中的唯一key。",
      );
  }
  if (!pages.length)
    throw Error(
      "GEA_EVIDENCE_DATASET_UNAVAILABLE: 请使用原回执列出的dataset名称。",
    );
  const rows = pages.flatMap((p) => p.rows);
  const selected: Row[] = [];
  const wrap = (next: number | null): Row => ({
    dataset: pages[0]!.key,
    name: pages[0]!.name,
    representation: "rows",
    sourceOutcome: resultOutcome(raw),
    rowOffset,
    availableRows: rows.length,
    returnedRows: selected.length,
    sourceCoverage: pages.map((p) => ({ ...p.source, fields: undefined })),
    table: tablePage({ rows: selected }),
    nextRead:
      next === null
        ? null
        : {
            tool: "gea_evidence_read",
            args: {
              evidenceId,
              dataset: pages[0]!.key,
              rowOffset: next,
              rowLimit,
            },
          },
    note: "仅续读本次已收到的结果行，未重新查询；availableRows不是全业务数据量，完整性仍以原查询范围和来源覆盖为准。",
  });
  for (const row of rows.slice(rowOffset, rowOffset + rowLimit)) {
    selected.push(row);
    if (JSON.stringify(wrap(rowOffset + selected.length)).length > 5400) {
      selected.pop();
      break;
    }
  }
  if (!selected.length && rowOffset < rows.length)
    throw Error(
      "GEA_EVIDENCE_ROW_TOO_LARGE: 单行或覆盖说明过大，请按原文offset/limit读取，不要重新查询。",
    );
  return wrap(
    rowOffset + selected.length < rows.length
      ? rowOffset + selected.length
      : null,
  );
}
