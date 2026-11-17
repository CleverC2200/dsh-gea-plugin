export type GeaEnvironment = "production" | "test";
export function resolveEnvironments(config: {
  environment?: GeaEnvironment;
  geaBaseUrl?: string;
  geaEnvironments?: { production: string; test: string };
}): {
  environment: GeaEnvironment;
  environments: Record<string, string>;
  baseUrl: string;
};
