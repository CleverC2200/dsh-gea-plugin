import type { Business } from "./host/business.ts";

const IDENTITY_STARTUP_GRACE_MS = 20_000;

type IdentityStatus = Readonly<
  Pick<
    ReturnType<Business["status"]>,
    "environment" | "environments" | "authenticated" | "loginState"
  > & {
    user: Readonly<
      Partial<
        Pick<
          NonNullable<ReturnType<Business["status"]>["user"]>,
          "id" | "tenantId" | "username" | "name" | "avatar"
        >
      >
    > | null;
  }
>;
class IdentityObservationError extends Error {
  readonly code: string;
  readonly recoverable: boolean;
  constructor(code: string, recoverable: boolean, message: string) {
    super(message);
    this.code = code;
    this.recoverable = recoverable;
  }
}

export type IdentitySnapshot = Readonly<{
  state: "unknown" | "confirmed" | "error";
  scope: string | null;
  subject: string | null;
  status: IdentityStatus | null;
  customerInventory: CustomerInventoryIdentity | null;
  error?: string;
  errorCode?: string;
}>;
export type CustomerInventoryIdentity = Readonly<{
  roleCodes: string[];
  roleNames: string[];
  roles: Array<{ code: string; name: string | null }>;
  customerInventoryScope: {
    status: "granted" | "unconfigured";
    regions: string[];
    provinces: string[];
    customerCodes: string[];
    version: string | null;
    expiresAt: string | null;
  };
}>;
export interface BusinessIdentityProjection {
  getSnapshot(): IdentitySnapshot;
  subscribe(listener: () => void): () => void;
  readScope(signal?: AbortSignal): Promise<string | null>;
}

/** Read the Host-owned authority; clients never derive a scope from user labels. */
async function requestBusinessIdentityScope(signal?: AbortSignal): Promise<{
  scope: string | null;
  subject: string | null;
  status: IdentityStatus | null;
  customerInventory: CustomerInventoryIdentity | null;
}> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(5000);
  try {
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch("/api/gea-html/identity", {
      cache: "no-store",
      signal: requestSignal,
    });
    if (!response.ok)
      throw new IdentityObservationError(
        `IDENTITY_HTTP_${response.status}`,
        response.status === 404 ||
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
        "登录状态读取失败，请重试。",
      );
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new IdentityObservationError(
        "IDENTITY_INVALID_RESPONSE",
        false,
        "身份服务返回无效，请重试。",
      );
    }
    requestSignal.throwIfAborted();
    if (
      !value ||
      typeof value !== "object" ||
      !("status" in value) ||
      !value.status ||
      typeof value.status !== "object" ||
      !("scope" in value) ||
      (value.scope !== null && typeof value.scope !== "string")
    )
      throw new IdentityObservationError(
        "IDENTITY_INVALID_RESPONSE",
        false,
        "身份服务返回无效，请重试。",
      );
    const status = value.status;
    if (
      !("authenticated" in status) ||
      typeof status.authenticated !== "boolean" ||
      !("environment" in status) ||
      !["production", "test"].includes(String(status.environment)) ||
      !("loginState" in status) ||
      !["authenticated", "signed-out", "expired"].includes(String(status.loginState)) ||
      !("user" in status) ||
      (status.user !== null && (typeof status.user !== "object" || Array.isArray(status.user)))
    )
      throw new IdentityObservationError(
        "IDENTITY_INVALID_RESPONSE",
        false,
        "身份服务返回无效，请重试。",
      );
    if (
      (status.authenticated && status.loginState !== "authenticated") ||
      (!status.authenticated && status.loginState === "authenticated")
    )
      throw new IdentityObservationError(
        "IDENTITY_INVALID_RESPONSE",
        false,
        "身份服务返回无效，请重试。",
      );
    const user = status.user;
    if (
      (user &&
        (("name" in user && typeof user.name !== "string") ||
          ("avatar" in user && user.avatar !== undefined && typeof user.avatar !== "string") ||
          ("id" in user && typeof user.id !== "string") ||
          ("tenantId" in user &&
            user.tenantId !== undefined &&
            typeof user.tenantId !== "string") ||
          ("username" in user && typeof user.username !== "string"))) ||
      ("subject" in value && value.subject !== null && typeof value.subject !== "string") ||
      ("environments" in status &&
        (!Array.isArray(status.environments) ||
          !status.environments.every((item: unknown) => typeof item === "string")))
    )
      throw new IdentityObservationError(
        "IDENTITY_INVALID_RESPONSE",
        false,
        "身份服务返回无效，请重试。",
      );
    return {
      scope: value.scope,
      subject: "subject" in value && typeof value.subject === "string" ? value.subject : null,
      status: {
        environment: status.environment === "test" ? "test" : "production",
        environments:
          "environments" in status && Array.isArray(status.environments) ? status.environments : [],
        authenticated: status.authenticated,
        loginState: String(status.loginState),
        user: user
          ? {
              ...("id" in user && typeof user.id === "string" ? { id: user.id } : {}),
              ...("tenantId" in user && typeof user.tenantId === "string"
                ? { tenantId: user.tenantId }
                : {}),
              ...("username" in user && typeof user.username === "string"
                ? { username: user.username }
                : {}),
              ...("name" in user && typeof user.name === "string" ? { name: user.name } : {}),
              ...("avatar" in user && typeof user.avatar === "string"
                ? { avatar: user.avatar }
                : {}),
            }
          : null,
      },
      customerInventory:
        "customerInventory" in value &&
        value.customerInventory &&
        typeof value.customerInventory === "object"
          ? (value.customerInventory as CustomerInventoryIdentity)
          : null,
    };
  } catch (error) {
    if (timeout.aborted && !signal?.aborted)
      throw new IdentityObservationError("IDENTITY_TIMEOUT", true, "登录状态读取超时，请重试。");
    throw error;
  }
}

/** One read-only projection per GEA client. The Host remains the authority. */
export function createBusinessIdentityReader() {
  let snapshot: IdentitySnapshot = {
    state: "unknown",
    scope: null,
    subject: null,
    status: null,
    customerInventory: null,
  };
  let issued = 0;
  let observed = false;
  let startupDeadline: number | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const publishError = (message: string, code: string) => {
    if (snapshot.error === message && snapshot.errorCode === code) return;
    clearTimeout(startupTimer);
    startupTimer = undefined;
    snapshot = {
      ...snapshot,
      state: observed ? "confirmed" : "error",
      error: message,
      errorCode: code,
    };
    for (const listener of listeners) listener();
  };
  const beginObservation = () => {
    startupDeadline ??= Date.now() + IDENTITY_STARTUP_GRACE_MS;
    if (!observed && snapshot.state === "unknown" && Date.now() >= startupDeadline) {
      publishError("登录状态读取超时，请重试。", "IDENTITY_STARTUP_TIMEOUT");
      return;
    }
    if (!observed && snapshot.state === "unknown" && startupTimer === undefined)
      startupTimer = setTimeout(
        () => {
          startupTimer = undefined;
          if (!observed && snapshot.state === "unknown")
            publishError("登录状态读取超时，请重试。", "IDENTITY_STARTUP_TIMEOUT");
        },
        Math.max(0, startupDeadline - Date.now()),
      );
  };
  let initial: Promise<string | null> | undefined;
  let initialController: AbortController | undefined;
  const listeners = new Set<() => void>();
  const read = async (signal?: AbortSignal): Promise<string | null> => {
    signal?.throwIfAborted();
    beginObservation();
    const request = ++issued;
    try {
      const next = await requestBusinessIdentityScope(signal);
      signal?.throwIfAborted();
      if (request !== issued) return snapshot.scope;
      const previous = snapshot;
      observed = true;
      clearTimeout(startupTimer);
      startupTimer = undefined;
      snapshot = { state: "confirmed", ...next };
      if (
        previous.state !== "confirmed" ||
        previous.error ||
        previous.scope !== next.scope ||
        previous.subject !== next.subject ||
        previous.status?.authenticated !== next.status?.authenticated ||
        previous.status?.loginState !== next.status?.loginState ||
        previous.status?.environment !== next.status?.environment ||
        JSON.stringify(previous.status?.environments) !==
          JSON.stringify(next.status?.environments) ||
        previous.status?.user?.id !== next.status?.user?.id ||
        previous.status?.user?.tenantId !== next.status?.user?.tenantId ||
        previous.status?.user?.username !== next.status?.user?.username ||
        previous.status?.user?.name !== next.status?.user?.name ||
        previous.status?.user?.avatar !== next.status?.user?.avatar ||
        JSON.stringify(previous.customerInventory) !== JSON.stringify(next.customerInventory)
      ) {
        for (const listener of listeners) listener();
        if (
          previous.status !== null &&
          (previous.scope !== next.scope ||
            previous.subject !== next.subject ||
            JSON.stringify(previous.customerInventory) !== JSON.stringify(next.customerInventory))
        )
          window.dispatchEvent(
            new CustomEvent("gea-business-identity-changed", {
              detail: {
                scope: next.scope,
                subject: next.subject,
                customerInventory: next.customerInventory,
              },
            }),
          );
      }
      return next.scope;
    } catch (error) {
      if (!signal?.aborted && request === issued) {
        const recoverable =
          error instanceof TypeError ||
          (error instanceof IdentityObservationError && error.recoverable);
        if (observed || !recoverable || Date.now() >= startupDeadline!) {
          publishError(
            error instanceof Error ? error.message : String(error),
            error instanceof IdentityObservationError ? error.code : "IDENTITY_READ_FAILED",
          );
        }
      }
      throw error;
    }
  };
  const reader = ((signal?: AbortSignal) => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (snapshot.state !== "unknown") return read(signal);
    if (!initial) {
      initialController = new AbortController();
      initial = read(initialController.signal).finally(() => {
        initial = undefined;
        initialController = undefined;
      });
    }
    if (!signal) return initial;
    return new Promise<string | null>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void initial!.then(resolve, reject).then(() => signal.removeEventListener("abort", abort));
    });
  }) as typeof read &
    BusinessIdentityProjection & {
      start(): () => void;
      refresh(signal?: AbortSignal): Promise<string | null>;
    };
  reader.getSnapshot = () => snapshot;
  reader.subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  reader.readScope = async (signal) => {
    signal?.throwIfAborted();
    return snapshot.state === "confirmed" && !snapshot.error ? snapshot.scope : reader(signal);
  };
  reader.refresh = read;
  reader.start = () => {
    beginObservation();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await reader(controller.signal);
      } catch {
        /* Keep the last Host confirmation. */
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      controller.abort();
      initialController?.abort();
      clearTimeout(startupTimer);
      startupTimer = undefined;
      clearTimeout(timer);
    };
  };
  return reader;
}
