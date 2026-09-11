/** Original GEA workbench presentation with an explicit DSH host adapter. */
export { default as RegionalApprovalWorkbench } from './workbenches/regionalApproval/RegionalApprovalWorkbench.tsx';
export type { RegionalApprovalWorkbenchContext } from './workbenches/regionalApproval/RegionalApprovalWorkbench.tsx';
export { bindWorkbenchHost } from './bridge.ts';
export type { WorkbenchHost } from './bridge.ts';
export { BackendHttpError } from './http-error.ts';
export { WorkbenchSessionProvider } from './session-context.tsx';
export type { WorkbenchSession } from './session-context.tsx';
export type * from './contracts.ts';
