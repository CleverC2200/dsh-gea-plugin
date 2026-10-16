import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { readSession } from "./profile.mjs";
import { assertReceiptMessages } from "./fixtures/receipt-skill-catalog.mjs";

// Independent resource declarations, never captured from a Session or model request.
const entries = JSON.parse(
  await readFile(new URL("./fixtures/receipt-catalog-declaration.json", import.meta.url), "utf8"),
);
const rc2 = "639ed015397290b3745d163aafe02ffee4aa3f84";
const alpha = "5badb15009ae1756c3afe0ae0cef1faafc290ccc";
const proof = {
  type: "user/message",
  data: {
    source: {
      kind: "gea-proof",
      form: "notice",
      summary: "已提交只读快照，正在验证数据传递",
    },
    content: [{ type: "text", text: "Receipt fixture proof" }],
  },
};
const context = {
  type: "user/message",
  data: {
    source: {
      kind: "runtime-context",
      form: "snapshot",
      sections: [
        { name: "sandbox:policy", text: "Fixture sandbox policy" },
        { name: "approval:policy", text: "Fixture approval policy" },
      ],
    },
  },
};
const rows = [
  proof,
  {
    type: "user/message",
    data: { source: { kind: "skill-catalog", form: "catalog", entries } },
  },
  { type: "turn/end" },
];

async function storedRows(t, messages) {
  const runtime = await mkdtemp(join(tmpdir(), "receipt-contract-"));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const directory = join(runtime, "home/sessions/fixture/session-receipt-contract");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "session.v4.jsonl.zstd"),
    zstdCompressSync(Buffer.from(messages.map((row) => JSON.stringify(row)).join("\n") + "\n")),
  );
  return readSession(runtime, "session-receipt-contract");
}

test("company catalog metadata retains exactly one receipt proof without runtime snapshots", async (t) => {
  const messages = assertReceiptMessages(await storedRows(t, rows), rc2);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data.source.kind, "gea-proof");
});

test("unknown user-message sources cannot be classified as receipt metadata", async (t) => {
  const unknown = {
    type: "user/message",
    data: { source: { kind: "unknown-context", form: "snapshot" } },
  };
  const unknownRows = await storedRows(t, [...rows, unknown]);
  assert.throws(
    () => assertReceiptMessages(unknownRows, rc2),
    /Unsupported receipt user-message source/,
  );
});

test("duplicate receipt proofs are rejected even when all metadata is known", async (t) => {
  const duplicated = await storedRows(t, [...rows, proof]);
  assert.throws(() => assertReceiptMessages(duplicated, rc2), /exactly one business proof/);
});

test("alpha standard time metadata retains one proof and is not admitted by rc2", async (t) => {
  const time = {
    type: "user/message",
    data: {
      source: {
        kind: "time-context",
        form: "snapshot",
        sections: [{ name: "time-context", text: "Fixture request time" }],
      },
    },
  };
  const alphaRows = await storedRows(t, [...rows, time]);
  assert.equal(assertReceiptMessages(alphaRows, alpha).length, 1);
  assert.throws(() => assertReceiptMessages(alphaRows, rc2));
});

test("known snapshot kinds reject undeclared forms, sections and fields", async (t) => {
  for (const source of [
    { ...context.data.source, form: "notice" },
    { ...context.data.source, sections: [{ name: "unknown-policy", text: "Fixture policy" }] },
    {
      ...context.data.source,
      sections: [{ name: "sandbox:policy", text: "" }, context.data.source.sections[1]],
    },
    { ...context.data.source, extra: true },
    {
      ...context.data.source,
      sections: [...context.data.source.sections, { name: "approval:policy", text: "Duplicate" }],
    },
  ]) {
    const malformed = await storedRows(t, [proof, { ...context, data: { source } }, rows[1]]);
    assert.throws(() => assertReceiptMessages(malformed, rc2));
  }
});

test("a receipt cannot substitute metadata for its missing proof or duplicate stable metadata", async (t) => {
  for (const invalid of [rows.slice(1), [...rows, rows[1]], [...rows, context]]) {
    const invalidRows = await storedRows(t, invalid);
    assert.throws(() => assertReceiptMessages(invalidRows, rc2));
  }
});

test("catalog metadata retains exact declared entries and never loads or dispatches Skill bodies", async (t) => {
  const changedCatalog = structuredClone(rows);
  changedCatalog[1].data.source.entries.pop();
  const body = structuredClone(rows);
  body[0].data.content[0].text = "RECEIPT_SKILL_BODY_MUST_NOT_AUTOLOAD_R39_6d341cbf";
  const dispatch = {
    type: "assistant/message",
    data: { message: { content: [{ type: "tool-call", name: "skill_reference_read" }] } },
  };
  for (const invalid of [changedCatalog, body, [...rows, dispatch]]) {
    const invalidRows = await storedRows(t, invalid);
    assert.throws(() => assertReceiptMessages(invalidRows, rc2));
  }
});

test("receipt classification requires an explicitly supported Core input", async (t) => {
  const knownRows = await storedRows(t, rows);
  for (const core of [undefined, "unknown-core"]) {
    assert.throws(() => assertReceiptMessages(knownRows, core), /Unsupported receipt Core input/);
  }
});
