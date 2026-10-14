import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { profile } from "../profile.mjs";

// Independent author metadata shared with the complete catalog scene; only this fixture's canary differs.
const declaration = JSON.parse(
  await readFile(new URL("./catalog-scene-expectations.json", import.meta.url), "utf8"),
);
const expectedEntries = [
  ...declaration.completeSkillEntries.model.filter(
    (entry) => entry.name !== declaration.canary.name,
  ),
  {
    name: "receipt-catalog-canary",
    description:
      "Receipt catalog metadata fixture; its body requires an explicit skill invocation.",
  },
].sort((a, b) => a.name.localeCompare(b.name));
const bodyCanary = "RECEIPT_SKILL_BODY_MUST_NOT_AUTOLOAD_R39_6d341cbf";

/** Retain the business profile and give every filesystem Skill source a private root. */
export async function receiptProfile(t) {
  const { core } = JSON.parse(await readFile(process.env.GEA_TEST_CANDIDATE, "utf8"));
  assert.ok([rc2, alpha].includes(core), "Unsupported receipt Core input");
  const env = { GEA_WEB_LOGIN_PERSIST: "0" };
  const app = await profile(t, {
    env,
    async beforeStart({ runtime }) {
      env.HOME = join(runtime, "fixture-user-home");
      env.DSH_AGENTS_HOME = join(runtime, "fixture-agents-home");
      env.DSH_BUNDLED_SKILL_DIR = join(runtime, "fixture-bundled-skills");
      const skill = join(runtime, "home/skills/receipt-catalog-canary");
      await Promise.all(
        [env.HOME, env.DSH_AGENTS_HOME, env.DSH_BUNDLED_SKILL_DIR, skill].map((path) =>
          mkdir(path, { recursive: true }),
        ),
      );
      await writeFile(
        join(skill, "SKILL.md"),
        "---\nname: receipt-catalog-canary\ndescription: Receipt catalog metadata fixture; its body requires an explicit skill invocation.\n---\n" +
          bodyCanary +
          "\n",
        { flag: "wx" },
      );
    },
  });
  return Object.assign(app, { receiptCore: core });
}

/** A directory is durable metadata; it must not load Skill instructions or dispatch them. */
export function assertReceiptCatalog(rows) {
  const messages = rows.filter((row) => row.type === "user/message");
  const catalogs = messages.filter((row) => row.data.source.kind === "skill-catalog");
  assert.equal(catalogs.length, 1);
  assert.deepEqual(catalogs[0].data.source, {
    kind: "skill-catalog",
    form: "catalog",
    entries: expectedEntries,
  });
  assert.equal(
    messages.some((row) => row.data.source.kind === "skill-invocation"),
    false,
  );
  assert.equal(JSON.stringify(rows).includes(bodyCanary), false);
  const calls = rows
    .filter((row) => row.type === "assistant/message")
    .flatMap((row) => row.data.message.content)
    .filter((block) => block.type === "tool-call");
  assert.equal(
    calls.some((call) => ["skill", "skill_reference_read"].includes(call.name)),
    false,
  );
}

const rc2 = "639ed015397290b3745d163aafe02ffee4aa3f84";
const alpha = "5badb15009ae1756c3afe0ae0cef1faafc290ccc";

function assertSnapshot(source, names) {
  assert.deepEqual(Object.keys(source).sort(), ["form", "kind", "sections"]);
  assert.equal(source.form, "snapshot");
  assert.deepEqual(
    source.sections.map((section) => section.name),
    names,
  );
  for (const section of source.sections) {
    assert.deepEqual(Object.keys(section).sort(), ["name", "text"]);
    assert.equal(typeof section.text, "string");
    assert.ok(section.text.length > 0);
  }
}

/** Validate the Core-declared metadata and retain exactly one receipt proof. */
export function assertReceiptMessages(rows, core) {
  assert.ok([rc2, alpha].includes(core), "Unsupported receipt Core input");
  assertReceiptCatalog(rows);
  const messages = rows.filter((row) => row.type === "user/message");
  const proofs = [];
  const contexts = [];
  const times = [];
  for (const row of messages) {
    const source = row.data.source;
    switch (source.kind) {
      case "skill-catalog":
        break;
      case "runtime-context":
        assertSnapshot(source, ["sandbox:policy", "approval:policy"]);
        contexts.push(row);
        break;
      case "time-context":
        assert.equal(core, alpha, "time-context is declared only by alpha standard");
        assertSnapshot(source, ["time-context"]);
        times.push(row);
        break;
      case "gea-proof":
        assert.deepEqual(source, {
          kind: "gea-proof",
          form: "notice",
          summary: "已提交只读快照，正在验证数据传递",
        });
        proofs.push(row);
        break;
      default:
        assert.fail("Unsupported receipt user-message source: " + source.kind);
    }
  }
  assert.equal(contexts.length, 1, "Receipt must retain one runtime-context snapshot");
  assert.equal(
    times.length,
    core === alpha ? 1 : 0,
    "Receipt time metadata must match its Core declaration",
  );
  assert.equal(proofs.length, 1, "Receipt must retain exactly one business proof");
  return proofs;
}
