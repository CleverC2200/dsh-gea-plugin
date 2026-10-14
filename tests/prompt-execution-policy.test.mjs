import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PromptExecutionState } from "../src/host/prompt-execution-state.ts";
import { PromptEvidenceStore } from "../src/host/prompt-evidence.ts";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "gea-execution-policy-"));
  let identity = "one",
    revision = 1,
    queryResult = '{"value":{"rows":[{"amount":3}]}}';
  let resources = [{ id: "allowed" }];
  const queries = [];
  const agent = {
    id: "session",
    session: { deriveMessages: () => [], snapshotEvents: () => [], header: { cwd: "/" } },
  };
  const business = {
    status: () => ({ source: "test", user: { id: identity } }),
    readTurnRevision: () => revision,
    surfaceFor: () => undefined,
    agentQuery: async (args) => {
      queries.push(args);
      return queryResult;
    },
    moduleMcp: async () => ({ authorizedResources: async () => ({ resources }) }),
  };
  const owner = new PromptExecutionState(
    directory,
    () => "gea-readonly",
    () => true,
    {
      ctx: {},
      business,
    },
  );
  t.after(() => {
    owner.dispose();
    return rm(directory, { recursive: true, force: true });
  });
  const begin = (name = "gea_sales_plan_read", args = { year: 2026 }) => {
    const token = Symbol();
    const lease = owner.begin(agent, token, {
      name,
      arguments: args,
      signal: new AbortController().signal,
    });
    owner.admitted(lease, name);
    return owner.take(token);
  };
  const publish = (lease, text = queryResult) =>
    owner.finish(lease, { isError: false, content: [{ type: "text", text }] }, { kind: "accept" });
  return {
    owner,
    directory,
    agent,
    begin,
    publish,
    queries,
    setResult: (text) => {
      queryResult = text;
    },
    setResources: (value) => {
      resources = value;
    },
    nextTurn: () => {
      revision++;
      owner.startTurn(agent);
    },
    changeIdentity: () => {
      identity = "two";
      owner.clear();
    },
  };
}

test("the execution owner captures exact sales arguments and authorizes persisted readback", async (t) => {
  const f = await fixture(t);
  const args = { year: 2026, nested: { month: 10 } };
  const lease = f.begin("gea_sales_plan_read", args);
  args.nested.month = 11;
  await f.publish(lease);
  const [id] = f.owner.snapshot(f.agent).evidence;
  assert.ok(id);
  const read = await f.owner.read(f.begin("gea_evidence_read", { evidenceId: id }), {
    evidenceId: id,
    format: "raw",
  });
  assert.match(read.content, /amount/);
  assert.deepEqual(f.queries, [{ year: 2026, nested: { month: 10 } }]);
  f.setResult('{"value":{"rows":[{"amount":4}]}}');
  await assert.rejects(
    f.owner.read(f.begin("gea_evidence_read"), { evidenceId: id }),
    /GEA_EVIDENCE_STALE/,
  );
});

test("current native MCP stays direct and cannot acquire a reusable evidence grant", async (t) => {
  const f = await fixture(t);
  const decision = await f.publish(f.begin("mcp__gea-gateway__query_business_data"));
  assert.deepEqual(decision, { kind: "accept" });
  assert.deepEqual(f.owner.snapshot(f.agent).evidence, []);
});

test("late publication cannot attach receipts after turn or identity changes", async (t) => {
  const f = await fixture(t);
  const old = f.begin();
  f.nextTurn();
  assert.deepEqual(await f.publish(old), { kind: "accept" });
  assert.deepEqual(f.owner.snapshot(f.agent).evidence, []);
  const identityOld = f.begin();
  f.changeIdentity();
  assert.match(JSON.stringify(await f.publish(identityOld)), /GEA_EVIDENCE_IDENTITY_CHANGED/);
  assert.deepEqual(f.owner.snapshot(f.agent).evidence, []);
});

test("historic disk MCP grants retain exact resource revalidation without creating new MCP evidence", async (t) => {
  const f = await fixture(t);
  const store = new PromptEvidenceStore(f.directory);
  const grant = {
    owner: hash(["test", undefined, "one", undefined, undefined, undefined]),
    kind: "mcp",
    consumer: "cube",
    resourceTool: "query_business_data",
    resources: hash([JSON.stringify({ id: "allowed" })]),
  };
  const id = await store.put(f.agent.id, "gea_cube_query", '{"rows":[{"amount":3}]}', 0, grant);
  const read = await f.owner.read(f.begin("gea_evidence_read"), { evidenceId: id, format: "raw" });
  assert.match(read.content, /amount/);
  f.setResources([]);
  await assert.rejects(
    f.owner.read(f.begin("gea_evidence_read"), { evidenceId: id }),
    /GEA_EVIDENCE_AUTHORIZATION_CHANGED/,
  );
  const unsafe = await store.put(f.agent.id, "gea_module_mcp", "untrusted", 0, {
    owner: grant.owner,
    kind: "mcp",
  });
  await assert.rejects(
    f.owner.read(f.begin("gea_evidence_read"), { evidenceId: unsafe }),
    /GEA_EVIDENCE_AUTHORIZATION_REQUIRED/,
  );
});
