export type CompanyUpdateReceipt = {
  schema: 1;
  id: string;
  phase: "prepared" | "installing" | "verifying" | "completed" | "failed" | "cancelled";
  desktopVersion: string;
  processIdentity: string;
  targets: {
    name: string;
    version: string;
    sha256: string;
    supportedCores: { head: string; version: string }[];
  }[];
  expected: { name: string; version: string }[] | null;
};
export function companyUpdatePath(profile: string): string;
export function parseCompanyUpdate(value: unknown): CompanyUpdateReceipt;
export function readCompanyUpdate(profile: string): Promise<CompanyUpdateReceipt | null>;
export function companyUpdateActive(receipt: CompanyUpdateReceipt | null): boolean;
export function companyUpdateFinished(
  receipt: CompanyUpdateReceipt | null,
  desktopVersion: string | undefined,
  processIdentity: string,
  items: {
    packageName: string;
    installedVersion: string | null;
    runningHostVersion: string | null;
    runningClientVersion: string | null;
  }[],
): boolean;
