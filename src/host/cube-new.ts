import { createHash } from "node:crypto";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Reject incomplete member references without guessing or changing the published mapping. */
export function validateCubeQueryMembers(arguments_: Record<string, unknown>): void {
  const check = (member: unknown, path: string) => {
    if (
      typeof member !== "string" ||
      /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(member)
    )
      return;
    throw Object.assign(
      Error(
        `GEA_CUBE_QUERY_MEMBER_REQUIRED: ${path} 必须使用 inspect_cube_model 返回的完整 aliasMember，不使用裸字段名、View 成员或猜测的模型前缀。先核对实际模型说明，再修正参数。`,
      ),
      { code: "GEA_CUBE_QUERY_MEMBER_REQUIRED", category: "VALIDATION", retryable: false },
    );
  };
  const filter = (value: unknown, path: string) => {
    const item = object(value);
    if (!item) return;
    check(item.member, `${path}.member`);
    for (const key of ["and", "or"])
      if (Array.isArray(item[key]))
        item[key].forEach((child, index) => filter(child, `${path}.${key}[${index}]`));
  };
  if (!Array.isArray(arguments_.queries)) return;
  arguments_.queries.forEach((value, index) => {
    const query = object(object(value)?.query);
    if (!query) return;
    const path = `queries[${index}].query`;
    for (const key of ["measures", "dimensions", "segments"])
      if (Array.isArray(query[key]))
        query[key].forEach((member, index) => check(member, `${path}.${key}[${index}]`));
    if (Array.isArray(query.timeDimensions))
      query.timeDimensions.forEach((item, index) =>
        check(object(item)?.dimension, `${path}.timeDimensions[${index}].dimension`),
      );
    if (Array.isArray(query.filters))
      query.filters.forEach((item, index) => filter(item, `${path}.filters[${index}]`));
    if (Array.isArray(query.order))
      query.order.forEach((item, index) => {
        if (Array.isArray(item)) check(item[0], `${path}.order[${index}]`);
      });
    else {
      const order = object(query.order);
      if (order) Object.keys(order).forEach((key) => check(key, `${path}.order`));
    }
  });
}

export function cubeQueryResultError(
  code: string,
  invalidFields: string[],
  datasetName?: unknown,
): Error {
  return Object.assign(
    Error(
      `${code}: GEA 查询响应字段缺失或不符合约定：${invalidFields.join("、")}。这是响应合同问题，不是查询参数错误。本轮停止查询，请核对服务端响应；不换字段重试，也不自行补成完整结果。`,
    ),
    {
      code,
      category: "RESPONSE_CONTRACT",
      retryable: false,
      suggestedAction: "CHECK_RESPONSE_CONTRACT",
      details: {
        datasetName: typeof datasetName === "string" ? datasetName : undefined,
        invalidFields,
      },
    },
  );
}

/** Validate the gateway's original artifact bytes before publishing any business evidence. */
export function cubeNewArtifact(
  result: unknown,
  link: { uri: string; sha256?: string },
  arguments_: unknown,
): string {
  const contents = object(result)?.contents;
  if (!Array.isArray(contents) || contents.length !== 1)
    throw Error("GEA_CUBE_NEW_RESOURCE_CONTENTS");
  const item = object(contents[0]);
  if (
    item?.uri !== link.uri ||
    item.mimeType !== "application/json" ||
    typeof item.text !== "string"
  )
    throw Error("GEA_CUBE_NEW_RESOURCE_IDENTITY");
  const digest = createHash("sha256").update(item.text, "utf8").digest("hex");
  const readHash = object(item._meta)?.sha256;
  if (readHash !== digest || (link.sha256 !== undefined && link.sha256 !== digest))
    throw Error("GEA_CUBE_NEW_RESOURCE_DIGEST");
  validateCubeQueryResult(JSON.parse(item.text), arguments_, "resource");
  return item.text;
}

/** Direct pages use row/pagination evidence; legacy artifacts also require their delivery flags. */
export function validateCubeQueryResult(
  result: unknown,
  arguments_: unknown,
  delivery: "inline" | "resource",
): void {
  const payload = object(result);
  const queries = object(arguments_)?.queries;
  const expected = Array.isArray(queries) ? queries.map((query) => object(query)?.name) : [];
  const datasets = payload?.datasets;
  if (
    payload?.action !== "query" ||
    payload.status !== "completed" ||
    payload.executedQueryCount !== expected.length ||
    !Array.isArray(datasets) ||
    datasets.length === 0 ||
    datasets.length !== expected.length ||
    expected.some((name) => typeof name !== "string") ||
    new Set(expected).size !== expected.length
  )
    throw cubeQueryResultError("GEA_CUBE_NEW_DATASETS", [
      "action/status/executedQueryCount/datasets",
    ]);
  const seen = new Set();
  for (const value of datasets) {
    const dataset = object(value);
    if (!dataset || !expected.includes(dataset.name) || seen.has(dataset.name))
      throw cubeQueryResultError("GEA_CUBE_NEW_DATASET_NAME", ["name"], dataset?.name);
    seen.add(dataset.name);
    const invalidFields = [
      ...(!Array.isArray(dataset.rows)
        ? ["rows"]
        : dataset.rowCount !== dataset.rows.length
          ? ["rowCount"]
          : []),
      ...((delivery === "resource" || Object.hasOwn(dataset, "complete")) &&
      dataset.complete !== true
        ? ["complete"]
        : []),
      ...((delivery === "resource" || Object.hasOwn(dataset, "hasMore")) &&
      dataset.hasMore !== false
        ? ["hasMore"]
        : []),
      ...(Object.hasOwn(dataset, "truncated") && dataset.truncated !== false ? ["truncated"] : []),
      ...(!Array.isArray(dataset.fields) ? ["fields"] : []),
      ...(!["ok", "no_data", "partial"].includes(String(dataset.dataStatus)) ? ["dataStatus"] : []),
    ];
    if (invalidFields.length || !Array.isArray(dataset.rows))
      throw cubeQueryResultError("GEA_CUBE_NEW_PAGE_INCOMPLETE", invalidFields, dataset.name);
    const { offset, totalRowCount, hasMorePages } = dataset;
    if (
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof totalRowCount !== "number" ||
      !Number.isSafeInteger(totalRowCount) ||
      totalRowCount < offset + dataset.rows.length ||
      typeof hasMorePages !== "boolean" ||
      hasMorePages !== offset + dataset.rows.length < totalRowCount ||
      (hasMorePages && dataset.rows.length === 0)
    )
      throw cubeQueryResultError(
        "GEA_CUBE_NEW_PAGE_METADATA",
        ["offset/totalRowCount/hasMorePages"],
        dataset.name,
      );
  }
}
