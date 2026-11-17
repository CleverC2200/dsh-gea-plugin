import type { RuntimePackageProof } from "../src/shared/plugin-update-state.ts";

export class CompanyInstallation {
  constructor(profile: string, coreHead: string);
  readonly profile: string;
  readonly coreHead: string;
  readonly directory: string;
  initialize(prepare?: (directory: string) => Promise<void>): Promise<void>;
  prepare(
    id: string,
    install: (
      directory: string,
      controls: { registerProcess(pid: number): Promise<void> },
    ) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  beginBoot(): Promise<{ id: string; path: string }>;
  confirmRuntime(proofs: RuntimePackageProof[]): Promise<boolean>;
  ownsModules(path: string): Promise<boolean>;
  rollback(reason: string): Promise<{ changed: boolean; fallback: string }>;
}
export function openCompanyInstallation(profile: string): Promise<CompanyInstallation | null>;
