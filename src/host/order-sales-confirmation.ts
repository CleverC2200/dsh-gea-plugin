import { prepareGatewaySession } from "./gateway-session.ts";

type Identity = { token: string; tenantId: string };
type Grant = Awaited<ReturnType<typeof prepareGatewaySession>>;
const grants = new WeakMap<AbortSignal, { key: string; value: Promise<Grant> }>();
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("ORDER_CONFIRMATION_PAYLOAD_INVALID");
  return value as Record<string, unknown>;
};
function selectionValue(value: unknown) {
  const selection = object(value);
  const names = ["orderNo", "customerCode", "base", "start", "endExclusive"];
  if (
    Object.keys(selection).some((key) => !names.includes(key)) ||
    names.some((key) => {
      const item = selection[key];
      return typeof item !== "string" || !item.trim() || item.length > 160;
    }) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(String(selection.start)) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(String(selection.endExclusive))
  )
    throw Error("ORDER_CONFIRMATION_SELECTION_INVALID");
  return Object.fromEntries(names.map((name) => [name, selection[name]]));
}

/** 专用订单动作；页面不能选择 Consumer、路由、接收人、机器人、SQL 或业务执行动作。 */
export async function orderSalesConfirmation(
  payload: unknown,
  scope: {
    enabled: boolean;
    base: string;
    auth: Identity;
    identity: AbortSignal;
    signal: AbortSignal;
    timeoutMs: number;
  },
  fetchImpl: typeof fetch,
) {
  const input = { ...object(payload) };
  if (!scope.enabled) {
    if (input.operation === "capabilities" && Object.keys(input).length === 1)
      return { available: false };
    throw Error("ORDER_CONFIRMATION_NOT_ENABLED");
  }
  if (
    Object.keys(input).some(
      (key) => !["operation", "selection", "selections", "requestId"].includes(key),
    ) ||
    !["create", "status", "lookup", "lookup_batch", "capabilities"].includes(
      String(input.operation),
    )
  )
    throw Error("ORDER_CONFIRMATION_PAYLOAD_INVALID");
  const capabilities = input.operation === "capabilities";
  const batch = input.operation === "lookup_batch";
  if (
    batch &&
    (!Array.isArray(input.selections) || !input.selections.length || input.selections.length > 20)
  )
    throw Error("ORDER_CONFIRMATION_BATCH_INVALID");
  const selections = batch ? (input.selections as unknown[]).map(selectionValue) : [];
  const selection = capabilities || batch ? {} : selectionValue(input.selection);
  if (batch ? input.selection !== undefined : input.selections !== undefined)
    throw Error("ORDER_CONFIRMATION_PAYLOAD_INVALID");
  const creating = input.operation === "create";
  if (
    input.operation === "status"
      ? typeof input.requestId !== "string" || !/^order-sales-[a-f0-9]{64}$/.test(input.requestId)
      : input.requestId !== undefined || (capabilities && input.selection !== undefined)
  )
    throw Error("ORDER_CONFIRMATION_PAYLOAD_INVALID");
  const signal = AbortSignal.any([
    scope.signal,
    scope.identity,
    AbortSignal.timeout(scope.timeoutMs),
  ]);
  const key = JSON.stringify([scope.base, scope.auth.token, scope.auth.tenantId]);
  const authorize = () => {
    let cached = grants.get(scope.identity);
    if (!cached || cached.key !== key) {
      const value = prepareGatewaySession(
        scope.base,
        scope.auth,
        { consumerType: "AGENT", consumerCode: "order01" },
        scope.identity,
        scope.timeoutMs,
        fetchImpl,
      );
      cached = { key, value };
      grants.set(scope.identity, cached);
      value.catch(() => {
        if (grants.get(scope.identity) === cached) grants.delete(scope.identity);
      });
    }
    return cached.value;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const grant = await authorize();
    signal.throwIfAborted();
    const response = await fetchImpl(
      scope.base.replace(/\/$/, "") +
        "/ai/order-fulfillment/confirmation/" +
        (creating ? "requests" : input.operation),
      {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-Delegation-Token": grant.delegationToken,
        },
        body: JSON.stringify(
          batch
            ? { selections }
            : input.operation === "status"
              ? { requestId: input.requestId, selection }
              : selection,
        ),
      },
    );
    const body = object(await response.json());
    signal.throwIfAborted();
    const code = body.errorCode ?? body.code;
    if (
      attempt === 0 &&
      [
        "AI_GATEWAY_SESSION_EXPIRED",
        "AI_GATEWAY_SESSION_MAX_LIFETIME_EXCEEDED",
        "AI_GATEWAY_TOKEN_EXPIRED",
      ].includes(String(code))
    ) {
      grants.delete(scope.identity);
      continue;
    }
    if (!response.ok || body.success !== true)
      throw Object.assign(
        Error(
          typeof body.message === "string" && body.message
            ? body.message
            : "ORDER_CONFIRMATION_REQUEST_FAILED",
        ),
        { code, requestId: body.requestId, retryable: body.retryable },
      );
    return object(body.result);
  }
  throw Error("ORDER_CONFIRMATION_SESSION_REJECTED");
}
