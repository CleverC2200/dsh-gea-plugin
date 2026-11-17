import { resolveMemoryGatewayUrl } from "../shared/memory-gateway.js";
import type { GeaEnvironment } from "../shared/environments.js";
import { resolveFcDmsDeployment } from "./fc-dms-default.ts";
import type { DmsEnvironments } from "./dms-orders.ts";

type Scope = {
  environment: GeaEnvironment;
  base: string;
  signal: AbortSignal;
  identity?: { token: string; tenantId?: string; id: string };
};

const contains = (url: URL, base: string) =>
  url.href === base || url.href.startsWith(base + "/") || url.href.startsWith(base + "?");

export class DeploymentTransport {
  private readonly memory: string | undefined;
  private readonly warning: Partial<Record<GeaEnvironment, string>> = {};
  private readonly models = new Map<string, { secret: string; signal: AbortSignal }>();

  constructor(
    private readonly config: {
      environments: Partial<Record<GeaEnvironment, string>>;
      warningSchedulerEnvironments?: Partial<Record<GeaEnvironment, string>>;
      memoryGatewayUrl?: string;
      memoryGatewayAllowPrivateHttp?: boolean;
      dms?: DmsEnvironments;
    },
    private readonly scope: () => Scope,
    private readonly send: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {
    this.memory = resolveMemoryGatewayUrl(
      config.memoryGatewayUrl,
      config.memoryGatewayAllowPrivateHttp,
    );
    const warning =
      config.warningSchedulerEnvironments ??
      (config.environments.production === "https://gea.synear.cn/gea-boot"
        ? { production: "https://gea.synear.cn:4443/gea-warning/client" }
        : {});
    for (const [environment, raw] of Object.entries(warning)) {
      if (environment !== "production" && environment !== "test")
        throw Error("INVALID_GEA_ENVIRONMENT");
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
        throw Error("INVALID_WARNING_SCHEDULER_URL");
      if (
        Object.entries(config.environments).some(
          ([name, base]) => name !== environment && base && contains(url, base),
        )
      )
        throw Error("GEA_TARGET_ENVIRONMENT_MISMATCH");
      this.warning[environment] = url.href.replace(/\/$/, "");
    }
  }

  warningUrl(): string {
    const url = this.warning[this.scope().environment];
    if (!url) throw Error("WARNING_SCHEDULER_NOT_CONFIGURED");
    return url;
  }

  allowModel(base: string, secret: string): void {
    this.models.set(base, { secret, signal: this.scope().signal });
  }

  clearModels(): void {
    this.models.clear();
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const scope = this.scope();
    const caller = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = AbortSignal.any([scope.signal, ...(caller ? [caller] : [])]);
    signal.throwIfAborted();
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.username || url.password) throw Error("GEA_TARGET_CREDENTIALS_FORBIDDEN");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    for (const [key, value] of new Headers(init?.headers)) headers.set(key, value);
    let forwardingHeaders = init?.headers;
    const requireIdentity = () => {
      if (!scope.identity || headers.get("X-Access-Token") !== scope.identity.token)
        throw Error("GEA_TARGET_IDENTITY_MISMATCH");
      if (headers.has("X-Tenant-Id") && headers.get("X-Tenant-Id") !== scope.identity.tenantId)
        throw Error("GEA_TARGET_TENANT_MISMATCH");
    };
    const gateways = Object.entries(this.config.environments).filter(
      ([, base]) => base && contains(url, base),
    );
    const model = [...this.models].find(
      ([base, grant]) =>
        contains(url, base) && grant.signal === scope.signal && !grant.signal.aborted,
    );
    if (this.memory && contains(url, this.memory + "/v1/memory")) {
      requireIdentity();
      if (headers.get("X-GEA-Environment") !== scope.environment)
        throw Error("GEA_TARGET_ENVIRONMENT_MISMATCH");
    } else if (Object.values(this.warning).some((base) => base && url.href === base)) {
      if (url.href !== this.warning[scope.environment])
        throw Error("GEA_TARGET_ENVIRONMENT_MISMATCH");
      requireIdentity();
      headers.set("X-GEA-Environment", scope.environment);
      forwardingHeaders = headers;
    } else if (model) {
      if (
        headers.get("Authorization") !== "Bearer " + model[1].secret ||
        headers.has("X-Access-Token")
      )
        throw Error("GEA_TARGET_IDENTITY_MISMATCH");
    } else if (gateways.length) {
      if (!contains(url, scope.base)) throw Error("GEA_TARGET_ENVIRONMENT_MISMATCH");
      if (headers.has("Authorization")) throw Error("GEA_TARGET_IDENTITY_MISMATCH");
      if (scope.identity && headers.has("X-Access-Token")) requireIdentity();
    } else {
      if (!scope.identity) throw Error("GEA_TARGET_NOT_REGISTERED");
      const dms = resolveFcDmsDeployment(this.config.dms, scope.environment, {
        ...scope.identity,
        tenantId: scope.identity.tenantId ?? "",
      });
      if (!contains(url, dms.gatewayUrl)) throw Error("GEA_TARGET_NOT_REGISTERED");
      if (
        headers.has("X-Access-Token") ||
        headers.get("Authorization") === "Bearer " + scope.identity.token
      )
        throw Error("GEA_TARGET_IDENTITY_MISMATCH");
    }
    const response = await this.send(input, {
      ...init,
      ...(forwardingHeaders ? { headers: forwardingHeaders } : {}),
      signal,
      redirect: "error",
    });
    if (signal.aborted) {
      await response.body?.cancel();
      signal.throwIfAborted();
    }
    return response;
  };
}
