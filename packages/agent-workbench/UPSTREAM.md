# Layout source provenance

The initial layout adapter was extracted from `deepseek-ai/deepseek-harness`, `packages/client/ui-layout/src/client`, local commit `7ef3457e9d` on `codex/dsh-chat-surface`. The MIT license is retained in LICENSE.

AppFrame, column geometry, store, layout service, document title, and theme presenter preserve the existing shell behavior. This package owns subsequent changes and the new workbench registry. It uses the published DSH type declarations and runtime services; builds and launches do not read the source checkout. The native Conversation, composer, sidebar, and session implementation are supplied by unmodified DSH packages.
