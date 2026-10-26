import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

/** Deployment-only identity bindings; secrets are resolved from Host environment variables. */
export interface DmsConfig {
  gatewayUrl: string;
  manageUrl: string;
  secretEnv: string;
  users: {
    tenantId: string;
    userId: string;
    username?: string;
    workcode?: string;
  }[];
}
export type DmsEnvironments = Partial<Record<"production" | "test", DmsConfig>>;
type Order = Record<string, unknown> & {
  aiPreOrderCode: string;
  itemList: { productCode: string; quantity: number }[];
};
const required = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 500)
    throw Error(`DMS 参数无效：${field}`);
  return value.trim();
};
/** Only documented fields cross the DMS boundary; quantities are in pieces. */
export function parseDmsOrder(input: unknown): Order {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("DMS 订单参数无效");
  const source = input as Record<string, unknown>;
  const order = {} as Order;
  const fields = ["aiPreOrderCode", "customerCode", "addressCode", "pupCode"];
  const optional = [
    "shpart",
    "carpoolingCode",
    "expectedArrivalDate",
    "expectedSendDate",
    "orderRemarks",
    "ygCode",
  ];
  const enums = {
    logisticsPatternCode: ["1", "2"],
    deliveryMethod: ["ps", "zt"],
    isCarpooling: ["N", "L", "W"],
    zsn05: ["Y", "N"],
  };
  if (
    Object.keys(source).some(
      (key) => ![...fields, ...optional, ...Object.keys(enums), "itemList"].includes(key),
    )
  )
    throw Error("DMS 订单包含未支持字段");
  for (const field of fields) order[field] = required(source[field], field);
  for (const field of optional)
    if (source[field] !== undefined && source[field] !== "")
      order[field] = required(source[field], field);
  for (const [field, values] of Object.entries(enums)) {
    const value = source[field] ?? values[0];
    if (!values.includes(value as string)) throw Error(`DMS 参数无效：${field}`);
    order[field] = value;
  }
  if (order.isCarpooling === "L" && !order.carpoolingCode) throw Error("拼车单号不能为空");
  if (!Array.isArray(source.itemList) || !source.itemList.length || source.itemList.length > 5000)
    throw Error("DMS 产品明细不能为空或超过5000条");
  const seen = new Set<string>();
  order.itemList = source.itemList.map((item) => {
    if (!item || Object.keys(item).some((key) => !["productCode", "quantity"].includes(key)))
      throw Error("DMS 产品明细无效");
    const productCode = required(item.productCode, "productCode");
    if (seen.has(productCode)) throw Error("DMS 产品编码重复");
    seen.add(productCode);
    if (
      typeof item.quantity !== "number" ||
      !Number.isFinite(item.quantity) ||
      item.quantity <= 0 ||
      item.quantity > 1e9
    )
      throw Error("DMS 产品数量必须大于0且不超过10亿件");
    return { productCode, quantity: item.quantity };
  });
  return order;
}
function baseUrl(raw: string) {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("DMS 地址配置无效");
  return url;
}

/** Credentials never leave this transport. DMS owns redemption on its loginSSO page. */
export class DmsClient {
  private readonly config: DmsConfig;
  private readonly identity: { username?: string; workcode?: string };
  private readonly transport: typeof fetch;
  constructor(
    config: DmsConfig,
    identity: { username?: string; workcode?: string },
    transport: typeof fetch = fetch,
  ) {
    this.config = config;
    this.identity = identity;
    this.transport = transport;
  }
  private async request(path: string, init: RequestInit, signal: AbortSignal): Promise<any> {
    signal.throwIfAborted();
    const base = baseUrl(this.config.gatewayUrl);
    const response = await this.transport(base.href.replace(/\/$/, "") + path, {
      ...init,
      signal,
      redirect: "error",
    });
    if (!response.ok) throw Error(`DMS 请求失败（HTTP ${response.status}）`);
    const body = await response.json();
    signal.throwIfAborted();
    if (body?.success !== true || body?.code !== 200)
      throw Error("DMS 拒绝请求，请在DMS核查账号、订单字段及业务配置");
    return body.result;
  }
  async login(signal: AbortSignal) {
    const username = this.identity.username?.trim(),
      workcode = this.identity.workcode?.trim();
    const key = required(username || workcode, "登录账号");
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(this.config.secretEnv)) throw Error("DMS 密钥环境变量配置无效");
    const secret = process.env[this.config.secretEnv];
    if (!secret) throw Error("DMS 签名密钥未配置");
    const time = String(Date.now());
    const sign = createHash("md5")
      .update(key + time + secret)
      .digest("hex");
    const result = await this.request(
      "/auth/oauthout/ssoLogin",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ssoToken: JSON.stringify({
            ...(username ? { username } : { workcode }),
            time,
            sign,
            source: "ai",
          }),
        }).toString(),
      },
      signal,
    );
    if (
      typeof result?.access_token !== "string" ||
      !result.access_token ||
      typeof result.redirect !== "string"
    )
      throw Error("DMS 登录回执不完整");
    const redirect = new URL(result.redirect);
    const manage = baseUrl(this.config.manageUrl);
    if (
      redirect.origin !== manage.origin ||
      redirect.username ||
      redirect.password ||
      !redirect.searchParams.get("token") ||
      !redirect.pathname.endsWith("/user/loginSSO")
    )
      throw Error("DMS 免登地址不符合部署配置");
    return {
      accessToken: result.access_token as string,
      redirect: redirect.href,
    };
  }
  /** Server-side adapter for clients that own the DMS login callback; never expose token maps to GEA pages. */
  async exchange(key: string, menu: string | undefined, signal: AbortSignal) {
    const query = new URLSearchParams({ key: required(key, "key") });
    if (menu !== undefined) query.set("menu", required(menu, "menu"));
    const result = await this.request(
      "/auth/oauthout/getOauth2Token?" + query,
      { method: "GET" },
      signal,
    );
    if (typeof result?.access_token !== "string" || !result.access_token)
      throw Error("DMS 取参回执不完整");
    return result;
  }
  async submit(order: Order, accessToken: string, signal: AbortSignal) {
    const result = await this.request(
      "/dms/order/dmsOrderHead/submitZcOrderDirect",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(order),
      },
      signal,
    );
    if (
      !result ||
      result.aiPreOrderCode !== order.aiPreOrderCode ||
      typeof result.orderCode !== "string" ||
      !result.orderCode.trim()
    )
      throw Error("DMS 订单回执不匹配");
    return {
      orderCode: result.orderCode as string,
      aiPreOrderCode: order.aiPreOrderCode,
    };
  }
}

/** Persist intent before sending: absent upstream idempotency, unknown writes must never be replayed. */
export async function submitDmsOrder(
  directory: string,
  owner: string,
  order: Order,
  client: DmsClient,
  signal: AbortSignal,
) {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const file = join(directory, hash(JSON.stringify([owner, order.aiPreOrderCode])) + ".json");
  const fingerprint = hash(JSON.stringify(order));
  const existing = async () => {
    const saved = JSON.parse(await readFile(file, "utf8"));
    signal.throwIfAborted();
    if (saved.fingerprint !== fingerprint) throw Error("预订单号已用于另一份订单，请核查原订单");
    if (saved.receipt) return saved.receipt as { orderCode: string; aiPreOrderCode: string };
    throw Error(`DMS订单 ${order.aiPreOrderCode} 处理中或结果未知，请在DMS核查；禁止重复提交`);
  };
  try {
    return await existing();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const login = await client.login(signal);
  signal.throwIfAborted();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, JSON.stringify({ fingerprint, state: "unknown" }), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return existing();
    throw error;
  }
  try {
    const receipt = await client.submit(order, login.accessToken, signal);
    // Store an acknowledged result even if the owning page disappears during persistence.
    const temp = file + "." + randomUUID();
    await writeFile(temp, JSON.stringify({ fingerprint, receipt }), {
      mode: 0o600,
    });
    await rename(temp, file);
    signal.throwIfAborted();
    return receipt;
  } catch {
    throw Error(`DMS订单 ${order.aiPreOrderCode} 未取得可确认回执，请在DMS核查；禁止重复提交`);
  }
}
