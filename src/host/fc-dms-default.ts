import type { DmsConfig, DmsEnvironments } from "./dms-orders.ts";
import { FC_DMS_PRODUCTION_SIGNING_SECRET } from "./fc-dms-production-credential.ts";
import { FC_DMS_TEST_SIGNING_SECRET } from "./fc-dms-test-credential.ts";

export const FC_DMS_PRODUCTION_GATEWAY = "http://100.100.6.46:38000/synear/dms";

export const FC_DMS_TEST_GATEWAY = "http://100.100.1.147:8000/synear_test/DMS";

/** Production uses the authenticated GEA profile; sandbox credentials never cross environments. */
export function resolveFcDmsDeployment(
  deployments: DmsEnvironments | undefined,
  environment: "production" | "test",
  identity: {
    tenantId: string;
    id: string;
    username?: string;
    workNo?: string;
  },
): DmsConfig {
  const configured = deployments?.[environment];
  if (environment === "production") {
    const deployment =
      configured && configured.gatewayUrl !== FC_DMS_TEST_GATEWAY
        ? configured
        : {
            gatewayUrl: FC_DMS_PRODUCTION_GATEWAY,
            secretEnv: "GEA_DMS_PRODUCTION_SECRET",
            credentialSource: "fc-bundled-dms-production" as const,
          };
    if ("credentialSource" in deployment && deployment.credentialSource === "fc-bundled-dms-test")
      throw Error("正式 DMS 不能使用测试签名配置");
    const workcode = identity.workNo?.trim();
    const username = identity.username?.trim();
    return {
      ...deployment,
      users: [
        {
          tenantId: identity.tenantId,
          userId: identity.id,
          ...(workcode ? { workcode } : username ? { username } : {}),
        },
      ],
    };
  }
  if (configured?.credentialSource === "fc-bundled-dms-production")
    throw Error("测试环境不能使用内置正式DMS凭据");
  if (configured && configured.gatewayUrl !== FC_DMS_TEST_GATEWAY) return configured;
  return {
    gatewayUrl: FC_DMS_TEST_GATEWAY,
    secretEnv: "GEA_DMS_TEST_SECRET",
    credentialSource: "fc-bundled-dms-test",
    users: [
      {
        tenantId: identity.tenantId,
        userId: identity.id,
        username: "zhangxin",
      },
    ],
  };
}

export function dmsSigningSecret(config: DmsConfig): string {
  if (config.credentialSource === "fc-bundled-dms-production") {
    if (config.gatewayUrl !== FC_DMS_PRODUCTION_GATEWAY)
      throw Error("内置DMS正式凭据仅限固定正式网关");
    return process.env[config.secretEnv] || FC_DMS_PRODUCTION_SIGNING_SECRET;
  }
  if (config.credentialSource === "fc-bundled-dms-test") {
    if (config.gatewayUrl !== FC_DMS_TEST_GATEWAY) throw Error("内置DMS测试凭据仅限固定测试网关");
    return FC_DMS_TEST_SIGNING_SECRET;
  }
  return process.env[config.secretEnv] ?? "";
}

export function dmsTargetNotice(config: DmsConfig): string {
  return config.credentialSource === "fc-bundled-dms-test"
    ? "DMS 测试环境（仅暂存；使用共享测试账号，与当前GEA账号独立）。"
    : "";
}
