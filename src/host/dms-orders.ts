import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { dmsSigningSecret } from "./fc-dms-default.ts";

export interface DmsConfig {
  gatewayUrl: string;
  manageUrl?: string;
  secretEnv: string;
  credentialSource?: "fc-bundled-dms-test" | "fc-bundled-dms-production";
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
  customerCode: string;
  addressCode: string;
  pupCode: string;
  itemList: { productCode: string; quantity: number }[];
};
const required = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 500)
    throw Error(`DMS 参数无效：${field}`);
  return value.trim();
};

export function parseDmsOrder(input: unknown): Order {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("DMS 订单参数无效");
  const source = input as Record<string, unknown>;
  const order = {} as Order;
  const fields = ["aiPreOrderCode", "customerCode", "addressCode", "pupCode"];
  const optional = [
    "customerName",
    "orderModel",
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
  if (order.orderModel !== undefined && order.orderModel !== "cg")
    throw Error("DMS 参数无效：orderModel");
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
class DmsRequestRejection extends Error {}
class DmsRequestNotSent extends Error {}

function dmsResponseMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  for (const field of ["message", "msg"]) {
    if (!(field in body)) continue;
    const value = Reflect.get(body, field);
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 1000);
  }
  return undefined;
}

function savedDmsRejection(saved: unknown): string {
  if (!saved || typeof saved !== "object" || !("dmsRejectionMessage" in saved)) return "";
  return typeof saved.dmsRejectionMessage === "string"
    ? saved.dmsRejectionMessage.slice(0, 1100) + "。"
    : "";
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
    if (signal.aborted && path === "/dms/order/dmsOrderHead/submitZcOrderDirect")
      throw new DmsRequestNotSent("订单尚未发送至DMS，可重新暂存");
    signal.throwIfAborted();
    const base = baseUrl(this.config.gatewayUrl);
    const response = await this.transport(base.href.replace(/\/$/, "") + path, {
      ...init,
      signal,
      redirect: "error",
    });
    const body = await response.json().catch(() => null);
    signal.throwIfAborted();
    let message = dmsResponseMessage(body);
    if (message) {
      const authorization = new Headers(init.headers).get("Authorization");
      for (const credential of [
        dmsSigningSecret(this.config),
        authorization?.replace(/^Bearer\s+/i, ""),
      ])
        if (credential) message = message.split(credential).join("[已隐藏]");
    }
    message = message?.slice(0, 1000);
    if (!response.ok || body?.success !== true || body?.code !== 200) {
      if (message) throw new DmsRequestRejection(`DMS返回：${message}`);
      if (!response.ok) throw Error(`DMS 请求失败（HTTP ${response.status}）`);
      if (!body) throw Error("DMS未返回可解析的JSON回执");
      throw new DmsRequestRejection("DMS 拒绝请求，未返回具体原因，请在DMS核查");
    }
    return { result: body.result, message };
  }
  assertConfigured() {
    baseUrl(this.config.gatewayUrl);
    if (this.config.manageUrl) baseUrl(this.config.manageUrl);
    required(this.identity.username?.trim() || this.identity.workcode?.trim(), "登录账号");
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(this.config.secretEnv)) throw Error("DMS 密钥环境变量配置无效");
    if (!dmsSigningSecret(this.config)) throw Error("DMS 签名密钥未配置");
  }
  async login(signal: AbortSignal) {
    this.assertConfigured();
    const username = this.identity.username?.trim(),
      workcode = this.identity.workcode?.trim();
    const key = required(username || workcode, "登录账号");
    const secret = dmsSigningSecret(this.config);
    const time = String(Date.now());
    const sign = createHash("md5")
      .update(key + time + secret)
      .digest("hex");
    const { result } = await this.request(
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
            menu: "/corder/ordermgt",
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
    const manage = this.config.manageUrl ? baseUrl(this.config.manageUrl) : undefined;
    if (
      !["http:", "https:"].includes(redirect.protocol) ||
      (manage !== undefined && redirect.origin !== manage.origin) ||
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

  async exchange(key: string, menu: string | undefined, signal: AbortSignal) {
    const query = new URLSearchParams({ key: required(key, "key") });
    if (menu !== undefined) query.set("menu", required(menu, "menu"));
    const { result } = await this.request(
      "/auth/oauthout/getOauth2Token?" + query,
      { method: "GET" },
      signal,
    );
    if (typeof result?.access_token !== "string" || !result.access_token)
      throw Error("DMS 取参回执不完整");
    return result;
  }
  async submit(order: Order, accessToken: string, signal: AbortSignal) {
    const { result, message } = await this.request(
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
      ...(message ? { dmsMessage: message } : {}),
    };
  }
}

export async function submitOwnedDmsOrder(
  directory: string,
  owner: string,
  input: unknown,
  client: DmsClient,
  signal: AbortSignal,
  warehouseCode?: string,
) {
  const order = parseDmsOrder(input);
  const requestAiPreOrderCode = order.aiPreOrderCode;
  order.aiPreOrderCode =
    "AI" +
    createHash("sha256")
      .update(JSON.stringify([owner, requestAiPreOrderCode]))
      .digest("hex")
      .slice(0, 30);
  const lane = batchLane(directory, owner, warehouseCode ?? String(order.customerCode));
  const receipt = await submitDmsOrder(directory, owner, order, client, signal, {
    lockFile: join(lane, "admission"),
    claim: () =>
      claimDmsBatch(directory, owner, warehouseCode ?? String(order.customerCode), order, signal),
  });
  return { ...receipt, requestAiPreOrderCode };
}

const intentPath = (directory: string, owner: string, id: string) =>
  join(
    directory,
    createHash("sha256")
      .update(JSON.stringify([owner, id]))
      .digest("hex") + ".json",
  );

async function readDmsIntent(directory: string, owner: string, id: string) {
  try {
    return JSON.parse(await readFile(intentPath(directory, owner, id), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const batchLane = (directory: string, owner: string, warehouse: string) =>
  join(
    directory,
    "batches",
    createHash("sha256")
      .update(JSON.stringify([owner, warehouse]))
      .digest("hex"),
  );

async function claimDmsBatch(
  directory: string,
  owner: string,
  warehouse: string,
  order: Order,
  signal: AbortSignal,
) {
  const lane = batchLane(directory, owner, warehouse);
  await mkdir(lane, { recursive: true, mode: 0o700 });
  const fingerprint = createHash("sha256").update(JSON.stringify(order)).digest("hex");
  for (let attempt = 0; attempt < 8; attempt++) {
    signal.throwIfAborted();
    const slots = (await readdir(lane)).filter((name) => /^\d{12}\.json$/.test(name)).sort();
    const last = slots.at(-1);
    if (last) {
      const previous = JSON.parse(await readFile(join(lane, last), "utf8"));
      const saved = await readDmsIntent(directory, owner, previous.aiPreOrderCode);
      if (saved && saved.state !== "not-sent") {
        if (previous.aiPreOrderCode === order.aiPreOrderCode) {
          if (previous.fingerprint !== fingerprint)
            throw Error("同一补货批次内容已变化，请核对原订单");
          return;
        }
        if (
          !saved.receipt ||
          typeof saved.receipt.orderCode !== "string" ||
          !saved.receipt.orderCode.trim() ||
          saved.receipt.aiPreOrderCode !== previous.aiPreOrderCode ||
          saved.fingerprint !== previous.fingerprint
        )
          throw Error(
            `${savedDmsRejection(saved)}本地未确认DMS订单 ${previous.aiPreOrderCode} 的结果，结果未知，请先到DMS核对原批次；禁止新批次下单`,
          );
      }
    }
    const next = String(last ? Number(last.slice(0, 12)) + 1 : 1).padStart(12, "0") + ".json";
    try {
      await writeFile(
        join(lane, next),
        JSON.stringify({ aiPreOrderCode: order.aiPreOrderCode, fingerprint }),
        { flag: "wx", mode: 0o600 },
      );
      signal.throwIfAborted();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw Error("补货批次正在并发确认，请稍后核对原批次");
}

export async function submitDmsOrder(
  directory: string,
  owner: string,
  order: Order,
  client: DmsClient,
  signal: AbortSignal,
  admission?: { lockFile: string; claim: () => Promise<void> },
) {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const file = intentPath(directory, owner, order.aiPreOrderCode);
  const fingerprint = hash(JSON.stringify(order));
  const existing = async () => {
    const saved = JSON.parse(await readFile(file, "utf8"));
    signal.throwIfAborted();
    if (saved.state === "not-sent") return null;
    if (saved.fingerprint !== fingerprint) throw Error("预订单号已用于另一份订单，请核查原订单");
    if (saved.receipt) return saved.receipt as Awaited<ReturnType<DmsClient["submit"]>>;
    throw Error(
      `${savedDmsRejection(saved)}本地未确认DMS订单 ${order.aiPreOrderCode} 的结果，结果未知，请先到DMS核对；禁止重复提交`,
    );
  };
  const readExisting = async () => {
    try {
      return await existing();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      return null;
    }
  };
  const saved = await readExisting();
  if (saved) return saved;
  let login: Awaited<ReturnType<DmsClient["login"]>>;
  try {
    login = await client.login(signal);
    signal.throwIfAborted();
  } catch (error) {
    throw Error(
      `订单尚未发送至DMS，可修正后重新暂存。${error instanceof Error ? error.message : "登录失败"}`,
    );
  }
  const reserve = async () => {
    const previous = await readExisting();
    if (previous) return previous;
    signal.throwIfAborted();
    await admission?.claim();
    signal.throwIfAborted();
    await writeFileAtomic(file, JSON.stringify({ fingerprint, state: "unknown" }), { mode: 0o600 });
    return null;
  };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  if (admission) await mkdir(dirname(admission.lockFile), { recursive: true, mode: 0o700 });
  const reserveIntent = () => withFileLock(file, reserve);
  const previous = admission
    ? await withFileLock(admission.lockFile, reserveIntent)
    : await reserveIntent();
  if (previous) return previous;
  if (signal.aborted) {
    await writeFileAtomic(file, JSON.stringify({ fingerprint, state: "not-sent" }), {
      mode: 0o600,
    });
    throw new DmsRequestNotSent("订单尚未发送至DMS，可重新暂存");
  }
  try {
    const receipt = await client.submit(order, login.accessToken, signal);

    const temp = file + "." + randomUUID();
    await writeFile(temp, JSON.stringify({ fingerprint, receipt }), {
      mode: 0o600,
    });
    await rename(temp, file);
    signal.throwIfAborted();
    return receipt;
  } catch (error) {
    if (error instanceof DmsRequestNotSent) {
      await writeFileAtomic(file, JSON.stringify({ fingerprint, state: "not-sent" }), {
        mode: 0o600,
      });
      throw error;
    }
    if (error instanceof DmsRequestRejection)
      await writeFileAtomic(
        file,
        JSON.stringify({
          fingerprint,
          state: "unknown",
          dmsRejectionMessage: error.message,
        }),
        { mode: 0o600 },
      );
    const reason = error instanceof DmsRequestRejection ? `${error.message}。` : "";
    throw Error(
      `${reason}DMS订单 ${order.aiPreOrderCode} 未取得可确认回执，请在DMS核查；禁止重复提交`,
    );
  }
}
