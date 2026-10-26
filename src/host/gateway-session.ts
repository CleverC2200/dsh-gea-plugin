/** 当前登录身份的 Gateway 握手规则。页面 launch 和 MCP transport 共用。 */
import { randomUUID } from "node:crypto";
import { throwIfAborted } from "../shared/abort.ts";

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export async function prepareGatewaySession(
  base: string,
  auth: { token: string; tenantId: string },
  consumer: { consumerType: "AGENT" | "CLIENT_APP"; consumerCode: string },
  identity: AbortSignal,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  conversationId: string = randomUUID(),
) {
  if (!["AGENT", "CLIENT_APP"].includes(consumer.consumerType) || !consumer.consumerCode.trim())
    throw new Error("GEA_MCP_CONSUMER_REQUIRED");
  throwIfAborted(identity);
  const signal = AbortSignal.any([identity, AbortSignal.timeout(timeoutMs)]);
  const request: RequestInit = {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-Access-Token": auth.token,
      "X-Tenant-Id": auth.tenantId,
    },
    body: JSON.stringify({
      ...consumer,
      conversationId,
      requestId: randomUUID(),
      channel: "MCP_CLIENT",
    }),
  };
  const send = () => fetchImpl(base + "/ai/gateway/session", request);
  let response: Response;
  try {
    response = await send();
  } catch (error) {
    throwIfAborted(signal);
    let cause: unknown = error,
      reset = false;
    for (let depth = 0; depth < 5 && cause; depth++) {
      const item = record(cause);
      if (item?.code === "ECONNRESET" || item?.code === "UND_ERR_SOCKET") reset = true;
      cause = item?.cause;
    }
    if (consumer.consumerType !== "AGENT" || consumer.consumerCode !== "order" || !reset)
      throw error;
    response = await send();
  }
  if (!response.ok) throw new Error("GEA_MCP_SESSION_HTTP_" + response.status);
  const payload = record(await response.json());
  throwIfAborted(identity);
  const result = record(payload?.result);
  const decision = record(result?.accessDecision);
  const context = record(result?.gatewayContext);

  // 权限没开通和"请求/会话本身有问题"要分开：前者是正常业务状态，不该显示成调用失败。
  if (decision?.allowed === false)
    throw Object.assign(
      new Error(
        "AGENT_ACCESS_DENIED: " +
          (typeof decision.message === "string" && decision.message.trim()
            ? decision.message
            : "当前用户无权访问该Agent"),
      ),
      {
        code: "AGENT_ACCESS_DENIED",
        accessDecisionCode:
          typeof decision.code === "string" ? decision.code : "AGENT_ACCESS_DENIED",
        retryable: false,
      },
    );
  if (
    payload?.success !== true ||
    decision?.allowed !== true ||
    !nonempty(context?.sessionId) ||
    !nonempty(context?.conversationId) ||
    !nonempty(result?.delegationToken) ||
    context?.consumerType !== consumer.consumerType ||
    context?.consumerCode !== consumer.consumerCode
  )
    throw new Error("GEA_MCP_SESSION_REJECTED");
  return {
    sessionId: context.sessionId,
    conversationId: context.conversationId,
    delegationToken: result.delegationToken,
    ...(consumer.consumerType === "AGENT" ? { agentCode: consumer.consumerCode } : {}),
  };
}
