import type { RuntimePackageProof } from "../src/shared/plugin-update-state.ts";

export class CompanyInstallation {
  constructor(profile: string, coreHead: string);
  readonly profile: string;
  readonly coreHead: string;
  readonly directory: string;
  initialize(
    prepare?: (directory: string) => Promise<void>,
    options?: { inherit?: boolean },
  ): Promise<void>;
  prepare(
    id: string,
    install: (
      directory: string,
      controls: { registerProcess(pid: number): Promise<void> },
    ) => Promise<void>,
    signal?: AbortSignal,
    options?: {
      testPlugin?: boolean;
      commitActivation?: (commit: () => Promise<void>) => Promise<void>;
    },
  ): Promise<unknown>;
  preparationIdle(): Promise<boolean>;
  hasPendingActivation(): Promise<boolean>;
  pendingTestPluginActivation(): Promise<string | null>;
  hasTestPluginActivation(): Promise<boolean>;
  activationState(id: string): Promise<"pending" | "active" | "rolled-back" | "unavailable">;
  recoverRollback(id: string): Promise<boolean>;
  beginBoot(options?: { activatePending?: boolean }): Promise<{ id: string; path: string }>;
  restoreBaselineSelection(): Promise<{ id: string; path: string }>;
  verifiedMounted(): Promise<{ id: string; path: string } | null>;
  confirmRuntime(proofs: RuntimePackageProof[]): Promise<boolean>;
  collectGarbage(): Promise<{ skipped?: string }>;
  failOperation(id: string, diagnostic: string): Promise<void>;
  ownsModules(path: string): Promise<boolean>;
  rollback(reason: string): Promise<{ changed: boolean; fallback: string }>;
}
export function openCompanyInstallation(profile: string): Promise<CompanyInstallation | null>;
