import type { ContextFormed } from "@deepseek-ai/dsh-llm";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "gea-proof": { kind: "gea-proof" } & ContextFormed;
    "gea-turn-anchor": { kind: "gea-turn-anchor" } & ContextFormed;
  }
}
