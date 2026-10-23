import { randomUUID } from "node:crypto";
import { SalesReadonlyError } from "../shared/sales-readonly.js";
import { geaResponseError } from "../shared/gea-error.js";

type Identity = { token: string; tenantId?: string };
type Request = {
  path: string;
  identity: Identity | undefined;
  signal: AbortSignal;
} & (
  | { kind: "read"; includeTenant: boolean; purpose?: string }
  | { kind: "write"; body: unknown }
  | { kind: "claim"; includeTenant: boolean }
);

/** GEA envelope transport; Business retains identity authority and protocol-specific consumers. */
export class GatewayRequests {
  constructor(
    private readonly owner: {
      scope(): { base: string; signal: AbortSignal };
      timeoutMs: number;
      fetch(url: string, init: RequestInit, purpose?: string): Promise<Response>;
      expire(identity: Identity | undefined): void;
      decode(raw: string, path: string): Record<string, unknown>;
    },
  ) {}

  read(
    path: string,
    identity: Identity | undefined,
    signal: AbortSignal,
    includeTenant = true,
    purpose?: string,
  ) {
    return this.request({ kind: "read", path, identity, signal, includeTenant, purpose });
  }

  write(path: string, identity: Identity, signal: AbortSignal, body: unknown) {
    return this.request({ kind: "write", path, identity, signal, body });
  }

  claim(path: string, identity: Identity, signal: AbortSignal, includeTenant = true) {
    return this.request({ kind: "claim", path, identity, signal, includeTenant });
  }

  private async request(input: Request): Promise<unknown> {
    const scope = this.owner.scope();
    const timeout = AbortSignal.timeout(this.owner.timeoutMs);
    const active = () => {
      if (input.signal.aborted || scope.signal.aborted) throw new Error("STALE_SELECTION");
      if (timeout.aborted) throw new Error("GEA_REQUEST_TIMEOUT");
    };
    active();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (input.identity) {
      headers["X-Access-Token"] = input.identity.token;
      headers["X-Request-Id"] = randomUUID();
      if ((input.kind === "write" || input.includeTenant) && input.identity.tenantId)
        headers["X-Tenant-Id"] = input.identity.tenantId;
    }
    if (input.kind === "write") headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await this.owner.fetch(
        scope.base + input.path,
        {
          method: input.kind === "read" ? "GET" : "POST",
          headers,
          ...(input.kind === "write" ? { body: JSON.stringify(input.body) } : {}),
          redirect: "error",
          signal: AbortSignal.any([input.signal, scope.signal, timeout]),
        },
        input.kind === "read" ? input.purpose : undefined,
      );
    } catch (error) {
      active();
      if (error instanceof SalesReadonlyError) throw error;
      throw new Error("GEA_NETWORK_ERROR");
    }
    active();
    if (!response.ok) {
      const error =
        input.kind === "claim"
          ? new Error("GEA_MODEL_HTTP_" + response.status)
          : await geaResponseError(response, [input.identity?.token]);
      active();
      if (response.status === 401) this.owner.expire(input.identity);
      throw error;
    }
    let data: Record<string, unknown>;
    try {
      data = this.owner.decode(await response.text(), input.path);
    } catch (error) {
      active();
      if (input.kind === "read") throw new Error("GEA_INVALID_JSON");
      throw error;
    }
    active();
    if (data.success !== true) {
      const code = data.errorCode;
      if (
        typeof code === "string" &&
        (input.kind === "read"
          ? /^NOTIFICATION_[A-Z_]+$/.test(code)
          : input.kind === "write" && /^(NOTIFICATION|APPROVAL)_[A-Z_]+$/.test(code))
      ) {
        if (code === "NOTIFICATION_UNAUTHENTICATED") this.owner.expire(input.identity);
        throw new Error(code);
      }
      throw new Error(
        input.kind === "claim" ? "GEA_MODEL_REQUEST_REJECTED" : "GEA_REQUEST_REJECTED",
      );
    }
    return data.result;
  }
}
