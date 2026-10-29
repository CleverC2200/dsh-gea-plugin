import {
  brotliCompress,
  brotliDecompressSync,
  constants,
  gzip,
  gunzipSync,
} from "node:zlib";
import { promisify } from "node:util";

const limit = 20_000_000;
const compressGzip = promisify(gzip);
const compressBrotli = promisify(brotliCompress);
function columns(value: any): any {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const first = value[0];
    if (
      value.length > 1 &&
      first &&
      typeof first === "object" &&
      !Array.isArray(first)
    ) {
      const keys = Object.keys(first),
        signature = JSON.stringify(keys);
      if (
        keys.length &&
        value.every(
          (row) =>
            row &&
            typeof row === "object" &&
            !Array.isArray(row) &&
            JSON.stringify(Object.keys(row)) === signature,
        )
      )
        return [
          "t",
          keys,
          keys.map((key) => value.map((row) => columns(row[key]))),
        ];
    }
    return ["a", value.map(columns)];
  }
  const keys = Object.keys(value);
  return ["o", keys, keys.map((key) => columns(value[key]))];
}
function expand(value: any, depth = 0): any {
  if (depth > 128) throw Error("ORDER_REPORT_FORMAT_INVALID");
  if (!Array.isArray(value)) {
    if (value !== null && typeof value === "object")
      throw Error("ORDER_REPORT_FORMAT_INVALID");
    return value;
  }
  const [tag, keys, values] = value;
  if (tag === "a" && value.length === 2 && Array.isArray(keys))
    return keys.map((item) => expand(item, depth + 1));
  if (
    value.length !== 3 ||
    !["o", "t"].includes(tag) ||
    !Array.isArray(keys) ||
    !Array.isArray(values) ||
    keys.length !== values.length ||
    keys.some((key) => typeof key !== "string") ||
    new Set(keys).size !== keys.length
  )
    throw Error("ORDER_REPORT_FORMAT_INVALID");
  if (tag === "o")
    return Object.fromEntries(
      keys.map((key, index) => [key, expand(values[index], depth + 1)]),
    );
  const length = values[0]?.length ?? 0;
  if (
    values.some((column) => !Array.isArray(column) || column.length !== length)
  )
    throw Error("ORDER_REPORT_FORMAT_INVALID");
  return Array.from({ length }, (_, row) =>
    Object.fromEntries(
      keys.map((key, index) => [key, expand(values[index][row], depth + 1)]),
    ),
  );
}

/** Column grouping is lossless: preserve every field, row, order, null and numeric value. */
export async function encodeOrderReport(json: string, targetBytes = 60_000) {
  if (Buffer.byteLength(json) > limit) throw Error("ORDER_REPORT_TOO_LARGE");
  const legacy = JSON.stringify({
    encoding: "gzip-base64",
    data: (await compressGzip(json)).toString("base64"),
  });
  if (Buffer.byteLength(legacy) < 60_000) return legacy;
  const input = Buffer.from(JSON.stringify(columns(JSON.parse(json))));
  let best = legacy;
  for (const quality of [9, 11]) {
    const data = (
      await compressBrotli(input, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: quality,
          [constants.BROTLI_PARAM_LGWIN]: 24,
        },
      })
    ).toString("base64");
    const encoded = JSON.stringify({ encoding: "br-columns-v1", data });
    if (encoded.length < best.length) best = encoded;
    if (Buffer.byteLength(best) <= targetBytes) break;
  }
  return best;
}
export function decodeOrderReport(json: string) {
  const envelope = JSON.parse(json);
  if (typeof envelope.data !== "string")
    throw Error("ORDER_REPORT_FORMAT_INVALID");
  const bytes = Buffer.from(envelope.data, "base64");
  const report =
    envelope.encoding === "gzip-base64"
      ? JSON.parse(
          gunzipSync(bytes, { maxOutputLength: limit }).toString("utf8"),
        )
      : envelope.encoding === "br-columns-v1"
        ? expand(
            JSON.parse(
              brotliDecompressSync(bytes, { maxOutputLength: limit }).toString(
                "utf8",
              ),
            ),
          )
        : undefined;
  if (!report || Buffer.byteLength(JSON.stringify(report)) > limit)
    throw Error("ORDER_REPORT_FORMAT_INVALID");
  return report;
}
