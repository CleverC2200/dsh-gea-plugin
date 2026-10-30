import type { DmsConfig, DmsEnvironments } from "./dms-orders.ts";
import { FC_DMS_TEST_SIGNING_SECRET } from "./fc-dms-test-credential.ts";

export const FC_DMS_TEST_GATEWAY = "http://100.100.1.147:8000/synear_test/DMS";

/** Custom gateways retain explicit authorization; the fixed sandbox is shared by design. */
export function resolveFcDmsDeployment(
  deployments: DmsEnvironments | undefined,
  environment: "production" | "test",
  identity: { tenantId: string; id: string },
): DmsConfig {
  const configured = deployments?.[environment];
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
