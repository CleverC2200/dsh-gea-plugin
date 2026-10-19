import semver from "semver";
import type {
  FixedCore,
  PluginManifest,
  PluginRelease,
  PluginUpdatePlan,
} from "./plugin-release.mjs";
const namePattern = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const text = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 160) throw Error("UPDATE_STATUS_INVALID");
  return value;
};
const npmName = (value: unknown) => {
  const name = text(value);
  if (!namePattern.test(name)) throw Error("UPDATE_STATUS_INVALID");
  return name;
};
const version = (value: unknown) => {
  const result = text(value);
  if (!semver.valid(result)) throw Error("UPDATE_STATUS_INVALID");
  return result;
};
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw Error("UPDATE_STATUS_INVALID");
  return value as Record<string, unknown>;
};
/** The only wire representation permitted for detailed update failures; never a raw exception. */
export function parseUpdateProblem(value: unknown) {
  if (value === undefined) return undefined;
  const row = record(value);
  switch (row.kind) {
    case "policy": {
      const codes = [
        "source-not-configured",
        "release-not-published",
        "plan-unconfirmed",
        "conditions",
        "channel-older",
        "content-mismatch",
        "inactive",
        "restored",
        "failed",
      ] as const;
      const code = codes.find((code) => code === row.code);
      if (!code) throw Error("UPDATE_STATUS_INVALID");
      return { kind: "policy", code } as const;
    }
    case "source": {
      const codes = ["signature", "http", "unavailable"] as const;
      const code = codes.find((code) => code === row.code);
      if (!code) throw Error("UPDATE_STATUS_INVALID");
      return { kind: "source", code } as const;
    }
    case "environment":
      if (row.code === "unsupported-platform")
        return { kind: "environment", code: row.code } as const;
      throw Error("UPDATE_STATUS_INVALID");
    case "core": {
      const identity = (raw: unknown) => {
        const value = record(raw),
          revision = text(value.revision);
        if (!/^[a-f0-9]{40}$/.test(revision)) throw Error("UPDATE_STATUS_INVALID");
        return { version: version(value.version), revision };
      };
      if (!Array.isArray(row.required) || !row.required.length)
        throw Error("UPDATE_STATUS_INVALID");
      return {
        kind: "core",
        current: identity(row.current),
        required: row.required.map(identity),
      } as const;
    }
    case "dependencies": {
      if (!Array.isArray(row.requirements) || !row.requirements.length)
        throw Error("UPDATE_STATUS_INVALID");
      return {
        kind: "dependencies",
        requirements: row.requirements.map((raw) => {
          const item = record(raw),
            required = text(item.required);
          if (!/^[\w.*+^~<>=| -]*$/.test(required) || !semver.validRange(required))
            throw Error("UPDATE_STATUS_INVALID");
          return {
            consumer: npmName(item.consumer),
            dependency: npmName(item.dependency),
            required,
            installed: item.installed === null ? null : version(item.installed),
            current: item.current == null ? null : version(item.current),
            candidate: item.candidate == null ? null : version(item.candidate),
          };
        }),
      } as const;
    }
    default:
      throw Error("UPDATE_STATUS_INVALID");
  }
}
/** Safe facts owned by GEA; the optional UI capability is checked separately against its public contract. */
export type PluginUpdateProblem = NonNullable<ReturnType<typeof parseUpdateProblem>>;

export function sourceUpdateProblem(code: string): PluginUpdateProblem {
  if (code === "SOURCE_SAME_VERSION_CONTENT_MISMATCH")
    return { kind: "policy", code: "content-mismatch" };
  return {
    kind: "source",
    code:
      code === "SOURCE_SIGNATURE_INVALID"
        ? "signature"
        : code === "SOURCE_HTTP_FAILED"
          ? "http"
          : "unavailable",
  };
}
/** Retain compatible version facts, excluding synthetic owner ids and file/transport details. */
export function planUpdateProblem(
  plan: Extract<PluginUpdatePlan, { kind: "blocked" }>,
  release: PluginRelease,
  core: FixedCore,
  installed: PluginManifest[],
): PluginUpdateProblem {
  if (plan.code === "DOWNGRADE_FORBIDDEN") return { kind: "policy", code: "channel-older" };
  if (plan.code === "SAME_VERSION_CONTENT_MISMATCH")
    return { kind: "policy", code: "content-mismatch" };
  if (plan.code === "CORE_UNSUPPORTED")
    return parseUpdateProblem({
      kind: "core",
      current: { version: core.version, revision: core.head },
      required: release.supportedCores.map((row) => ({
        version: row.version,
        revision: row.head,
      })),
    })!;
  if (plan.code === "COMBINATION_INCOMPATIBLE" && plan.failures?.length) {
    const requirements = plan.failures.flatMap((row) => {
      if (row.dependency === undefined || row.range === undefined) return [];
      return [
        {
          consumer: row.packageName.replace(/@[a-f0-9]{12}$/, ""),
          dependency: row.dependency,
          required: row.range,
          installed: row.installed,
          current:
            installed.find((manifest) => manifest.name === row.dependency)?.version ??
            core.sdk[row.dependency] ??
            null,
          candidate: row.dependency === release.name ? release.version : null,
        },
      ];
    });
    if (requirements.length) return parseUpdateProblem({ kind: "dependencies", requirements })!;
  }
  return { kind: "policy", code: "conditions" };
}
