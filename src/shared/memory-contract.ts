import z from "@deepseek-ai/schemastery";

function strict<S, T>(schema: z<S, T>): z<S, T> {
  return z.transform(schema, (value) => z.resolve(value, schema, {}, true)[0]);
}
export const memoryScopeSchema = strict(
  z
    .object({
      environment: z.union(["production", "test"]).required(),
      tenantId: z.string().pattern(/^\d+$/).required(),
      userId: z.string().min(1).max(128).required(),
    })
    .required(),
);
export const memoryStateSchema = strict(
  z
    .object({
      scope: memoryScopeSchema,
      generationEnabled: z.boolean().required(),
      revision: z.natural().required(),
      bankGeneration: z.natural().required(),
      count: z.natural().required(),
      updatedAt: z.union([z.string(), z.const(null)]).default(null),
      pendingCleanup: strict(
        z.object({
          operationId: z
            .string()
            .pattern(/^[A-Za-z0-9_-]{8,128}$/)
            .required(),
          kind: z.union(["settings", "delete", "clear"]).required(),
        }),
      ),
    })
    .required(),
);
export const memoryItemSchema = strict(
  z
    .object({
      id: z
        .string()
        .pattern(/^[A-Za-z0-9_-]{1,128}$/)
        .required(),
      category: z.union(["background", "preference", "habit"]).required(),
      title: z.string().min(1).max(200).required(),
      content: z.string().min(1).max(6000).required(),
      version: z.natural().min(1).required(),
      manuallyEdited: z.boolean().required(),
      source: strict(
        z
          .object({
            sessionId: z.string().required(),
            messageId: z.string().required(),
            time: z.string().required(),
          })
          .required(),
      ),
      updatedAt: z.string().required(),
    })
    .required(),
);
export const memoryListSchema = strict(
  z
    .object({
      scope: memoryScopeSchema,
      state: memoryStateSchema,
      items: z.array(memoryItemSchema).max(500).required(),
    })
    .required(),
);
export const memoryGetSchema = strict(
  z.object({ scope: memoryScopeSchema, item: memoryItemSchema }).required(),
);
export const memoryOperationSchema = strict(
  z
    .object({
      scope: memoryScopeSchema,
      operationId: z
        .string()
        .pattern(/^[A-Za-z0-9_-]{8,128}$/)
        .required(),
      status: z.union(["completed", "processing", "failed", "unknown"]).required(),
      state: memoryStateSchema,
      errorCode: z.string(),
    })
    .required(),
);
export type MemoryScope = ReturnType<typeof memoryScopeSchema>;
export type MemoryState = ReturnType<typeof memoryStateSchema>;
export type MemoryItem = ReturnType<typeof memoryItemSchema>;
export type MemoryList = ReturnType<typeof memoryListSchema>;
export type MemoryOperation = ReturnType<typeof memoryOperationSchema>;
export type MemorySettingsInput = {
  generationEnabled: boolean;
  expectedRevision: number;
  operationId: string;
};
export type MemoryListInput = {
  query?: string;
  category?: MemoryItem["category"];
};

export const memoryRecallSchema = strict(
  z
    .object({
      scope: memoryScopeSchema,
      memories: z.array(memoryItemSchema).max(5).required(),
    })
    .required(),
);
export type MemoryGenerateInput = {
  operationId: string;
  expectedRevision: number;
  bankGeneration: number;
  source: MemoryItem["source"];
  text: string;
};
export const memoryUpdateInputSchema = strict(
  z
    .object({
      operationId: z
        .string()
        .pattern(/^[A-Za-z0-9_-]{8,128}$/)
        .required(),
      id: z
        .string()
        .pattern(/^[A-Za-z0-9_-]{1,128}$/)
        .required(),
      expectedVersion: z.natural().min(1).required(),
      expectedRevision: z.natural().required(),
      bankGeneration: z.natural().required(),
      category: z.union(["background", "preference", "habit"]).required(),
      content: z.string().min(1).max(6000).required(),
    })
    .required(),
);
export type MemoryUpdateInput = ReturnType<typeof memoryUpdateInputSchema>;

export const memoryDeleteInputSchema = strict(
  z
    .object({
      operationId: z
        .string()
        .pattern(/^[A-Za-z0-9_-]{8,128}$/)
        .required(),
      id: z
        .string()
        .pattern(/^[A-Za-z0-9_-]{1,128}$/)
        .required(),
      expectedVersion: z.natural().min(1).required(),
      expectedRevision: z.natural().required(),
      bankGeneration: z.natural().required(),
    })
    .required(),
);
export const memoryClearInputSchema = strict(
  z
    .object({
      operationId: z
        .string()
        .pattern(/^[A-Za-z0-9_-]{8,128}$/)
        .required(),
      expectedRevision: z.natural().required(),
      bankGeneration: z.natural().required(),
      confirmation: z.const("清空").required(),
    })
    .required(),
);
export type MemoryDeleteInput = ReturnType<typeof memoryDeleteInputSchema>;
export type MemoryClearInput = ReturnType<typeof memoryClearInputSchema>;
