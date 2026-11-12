import {
  createGeaSqlDatabase,
  prepareGeaSql,
  packedRowsSql,
  unpackBusinessRows,
} from "./html-sql.ts";

const PLACEHOLDER =
  /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\r\n]*|\/\*[\s\S]*?\*\/|(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)|(\?)/g;

function placeholderShape(sql: string) {
  const names: string[] = [];
  let positional = 0;
  sql.replace(PLACEHOLDER, (token: string, name?: string, question?: string) => {
    if (name) names.push(name);
    else if (question) positional += 1;
    return token;
  });
  return { names, positional };
}

function positionalValues(parameters: any, count: number): unknown[] {
  const values = Array.isArray(parameters)
    ? parameters.slice()
    : (() => {
        const keys = Object.keys(parameters);
        return (
          keys.every((key) => /^\d+$/.test(key)) ? keys.sort((a, b) => Number(a) - Number(b)) : keys
        ).map((key) => parameters[key]);
      })();
  if (values.length !== count)
    throw Error(
      `POSITIONAL_QUERY_PARAMETER：SQL 里有 ${count} 个 ? 占位符，parameters 给了 ${values.length} 个值`,
    );
  return values;
}

export function prepareHtmlQuery(input: any) {
  if (!input || typeof input.sql !== "string" || input.sql.length > 200000)
    throw Error("INVALID_QUERY");
  const bare = input.sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\r\n]*|\/\*[\s\S]*?\*\//g, " ");
  if (
    /\b(INTO|DO|EXECUTE|SET|RESET|VACUUM|ANALYZE|LOCK|pg_\w+|dblink\w*|lo_\w*|set_config)\b/i.test(
      bare,
    )
  )
    throw Error("READ_ONLY_QUERY_REQUIRED");
  let sql = input.sql,
    values = input.values ?? [];
  if (input.parameters !== undefined) {
    if (input.values !== undefined)
      throw Error("INVALID_QUERY_PARAMETERS：parameters 与 values 只能用一个");
    const parameters = input.parameters;
    if (!parameters || typeof parameters !== "object")
      throw Error(
        'INVALID_QUERY_PARAMETERS：parameters 传对象（命名参数 {"name": 值}）或数组（位置参数）',
      );
    const { names: used, positional } = placeholderShape(sql);
    if (used.length > 0 && positional > 0)
      throw Error(
        "MIXED_QUERY_PARAMETERS：SQL 里同时用了 :name 和 ? 占位符；统一改成 :name（例如 where cust_code = :cust）",
      );
    if (positional > 0) {
      values = positionalValues(parameters, positional);
      let index = 0;
      sql = sql.replace(PLACEHOLDER, (token: string, _name?: string, question?: string) =>
        question ? "$" + ++index : token,
      );
    } else {
      if (used.length === 0) {
        const provided = Object.keys(parameters);
        if (provided.length > 0)
          throw Error(
            `UNUSED_QUERY_PARAMETER：SQL 里没有占位符引用 parameters 里的 ${provided
              .slice(0, 3)
              .join("、")}；命名参数用 :name（例如 where cust_code = :cust），不要用 ?`,
          );
        values = [];
      }
      if (used.length > 0) {
        const names: string[] = [];
        sql = sql.replace(PLACEHOLDER, (token: string, name?: string) => {
          if (!name) return token;
          if (name.startsWith("__gea_"))
            throw Error("RESERVED_QUERY_PARAMETER：__gea_ 前缀是宿主保留名");
          if (!Object.hasOwn(parameters, name))
            throw Error(`MISSING_QUERY_PARAMETER：SQL 用到 :${name}，parameters 里没有这个键`);
          let i = names.indexOf(name);
          if (i < 0) {
            i = names.length;
            names.push(name);
          }
          return "$" + (i + 1);
        });
        const extra = Object.keys(parameters).filter((name) => !names.includes(name));
        if (extra.length)
          throw Error(
            `UNUSED_QUERY_PARAMETER：parameters 里的 ${extra
              .slice(0, 3)
              .join("、")} 在 SQL 里没有被引用`,
          );
        values = names.map((name) => parameters[name]);
      }
    }
  }
  if (!Array.isArray(values) || values.length > 10000) throw Error("INVALID_QUERY_PARAMETERS");
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
    limit?: import("./html-sql.ts").SqlReadLimit;
  },
) {
  const query = prepareHtmlQuery(input);

  const finish = (value: any) => {
    if (input.resultShape === "rows") delete value.records;
    return value;
  };
  const db = createGeaSqlDatabase(() => transport.token, transport);
  const pageNo = input.pageNo,
    pageSize = input.pageSize ?? 200;
  if (
    (pageNo !== undefined && (!Number.isSafeInteger(pageNo) || pageNo < 1)) ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 200
  )
    throw Error("INVALID_PAGE：页码从 1 起，每页最多 200 行");

  if (pageNo !== undefined) {
    if (input.packing) throw Error("PACKED_PAGING_UNSUPPORTED");
    const page = await db.queryPage(query.sql, query.values, pageNo, pageSize);
    return finish({ ...page, rows: page.rows, records: page.rows, total: page.total });
  }
  let result = await db.queryWithOptions!(
    input.packing ? packedRowsSql(query.sql, input.packing) : query.sql,
    query.values,
    { pageSize },
  );
  if (input.packing) result = unpackBusinessRows(result.rows);
  const total = result.rows.length;
  if (input.maxRows && total > input.maxRows) throw Error("QUERY_RESULT_EXCEEDS_LIMIT");
  const rows =
    pageNo === undefined
      ? result.rows
      : result.rows.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  return finish({ ...result, rows, records: rows, total });
}
