import { createHash } from "node:crypto";

const encoding = "order-report-parts-v1";
const table = "agents_order_workbench_report";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const invalid = () => Error("ORDER_REPORT_PARTS_INCOMPLETE");
type Execute = (
  sql: string,
  parameters: Record<string, any>,
  requestId?: string,
) => Promise<any>;
type Scope = {
  tenant: number;
  scope: string;
  consumer: string;
  kind: string;
  start: string;
  end: string;
};
type Manifest = {
  encoding: string;
  requestId: string;
  size: number;
  sha256: string;
  count: number;
};
function partIdentity(scope: Scope, requestId: string, index: number) {
  const identity = [
    scope.tenant,
    scope.scope,
    scope.consumer,
    scope.kind,
    scope.start,
    scope.end,
  ];
  const digest = createHash("sha256").update(
    JSON.stringify([identity, requestId, index]),
  );
  return {
    key: "order:part:" + digest.digest("base64url"),
    requestId: hash(JSON.stringify([identity, requestId, index, "write"])),
  };
}
export function isReportParts(value: any): value is Manifest {
  return value?.encoding === encoding;
}
export async function readReportParts(
  manifest: Manifest,
  scope: Scope,
  execute: Execute,
) {
  if (
    !/^[a-zA-Z0-9-]{16,64}$/.test(manifest.requestId) ||
    !Number.isSafeInteger(manifest.count) ||
    manifest.count < 1 ||
    manifest.count > 100 ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size < 1 ||
    manifest.size > 6_000_000 ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)
  )
    throw invalid();
  const identities = Array.from({ length: manifest.count }, (_, index) =>
    partIdentity(scope, manifest.requestId, index),
  );
  const parts = new Map<string, string>();
  for (let offset = 0; offset < identities.length; offset += 8) {
    const batch = identities.slice(offset, offset + 8);
    const result = await execute(
      `SELECT scope_key, report_data, version, last_request_id, schema_version FROM ${table} WHERE tenant_id=:tenant AND consumer_code=:consumer AND period_type=:kind AND period_start=CAST(:start AS DATE) AND period_end_exclusive=CAST(:end AS DATE) AND scope_key IN (:partScopes) LIMIT 8`,
      {
        tenant: scope.tenant,
        consumer: scope.consumer,
        kind: scope.kind,
        start: scope.start,
        end: scope.end,
        partScopes: batch.map((part) => part.key),
      },
    );
    if (
      !Array.isArray(result.rows) ||
      result.rows.length !== batch.length ||
      result.rejectedColumns?.length
    )
      throw invalid();
    for (const row of result.rows) {
      const expected = batch.find((part) => part.key === row.scope_key);
      if (
        !expected ||
        parts.has(row.scope_key) ||
        row.last_request_id !== expected.requestId ||
        Number(row.version) !== 1 ||
        Number(row.schema_version) !== 1 ||
        typeof row.report_data !== "string" ||
        row.report_data.length > 60_000
      )
        throw invalid();
      parts.set(row.scope_key, row.report_data);
    }
  }
  const encoded = identities.map((part) => parts.get(part.key)).join("");
  if (encoded.length !== manifest.size || hash(encoded) !== manifest.sha256)
    throw invalid();
  return encoded;
}

/** Immutable parts retain the parent's tenant, Consumer, period and business scope references. */
export async function writeReportParts(
  encoded: string,
  scope: Scope,
  metadata: { actor: string; scopeName: string; scopeRefs: string },
  requestId: string,
  execute: Execute,
) {
  const manifest: Manifest = {
    encoding,
    requestId,
    size: encoded.length,
    sha256: hash(encoded),
    count: Math.ceil(encoded.length / 60_000),
  };
  if (manifest.count > 100 || manifest.size > 6_000_000) throw invalid();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, manifest.count) }, async () => {
      while (next < manifest.count) {
        const index = next++,
          part = partIdentity(scope, requestId, index);
        const parameters = {
          tenant: scope.tenant,
          scope: part.key,
          consumer: scope.consumer,
          kind: scope.kind,
          start: scope.start,
          end: scope.end,
          scopeName: metadata.scopeName,
          scopeRefs: metadata.scopeRefs,
          actor: metadata.actor,
          request: part.requestId,
          report: encoded.slice(index * 60_000, (index + 1) * 60_000),
        };
        if (Buffer.byteLength(JSON.stringify(parameters)) > 65_536)
          throw invalid();
        await execute(
          `INSERT INTO ${table} (tenant_id,scope_key,period_type,period_start,period_end_exclusive,scope_name,scope_refs,consumer_code,report_data,schema_version,calculation_version,version,last_request_id,create_by,update_by) VALUES (:tenant,:scope,:kind,:start,:end,:scopeName,:scopeRefs,:consumer,:report,1,'order-report-part-v1',1,:request,:actor,:actor)`,
          parameters,
          part.requestId,
        );
      }
    }),
  );
  if ((await readReportParts(manifest, scope, execute)) !== encoded)
    throw invalid();
  return JSON.stringify(manifest);
}
