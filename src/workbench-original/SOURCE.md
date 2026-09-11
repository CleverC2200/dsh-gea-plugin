# Source and migration changes

Source repository: AionUi, commit `55d12cd60248c6084afd76bba816638a79af36de` on `main`. The source worktree had unrelated authentication-service edits; no source files copied here were modified. Source license: Apache License 2.0, copied verbatim to `LICENSE`.

| Destination | Original source under `packages/desktop/src/` | Adaptation |
| --- | --- | --- |
| `workbenches/regionalApproval/` | `renderer/pages/assistantSurface/workbenches/regionalApproval/` | Redirected AionUi imports to local bridge, explicit TS extensions, provenance notice; numeric reducer typed as number |
| `contracts.ts` | Sales-plan declarations in `common/adapter/ipcBridge.ts` | Extracted declarations only |
| `http-error.ts` | `BackendHttpError` and `isBackendHttpError` in `common/adapter/httpBridge.ts` | Extracted shared classifier only |
| `salesPlanWorkflow.ts` | `common/adapter/salesPlanWorkflow.ts` | Retained source workflow |
| `storage.ts` | `renderer/pages/assistantSurface/storage.ts` | Local registry type and `gea-dsh` storage prefix |
| `zh-CN.json`, `en-US.json` | `renderer/services/i18n/locales/<locale>/common.json` | Retained common primitive copy and assistantSurface subtree |
| `theme.css` | `renderer/styles/themes/default-color-scheme.css` | Light workbench theme variables and independent document reset |

`bridge.ts`, `session-context.tsx` and `index.ts` are the plugin-owned host adapter. They do not load Electron, AionCore, IPC, ChatConversation, or the AionUi shell. Each independent workbench document binds one explicit host before React mounts. The original CSS files are byte-identical; `source-manifest.json` records their hashes and all copied workbench source hashes before adaptation.

Focused regression source: `tests/unit/assistantSurface/salesPlanExportModel.test.ts` and `tests/unit/assistantSurface/salesPlanAccessModel.test.ts` from the same AionUi commit. The plugin test `tests/workbench-original.test.mjs` retains exact-decimal export, incomplete-source rejection, permission/identity checks, and SAVE receipt/readback behavior; it also verifies the new host binding lifecycle. No test performs a business write.
