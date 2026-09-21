import {
  createGeaSqlDatabase,
  prepareGeaSql,
  packedRowsSql,
  unpackBusinessRows,
} from "./html-sql.ts";
export function prepareHtmlQuery(input: any) {
  if (!input || typeof input.sql !== "string" || input.sql.length > 200000)
    throw Error("INVALID_QUERY");
  const bare = input.sql.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\r\n]*|\/\*[\s\S]*?\*\//g,
    " ",
  );
  if (
    /\b(INTO|DO|EXECUTE|SET|RESET|VACUUM|ANALYZE|LOCK|pg_\w+|dblink\w*|lo_\w*|set_config)\b/i.test(
      bare,
    )
  )
    throw Error("READ_ONLY_QUERY_REQUIRED");
  let sql = input.sql,
    values = input.values ?? [];
  if (input.parameters !== undefined) {
    if (
      input.values !== undefined ||
      !input.parameters ||
      Array.isArray(input.parameters) ||
      typeof input.parameters !== "object"
    )
      throw Error("INVALID_QUERY_PARAMETERS");
    const names: string[] = [];
    sql = sql.replace(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\r\n]*|\/\*[\s\S]*?\*\/|(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g,
      (token: string, name: string) => {
        if (!name) return token;
        if (name.startsWith("__gea_"))
          throw Error("RESERVED_QUERY_PARAMETER");
        if (!Object.hasOwn(input.parameters, name))
          throw Error("MISSING_QUERY_PARAMETER");
        let i = names.indexOf(name);
        if (i < 0) {
          i = names.length;
          names.push(name);
        }
        return "$" + (i + 1);
      },
    );
    if (Object.keys(input.parameters).some((name) => !names.includes(name)))
      throw Error("UNUSED_QUERY_PARAMETER");
    values = names.map((name) => input.parameters[name]);
  }
  if (!Array.isArray(values) || values.length > 10000)
    throw Error("INVALID_QUERY_PARAMETERS");
  prepareGeaSql(sql, values);
  return { sql, values };
}
export async function readHtmlQuery(
  input: any,
  transport: {
    endpoint: string;
    signal: AbortSignal;
    token: string;
    fetch?: typeof fetch;
  },
) {
  const query = prepareHtmlQuery(input);
  // Opt-in compact wire format; preserve metadata and legacy records consumers.
  const finish = (value: any) => {
    if (input.resultShape === 'rows') delete value.records;
    return value;
  };
  const db = createGeaSqlDatabase(() => transport.token, transport);
  const pageNo = input.pageNo,
    pageSize = input.pageSize ?? 200;
  if (
    (pageNo !== undefined && (!Number.isSafeInteger(pageNo) || pageNo < 1)) ||
    (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 200)
  )
    throw Error("INVALID_PAGE");
  // The upstream governed endpoint applies the current consumer and user's resource/data permissions.
  // HTML filters are presentation inputs, never authorization constraints.
  if (pageNo !== undefined) {
    if (input.packing) throw Error("PACKED_PAGING_UNSUPPORTED");
    const page = await db.queryPage(query.sql, query.values, pageNo, pageSize);
    return finish({ ...page, rows: page.rows, records: page.rows, total: page.total });
  }
  let result = await db.queryWithOptions!(
    input.packing ? packedRowsSql(query.sql, input.packing) : query.sql,
    query.values,
    {pageSize},
  );
  if (input.packing) result = unpackBusinessRows(result.rows);
  const total = result.rows.length;
  if (input.maxRows && total > input.maxRows)
    throw Error("QUERY_RESULT_EXCEEDS_LIMIT");
  const rows =
    pageNo === undefined
      ? result.rows
      : result.rows.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  return finish({ ...result, rows, records: rows, total });
}
