/**
 * Cube 查询的**出站预检闸门**（GEA→CubeMCP 外部调用规约 G3–G6、§17）。
 *
 * 规约把责任写死了：发送前的确定性校验必须由调用层做，LLM 只提业务意图。
 * 之前这些约束全靠提示词，线上结果是"发出去被网关拒 → 模型读错误文本 → 改一次"，
 * 一轮里十几步返工。这里把能确定性判断的四类错误在本地拦下：
 *
 * - G3 结构：`queries` 1–8 项、`name` 去空白非空唯一且 ≤120、每项必须是 `{name, query}`，
 *   `dimensions/filters/order` 必须在 `query` 里层，`query` 不能是空对象；
 * - G4 单模型：递归收集所有位置的成员，**整次调用只能一个模型**，跨模型直接给拆分方案；
 * - G5 成员：逐字来自当前 inspect 清单，且类别与放置位置一致（维度不能塞 measures，
 *   没有已发布 measure 就不能写聚合）；
 * - G6 形状：`order` 只能是对象或二元数组列表、方向只 `asc`/`desc`；`limit` 正整数；
 *   filters 只能是叶子或 and/or 组合、不能缺 values；`timeDimensions` 要有真实维度名。
 *
 * 两条设计约束：
 * 1. 不做按问题特化的规则，判据只有"Cube 通用形状 + inspect 成员目录"；
 * 2. 不猜授权。资源 ALLOW、方案、用户业务范围只有网关知道，本地判不了就交给网关，
 *    只保证"发出去必然被拒"的那一类不发出。
 */
import {
  measureHint,
  memberHint,
  misplacedMeasures,
  unknownMembers,
  type ModelMembers,
} from "./member-index.ts";
import { yearMonthHint, yearMonthValues } from "./cube-query-guard.ts";
import { monthFormatIssue } from './sales-result-contract.ts';

/** 下游 `CubeJsonQuery.additionalProperties=false`：只能用这些字段。 */
const QUERY_FIELDS = new Set([
  "dimensions",
  "measures",
  "segments",
  "filters",
  "timeDimensions",
  "limit",
  "offset",
  "total",
  "order",
  "timezone",
  "ungrouped",
  "joinHints",
]);

/** `模型.字段`；裸字段、SQL 表达式、`*` 都不匹配。 */
import { CUBE_FILTER_OPERATORS } from './cube-operators.ts';
const MODEL_MEMBER = /^[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*$/;

export const CUBE_MAX_QUERIES = 8;
export const CUBE_MAX_NAME_CHARS = 120;
/**
 * 宿主保护上限，**不是授权上限**。规约 §16 明确：某个 Agent 的 maxRows/maxBytes 只是那份
 * 授权项的快照，不能推断别的 Agent 一样。所以这里只挡"明显不是取一屏、而是想拉全表"的写法，
 * 真正的行数/字节闸门仍在网关；超过这个数就要求用稳定排序 + offset 分页，或改聚合口径。
 */
export const CUBE_MAX_LIMIT = 1000;
/**
 * 整份 `queries` 序列化后的字符上限（规约 §17.8：发送前看字节数）。
 * 正常查询是"8 项 × 十几个成员"，几千字符；到这个量级说明模型在把整张表的列名往里塞，
 * 先拆成多次调用比发出去被下游拒更省事。
 */
export const CUBE_MAX_REQUEST_CHARS = 32_000;

type Issue = {
  /** 出问题的位置，例如 queries[1].query.order。 */
  path: string;
  problem: string;
  fix?: string;
};

/** 成员出现在查询的哪个位置——G5 要求"类别与放置位置一致"。 */
type MemberPlace =
  | "dimensions"
  | "measures"
  | "segments"
  | "filters"
  | "order"
  | "timeDimensions"
  | "joinHints";

type PlacedMember = { member: string; where: MemberPlace };

type Collected = { members: PlacedMember[]; issues: Issue[] };

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asTrimmed = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const modelOf = (member: string): string | undefined =>
  MODEL_MEMBER.test(member) ? member.slice(0, member.lastIndexOf(".")) : undefined;

/**
 * 模型偶尔把有序排序写成 [{"模型.字段":"desc"}]。仅当每个对象恰有一个合法成员
 * 和明确方向时，转换为网关接受的二元数组；其余形状继续交给 G6 拦截。
 */
export function normalizeCubeOrderArguments(parameters: Record<string, unknown>): Record<string, unknown> {
  if (parameters.action !== 'query' || !Array.isArray(parameters.queries)) return parameters;
  let changed = false;
  const queries = parameters.queries.map(raw => {
    const item = asObject(raw);
    const query = asObject(item?.query);
    if (!item || !query || !Array.isArray(query.order)) return raw;
    const order = query.order.map(entry => {
      if (Array.isArray(entry)) return entry;
      const object = asObject(entry);
      if (!object) return entry;
      const keys = Object.keys(object);
      const member = keys[0];
      const direction = object[member];
      if (keys.length !== 1 || !MODEL_MEMBER.test(member) || (direction !== 'asc' && direction !== 'desc')) return entry;
      changed = true;
      return [member, direction];
    });
    return {...item, query: {...query, order}};
  });
  return changed ? {...parameters, queries} : parameters;
}

/** 递归取 filters 里引用的成员；顺便把形状问题记下来。 */
function walkFilters(
  filters: unknown,
  path: string,
  out: Collected,
): void {
  // 没写 filters 是正常情况（省略即可），只有写了但形状不对才拦。
  if (filters === undefined || filters === null) return;
  if (!Array.isArray(filters)) {
    out.issues.push({
      path,
      problem: "filters 必须是数组",
      fix: '每个条件写成 {"member":"模型.字段","operator":"equals","values":[...]}；多个条件用 or/and 数组包起来',
    });
    return;
  }
  filters.forEach((raw, index) => {
    const at = `${path}[${index}]`;
    const node = asObject(raw);
    if (!node) {
      out.issues.push({ path: at, problem: "过滤条件必须是对象" });
      return;
    }
    const member = asTrimmed(node.member);
    const groups = ["and", "or"].filter((key) => node[key] !== undefined);
    if (member && groups.length > 0) {
      out.issues.push({
        path: at,
        problem: "一个节点不能既带 member 又带 and/or",
        fix: "叶子和组合节点分开写",
      });
      return;
    }
    if (groups.length > 1) {
      out.issues.push({ path: at, problem: "一个节点只能有一个 and 或 or" });
      return;
    }
    if (groups.length === 1) {
      walkFilters(node[groups[0]], `${at}.${groups[0]}`, out);
      return;
    }
    if (!member) {
      out.issues.push({
        path: at,
        problem: "过滤条件没有 member",
        fix: "每条筛选都要写完整的 模型.字段",
      });
      return;
    }
    if (!modelOf(member)) {
      out.issues.push({
        path: `${at}.member`,
        problem: `成员名 ${member} 不是「模型.字段」`,
        fix: "用目录里的完整成员名，不要用裸字段或 SQL 表达式",
      });
      return;
    }
    out.members.push({ member, where: "filters" });
    const operator = asTrimmed(node.operator);
    if (!operator) {
      out.issues.push({
        path: at,
        problem: "过滤条件没有 operator",
        fix: "常用等值写 equals，不要写 SQL 的 IN / BETWEEN / IS NULL",
      });
      return;
    }
    // set / notSet 这类运算符本来就不带值，其余一律要求 values。
    if (!(CUBE_FILTER_OPERATORS as readonly string[]).includes(operator)) {
      out.issues.push({path: `${at}.operator`, problem: `operator=${operator} 不是支持的Cube操作符`, fix: '等于使用equals，大于使用gt；不能用SQL的=、IN或BETWEEN。'});
      return;
    }
    const valueFree = operator === "set" || operator === "notSet" || operator === "measureFilter";
    if (!valueFree && !Array.isArray(node.values)) {
      out.issues.push({
        path: `${at}.values`,
        problem: "过滤条件缺 values",
        fix: "值要放在 values 数组里，且必须是核实过的真实取值",
      });
    }
  });
}

/** 递归取 order 里引用的成员；顺便把形状问题记下来（G6）。 */
function walkOrder(
  order: unknown,
  path: string,
  out: Collected,
): void {
  if (order === undefined || order === null) return;
  const badDirection = (direction: unknown): boolean =>
    direction !== "asc" && direction !== "desc";
  if (Array.isArray(order)) {
    order.forEach((entry, index) => {
      const at = `${path}[${index}]`;
      if (!Array.isArray(entry) || entry.length !== 2) {
        out.issues.push({
          path: at,
          problem: "order 数组的元素必须是 [成员, 方向] 二元数组",
          fix: '例如 [["模型.字段","asc"]]；不要用对象数组 [{"模型.字段":"asc"}]',
        });
        return;
      }
      const member = asTrimmed(entry[0]);
      if (!member || !modelOf(member)) {
        out.issues.push({
          path: `${at}[0]`,
          problem: `排序成员 ${String(entry[0])} 不是「模型.字段」`,
          fix: "用目录里的完整成员名",
        });
        return;
      }
      out.members.push({ member, where: "order" });
      if (badDirection(entry[1])) {
        out.issues.push({
          path: `${at}[1]`,
          problem: `排序方向 ${String(entry[1])} 不合法`,
          fix: "方向只能是小写 asc 或 desc",
        });
      }
    });
    return;
  }
  const object = asObject(order);
  if (!object) {
    out.issues.push({
      path,
      problem: "order 只能是排序对象或 [成员, 方向] 二元数组列表",
      fix: '推荐 {"模型.字段":"asc"}；多字段时用 [["模型.字段","asc"],["模型.字段2","desc"]]',
    });
    return;
  }
  for (const [member, direction] of Object.entries(object)) {
    if (!modelOf(member)) {
      out.issues.push({
        path: `${path}.${member}`,
        problem: `排序成员 ${member} 不是「模型.字段」`,
        fix: "用目录里的完整成员名",
      });
      continue;
    }
    out.members.push({ member, where: "order" });
    if (badDirection(direction)) {
      out.issues.push({
        path: `${path}.${member}`,
        problem: `排序方向 ${String(direction)} 不合法`,
        fix: "方向只能是小写 asc 或 desc",
      });
    }
  }
}

/** 一条具名查询里引用的全部成员 + 形状问题。 */
function inspectQuery(
  rawQuery: unknown,
  path: string,
  out: Collected,
): void {
  const query = asObject(rawQuery);
  if (!query) {
    out.issues.push({
      path,
      problem: "query 必须是非空对象",
      fix: "不要把 query 写成 SQL 字符串或数组",
    });
    return;
  }
  for (const key of Object.keys(query)) {
    if (!QUERY_FIELDS.has(key))
      out.issues.push({
        path: `${path}.${key}`,
        problem: `不认识的查询字段 ${key}`,
        fix: `只能用：${[...QUERY_FIELDS].join("、")}`,
      });
    else if (query[key] === null)
      out.issues.push({
        path: `${path}.${key}`,
        problem: "可选字段不用时要省略，不能传 null",
      });
  }
  for (const key of ["dimensions", "measures", "segments"]) {
    const list = query[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      out.issues.push({ path: `${path}.${key}`, problem: `${key} 必须是数组` });
      continue;
    }
    list.forEach((member, index) => {
      const name = asTrimmed(member);
      if (!name) {
        out.issues.push({
          path: `${path}.${key}[${index}]`,
          problem: "成员名必须是非空字符串",
        });
        return;
      }
      if (!modelOf(name)) {
        out.issues.push({
          path: `${path}.${key}[${index}]`,
          problem: `成员名 ${name} 不是「模型.字段」`,
          fix: "用目录里的完整成员名；裸字段、物理表路径、*、SUM(...) 都不行",
        });
        return;
      }
      out.members.push({ member: name, where: key as MemberPlace });
    });
  }
  walkFilters(query.filters, `${path}.filters`, out);
  walkOrder(query.order, `${path}.order`, out);
  const timeDimensions = query.timeDimensions;
  if (timeDimensions !== undefined) {
    if (!Array.isArray(timeDimensions))
      out.issues.push({ path: `${path}.timeDimensions`, problem: "timeDimensions 必须是数组" });
    else
      timeDimensions.forEach((entry, index) => {
        const at = `${path}.timeDimensions[${index}]`;
        const node = asObject(entry);
        const dimension = asTrimmed(node?.dimension);
        if (!node || !dimension || !modelOf(dimension)) {
          out.issues.push({
            path: `${at}.dimension`,
            problem: "时间维度必须写完整的 模型.字段",
            fix: "并且该成员要是 inspect 里的真实时间成员（[time]）；字符串日期不能当时间维度用",
          });
          return;
        }
        out.members.push({ member: dimension, where: "timeDimensions" });
        const range = node.dateRange;
        if (range === undefined) return;
        if (
          !Array.isArray(range) ||
          range.length !== 2 ||
          typeof range[0] !== "string" ||
          typeof range[1] !== "string" ||
          !range[0].trim() ||
          !range[1].trim()
        )
          out.issues.push({
            path: `${at}.dateRange`,
            problem: "dateRange 必须是 [起, 止] 两个非空日期字符串，且起不晚于止",
            fix: "例如 [\"2026-09-01\",\"2026-09-23\"]",
          });
      });
  }
  const joinHints = query.joinHints;
  if (joinHints !== undefined) {
    if (!Array.isArray(joinHints))
      out.issues.push({ path: `${path}.joinHints`, problem: "joinHints 必须是数组" });
    else
      joinHints.forEach((entry, index) => {
        const pair = Array.isArray(entry) ? entry : [];
        const left = asTrimmed(pair[0]);
        const right = asTrimmed(pair[1]);
        if (pair.length !== 2 || !left || !right || !modelOf(left) || !modelOf(right)) {
          out.issues.push({
            path: `${path}.joinHints[${index}]`,
            problem: "joinHints 的元素必须是两个完整成员名的二元数组",
            fix: "通用模板建议直接省略 joinHints；跨模型 join 会被网关拒绝",
          });
          return;
        }
        out.members.push({ member: left, where: "joinHints" });
        out.members.push({ member: right, where: "joinHints" });
      });
  }
}

/** G6 的数值参数：limit 正整数、offset 非负整数、total/ungrouped 布尔、timezone 非空串。 */
function checkNumbers(query: Record<string, unknown>, path: string, issues: Issue[]): void {
  const limit = query.limit;
  if (limit !== undefined) {
    if (!Number.isSafeInteger(limit) || (limit as number) < 1)
      issues.push({
        path: `${path}.limit`,
        problem: "limit 必须是正整数（不是字符串、布尔或 0）",
        fix: "联调从小范围开始，例如 10–50",
      });
    else if ((limit as number) > CUBE_MAX_LIMIT)
      issues.push({
        path: `${path}.limit`,
        problem: `limit=${limit} 超过宿主保护上限 ${CUBE_MAX_LIMIT}`,
        fix:
          `这不是授权上限，只是防止把整表拉进上下文：请缩小日期/字段范围，` +
          `或改成聚合口径；确实要更多行就用稳定排序 + offset 分页，每页不超过 ${CUBE_MAX_LIMIT}。`,
      });
  }
  const offset = query.offset;
  if (offset !== undefined && (!Number.isSafeInteger(offset) || (offset as number) < 0))
    issues.push({ path: `${path}.offset`, problem: "offset 必须是不小于 0 的整数" });
  for (const key of ["total", "ungrouped"])
    if (query[key] !== undefined && typeof query[key] !== "boolean")
      issues.push({ path: `${path}.${key}`, problem: `${key} 必须是 true 或 false` });
  const timezone = query.timezone;
  if (timezone !== undefined && (typeof timezone !== "string" || !timezone.trim()))
    issues.push({ path: `${path}.timezone`, problem: "timezone 必须是非空字符串，例如 Asia/Shanghai" });
}

/** 把问题清单压成一段给模型看的说明；同类问题一次列全，不让它改一个再撞一个。 */
function blocked(issues: readonly Issue[], extra?: string): string {
  const shown = issues.slice(0, 8);
  const lines = shown.map(
    (issue) =>
      `- ${issue.path}：${issue.problem}${issue.fix ? ` → ${issue.fix}` : ""}`,
  );
  if (issues.length > shown.length) lines.push(`- 还有 ${issues.length - shown.length} 处同类问题，一并改掉`);
  return (
    `GEA_CUBE_PREFLIGHT_BLOCKED：入参预检没通过，**本次调用没有发出**（不用重试，改参数）。\n` +
    lines.join("\n") +
    (extra ? `\n${extra}` : "")
  );
}

/**
 * 出站前预检。返回 undefined 表示可以发；返回字符串就是拦下的可读说明。
 *
 * @param parameters 工具 arguments 原样。只有 `action=inspect/query` 会被检查。
 * @param index 当前成员清单（inspect 产物）。没拿到时不校验成员存在性与类别，
 *   其余形状校验照做——inspect 都还没成功的话，模型本来就不该发 query。
 */
export function preflightCubeArguments(
  parameters: Record<string, unknown> | undefined,
  index?: ReadonlyMap<string, ModelMembers>,
  options: { allowMultipleModels?: boolean } = {},
): string | undefined {
  const args = asObject(parameters);
  if (!args) return undefined;
  const action = asTrimmed(args.action);
  if (action === undefined) return undefined; // 缺 action 由必填参数那条拦，这里不重复报。
  if (action !== "inspect" && action !== "query")
    return blocked([
      {
        path: "arguments.action",
        problem: `action=${action} 不合法`,
        fix: "只能是 inspect 或 query",
      },
    ]);

  const queries = args.queries;
  if (action === "inspect") {
    if (queries === undefined) return undefined;
    if (!Array.isArray(queries) || queries.length > 0)
      return blocked([
        {
          path: "arguments.queries",
          problem: "inspect 时 queries 必须是空数组",
          fix: "写 queries: []；读目录不需要指定模型",
        },
      ]);
    return undefined;
  }

  if (!Array.isArray(queries) || queries.length === 0)
    return blocked([
      {
        path: "arguments.queries",
        problem: "query 时 queries 必须是 1–8 项数组",
        fix: '每项写成 {"name":"短名","query":{...}}，查询内容放在内层 query 里',
      },
    ]);
  if (queries.length > CUBE_MAX_QUERIES)
    return blocked([
      {
        path: "arguments.queries",
        problem: `一次调用最多 ${CUBE_MAX_QUERIES} 项，这次给了 ${queries.length} 项`,
        fix: "拆成多次调用；同模型的查询可以合并到一项里",
      },
    ]);

  const issues: Issue[] = [];
  const collected: Collected = { members: [], issues };
  const names = new Map<string, number>();
  queries.forEach((raw, index) => {
    const at = `queries[${index}]`;
    const item = asObject(raw);
    if (!item) {
      issues.push({
        path: at,
        problem: "每一项必须是对象",
        fix: '写成 {"name":"短名","query":{...}}',
      });
      return;
    }
    for (const key of Object.keys(item))
      if (key !== "name" && key !== "query")
        issues.push({
          path: `${at}.${key}`,
          problem: `具名查询不允许额外字段 ${key}`,
          fix: "dimensions、filters、order、limit 全部放进该元素的 query 里",
        });
    const name = asTrimmed(item.name);
    if (!name)
      issues.push({
        path: `${at}.name`,
        problem: "name 不能为空（去空白后必须有字符）",
        fix: "用短字母数字下划线，例如 inventory_sample",
      });
    else {
      if (name.length > CUBE_MAX_NAME_CHARS)
        issues.push({
          path: `${at}.name`,
          problem: `name 最长 ${CUBE_MAX_NAME_CHARS} 个字符`,
        });
      const seen = names.get(name);
      if (seen !== undefined)
        issues.push({
          path: `${at}.name`,
          problem: `name「${name}」与 queries[${seen}] 重复`,
          fix: "同一请求里每个 name 必须唯一",
        });
      else names.set(name, index);
    }
    const query = asObject(item.query);
    inspectQuery(item.query, `${at}.query`, collected);
    if (query) {
      checkNumbers(query, `${at}.query`, issues);
      const selects =
        Array.isArray(query.dimensions) ||
        Array.isArray(query.measures) ||
        Array.isArray(query.segments) ||
        Array.isArray(query.timeDimensions);
      if (!selects)
        issues.push({
          path: `${at}.query`,
          problem: "query 里至少要选一个 dimension、measure 或 time dimension",
          fix: "空查询（只带 limit/分页）发出去也会被下游拒",
        });
    }
  });

  if (issues.length > 0) return blocked(issues);

  // G4：整次调用只能一个模型。跨模型必须拆，拆成什么样直接给它。
  const members = collected.members;
  const models = [
    ...new Set(
      members
        .map((entry) => modelOf(entry.member))
        .filter((model): model is string => model !== undefined),
    ),
  ];
  if (models.length > 1 && !options.allowMultipleModels) {
    const grouped = models
      .map(
        (model) =>
          `${model}（用到的成员：${[
            ...new Set(
              members
                .filter((entry) => modelOf(entry.member) === model)
                .map((entry) => entry.member),
            ),
          ]
            .slice(0, 4)
            .join("、")}）`,
      )
      .join("；");
    return blocked(
      [
        {
          path: "arguments.queries",
          problem: `一次调用里出现了 ${models.length} 个模型：${models.join("、")}`,
          fix: "拆成多次 tools/call，每次只留一个模型的成员（同名操作可以共用一个 operationId）；加 queries 项或传 dataAssetCode 都绕不过去",
        },
      ],
      `按模型拆开是这样的：${grouped}。`,
    );
  }
  if (members.length === 0)
    return blocked([
      {
        path: "arguments.queries",
        problem: "没有引用任何成员",
        fix: "先用 gea_gateway_catalog 选模型和成员",
      },
    ]);

  // 年月当日期传：**只在该成员确实是时间类型时才拦**。文本年月列（例如
  // agents_sales_plan_detail_mi.plane_date，声明 string、值形如 2026-01）用 2026-10 过滤是合法写法，
  // 拦下来反而会把模型推向 0 行的写法——这条线上实测踩过。
  const yearMonths = yearMonthValues(queries, (member) => {
    const model = index?.get(modelOf(member) ?? "");
    return model ? model.time.includes(member) : false;
  });
  if (yearMonths.length > 0) return yearMonthHint(yearMonths);
  const monthIssue = monthFormatIssue(queries);
  if (monthIssue) return monthIssue;

  // §17.8：请求体本身的体积。成员名是最占字符的部分，超了就是"想把整表列全"。
  // 放在成员校验之前——它不需要清单也能判，所以清单不在手时也要拦。
  let requestChars = 0;
  try {
    requestChars = JSON.stringify(queries).length;
  } catch {
    requestChars = 0;
  }
  if (requestChars > CUBE_MAX_REQUEST_CHARS)
    return blocked([
      {
        path: "arguments.queries",
        problem: `这次请求约 ${requestChars} 字符，超过单次上限 ${CUBE_MAX_REQUEST_CHARS}`,
        fix: "减少重复成员与无关列（只留这次真正要用的 2–4 列维度），或按模型/口径拆成多次调用",
      },
    ]);

  if (!index) return undefined;
  const namesOf = members.map((entry) => entry.member);
  const unknown = unknownMembers(namesOf, index);
  if (unknown.length > 0) return memberHint(unknown, index, members.filter(entry => entry.where === 'measures').map(entry => entry.member));
  const misplaced = misplacedMeasures(queries, index);
  if (misplaced.length > 0) return measureHint(misplaced, index, queries);
  // 其余"类别与位置不一致"：度量进 dimensions、分段进 dimensions/measures、
  // 非时间成员进 timeDimensions。unknownMembers 和 misplacedMeasures 覆盖不到这三种。
  const placement: Issue[] = [];
  for (const entry of members) {
    const model = index.get(modelOf(entry.member) ?? "");
    if (!model) continue;
    const isDimension = model.dimensions.includes(entry.member);
    const isMeasure = model.measures.includes(entry.member);
    const isSegment = model.segments.includes(entry.member);
    const isTime = model.time.length > 0 && model.time.includes(entry.member);
    if (entry.where === "dimensions" && isMeasure && !isDimension)
      placement.push({
        path: "queries[].query.dimensions",
        problem: `${entry.member} 是**度量**，不能放进 dimensions`,
        fix: "度量放进 query.measures，分组维度留在 dimensions",
      });
    else if (entry.where === "dimensions" && isSegment && !isDimension)
      placement.push({
        path: "queries[].query.dimensions",
        problem: `${entry.member} 是**分段**，不能放进 dimensions`,
        fix: "分段写进 query.segments；它只是预置筛选片段，不等于口径完整",
      });
    else if (entry.where === "segments" && !isSegment)
      placement.push({
        path: "queries[].query.segments",
        problem: `${entry.member} 不是分段`,
        fix: "只有目录里标了「分段」的成员能写进 segments，其余省略这个字段",
      });
    else if (entry.where === "measures" && isSegment && !isMeasure)
      placement.push({
        path: "queries[].query.measures",
        problem: `${entry.member} 是**分段**，不能放进 measures`,
        fix: "分段写进 query.segments",
      });
    else if (entry.where === "timeDimensions" && !isTime)
      placement.push({
        path: "queries[].query.timeDimensions",
        problem: `${entry.member} 不是时间成员，不能当时间维度用`,
        fix:
          model.time.length > 0
            ? `这个模型的时间成员只有：${model.time.slice(0, 8).join("、")}`
            : "这个模型没有时间成员；字符串日期要按它自己的文本格式放进 filters",
      });
  }
  if (placement.length > 0) return blocked(placement);
  return undefined;
}

/** Collect model references from every member-bearing position, including filters and order. */
export function cubeQueryModels(queries: unknown): string[] {
  const collected: Collected = {members: [], issues: []};
  if (Array.isArray(queries)) for (const item of queries) inspectQuery(asObject(item)?.query, 'query', collected);
  return [...new Set(collected.members.map(entry => modelOf(entry.member)).filter((model): model is string => !!model))];
}
