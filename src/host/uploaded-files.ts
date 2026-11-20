import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";

export const uploadedFiles = (agent?: Agent) =>
  agent?.session
    .snapshotEvents()
    .flatMap((event) =>
      event.type === "user/message" && event.data.source.kind === "user"
        ? event.data.content.flatMap((part) => (part.type === "file" ? [part.attachment] : []))
        : [],
    ) ?? [];

export function readUploadedFileTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: "read_uploaded_file",
    description:
      "读取用户上传到当前会话的 UTF-8 文本、CSV、Markdown 或 JSON。使用附件名和可选的 SHA-256 摘要，不传文件路径。按字符分页。",
    parameters: {
      name: { type: "string", required: true, description: "上传附件的完整文件名。" },
      digest: { type: "string", description: "同名附件的 SHA-256 摘要或摘要前缀。" },
      offset: { type: "integer", description: "从 0 开始的字符偏移，默认 0。" },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    isConcurrencySafe: () => true,
    async execute({ name, digest, offset = 0 }, exec) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw Error("GEA_ATTACHMENT_OFFSET_INVALID");
      if (digest !== undefined && !/^[a-f0-9]{8,64}$/u.test(digest))
        throw Error("GEA_ATTACHMENT_DIGEST_INVALID");
      const files = new Map(
        uploadedFiles(exec.agent).flatMap((file) =>
          file.name === name &&
          (digest === undefined || String(file.attachmentId).startsWith("sha256:" + digest))
            ? [[file.attachmentId, file] as const]
            : [],
        ),
      );
      if (files.size > 1)
        return JSON.stringify({
          error: "GEA_ATTACHMENT_NAME_AMBIGUOUS",
          digests: [...files.keys()].map((id) => String(id).slice("sha256:".length)),
        });
      const file = files.values().next().value;
      if (!file) throw Error("GEA_ATTACHMENT_NOT_FOUND");
      if (!/\.(txt|csv|tsv|md|json|log|xml|yaml|yml)$/iu.test(file.name))
        throw Error("此附件格式需要使用支持该格式的文件工具。");
      if (file.bytes > 2 * 1024 * 1024) throw Error("附件超过 2 MB，无法直接读取。");
      const attachments = ctx.get("attachments");
      if (!attachments) throw Error("GEA_ATTACHMENT_STORAGE_UNAVAILABLE");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let content = "";
      for await (const part of attachments.readFileStream(file, exec.signal))
        content += decoder.decode(part, { stream: true });
      content += decoder.decode();
      if (content.includes("\0")) throw Error("此附件不是可读取的 UTF-8 文本。");
      const text = content.slice(offset, offset + 6000);
      return JSON.stringify({
        name: file.name,
        text,
        nextOffset: offset + text.length < content.length ? offset + text.length : null,
      });
    },
  });
}
