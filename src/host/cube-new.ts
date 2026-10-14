import { createHash } from "node:crypto";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

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
  const payload = object(JSON.parse(item.text));
  const queries = object(arguments_)?.queries;
  const expected = Array.isArray(queries) ? queries.map((query) => object(query)?.name) : [];
  const datasets = payload?.datasets;
  if (
    payload?.action !== "query" ||
    payload.status !== "completed" ||
    !Array.isArray(datasets) ||
    datasets.length === 0 ||
    datasets.length !== expected.length ||
    expected.some((name) => typeof name !== "string") ||
    new Set(expected).size !== expected.length
  )
    throw Error("GEA_CUBE_NEW_DATASETS");
  const seen = new Set();
  for (const value of datasets) {
    const dataset = object(value);
    if (!dataset || !expected.includes(dataset.name) || seen.has(dataset.name))
      throw Error("GEA_CUBE_NEW_DATASET_NAME");
    seen.add(dataset.name);
    if (
      !Array.isArray(dataset.rows) ||
      dataset.rowCount !== dataset.rows.length ||
      dataset.complete !== true ||
      dataset.hasMore !== false ||
      dataset.truncated === true ||
      !Array.isArray(dataset.fields) ||
      !["ok", "no_data", "partial"].includes(String(dataset.dataStatus))
    )
      throw Error("GEA_CUBE_NEW_PAGE_INCOMPLETE");
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
      throw Error("GEA_CUBE_NEW_PAGE_METADATA");
  }
  return item.text;
}
