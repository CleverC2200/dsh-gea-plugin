import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic, withFileLock } from "@deepseek-ai/dsh-atomic-write";
import z from "@deepseek-ai/schemastery";
import { memoryScopeSchema, type MemoryScope } from "../shared/memory-contract.ts";

const ledgerSchema = z
  .object({
    version: z.const(1).required(),
    bindings: z
      .array(
        z
          .object({ sessionId: z.string().min(1).max(256).required(), scope: memoryScopeSchema })
          .required(),
      )
      .max(100000)
      .required(),
  })
  .required();
export const sameMemoryScope = (left: MemoryScope, right: MemoryScope) =>
  left.environment === right.environment &&
  left.tenantId === right.tenantId &&
  left.userId === right.userId;

export function memorySessionError(
  code:
    | "MEMORY_SESSION_UNVERIFIED"
    | "MEMORY_SESSION_SCOPE_MISMATCH"
    | "MEMORY_SESSION_LEDGER_UNAVAILABLE",
) {
  const messages = {
    MEMORY_SESSION_UNVERIFIED: "此会话含有归属未确认的个人记忆，请新建对话。",
    MEMORY_SESSION_SCOPE_MISMATCH: "此会话使用了其他账号的个人记忆，请切回原账号或新建对话。",
    MEMORY_SESSION_LEDGER_UNAVAILABLE: "无法确认此会话的个人记忆归属，请稍后重试。",
  };
  return Object.assign(Error(`${code}: ${messages[code]}`), { code });
}

export class MemorySessionLedger {
  readonly filename: string;
  private readonly profileDir: string;
  constructor(profileDir: string) {
    this.profileDir = profileDir;
    this.filename = join(profileDir, "personal-memory-sessions.json");
  }
  private async read(): Promise<ReturnType<typeof ledgerSchema>> {
    try {
      return z.resolve(
        JSON.parse(await readFile(this.filename, "utf8")),
        ledgerSchema,
        {},
        true,
      )[0];
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return ledgerSchema({ version: 1, bindings: [] });
      throw memorySessionError("MEMORY_SESSION_LEDGER_UNAVAILABLE");
    }
  }
  async scope(sessionId: string, signal: AbortSignal): Promise<MemoryScope | undefined> {
    signal.throwIfAborted();
    const ledger = await this.read();
    signal.throwIfAborted();
    return ledger.bindings.find((entry) => entry.sessionId === sessionId)?.scope;
  }
  async assertBound(sessionId: string, scope: MemoryScope, signal: AbortSignal) {
    const current = await this.scope(sessionId, signal);
    if (!current || !sameMemoryScope(current, scope)) throw Error("MEMORY_SOURCE_UNAVAILABLE");
  }
  async bind(sessionId: string, scope: MemoryScope, signal: AbortSignal) {
    if (!sessionId || sessionId.length > 256) throw Error("MEMORY_INVALID_REQUEST");
    try {
      await mkdir(this.profileDir, { recursive: true, mode: 0o700 });
      await withFileLock(this.filename, async () => {
        signal.throwIfAborted();
        const ledger = await this.read();
        const current = ledger.bindings.find((entry) => entry.sessionId === sessionId);
        if (current) {
          if (!sameMemoryScope(current.scope, scope))
            throw memorySessionError("MEMORY_SESSION_SCOPE_MISMATCH");
          return;
        }
        ledger.bindings.push({ sessionId, scope });
        signal.throwIfAborted();
        await writeFileAtomic(this.filename, JSON.stringify(ledger), {
          mode: 0o600,
          dirMode: 0o700,
        });
        signal.throwIfAborted();
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof Error && error.message.startsWith("MEMORY_")) throw error;
      throw memorySessionError("MEMORY_SESSION_LEDGER_UNAVAILABLE");
    }
  }
}
