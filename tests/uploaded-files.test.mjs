import assert from "node:assert/strict";
import test from "node:test";
import { readUploadedFileTool } from "../src/host/uploaded-files.ts";

test("the attachment tool reads only files uploaded by the user in the current session", async () => {
  const content = "名称,数量\n商品,12";
  const data = new TextEncoder().encode(content);
  const attachment = {
    name: "计划.csv",
    attachmentId: "sha256:" + "a".repeat(64),
    bytes: data.length,
  };
  const events = [
    {
      type: "user/message",
      data: { source: { kind: "user" }, content: [{ type: "file", attachment }] },
    },
    {
      type: "user/message",
      data: {
        source: { kind: "system" },
        content: [{ type: "file", attachment: { ...attachment, name: "外部.csv" } }],
      },
    },
  ];
  const signal = new AbortController().signal;
  const tool = readUploadedFileTool({
    get: () => ({
      async *readFileStream(file, readSignal) {
        assert.equal(file, attachment);
        assert.equal(readSignal, signal);
        yield data.subarray(0, 1);
        yield data.subarray(1);
      },
    }),
  });
  const exec = { signal, agent: { session: { snapshotEvents: () => events } } };
  assert.deepEqual(JSON.parse(await tool.execute({ name: attachment.name }, exec)), {
    name: attachment.name,
    text: content,
    nextOffset: null,
  });
  await assert.rejects(tool.execute({ name: "外部.csv" }, exec), /GEA_ATTACHMENT_NOT_FOUND/u);
});
