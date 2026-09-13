/** Document-local workflow loading; cancelled or superseded reads never install rows. */
import { replaceSalesPlanWorkflowRows, type SalesPlanWorkflowRow } from './workbench-original/salesPlanWorkflow.ts';

export function createWorkflowLoader(read: (signal?: AbortSignal) => Promise<SalesPlanWorkflowRow[]>) {
  let generation = 0;
  replaceSalesPlanWorkflowRows([]);
  return async (signal?: AbortSignal) => {
    const current = ++generation;
    replaceSalesPlanWorkflowRows([]);
    const rows = await read(signal);
    signal?.throwIfAborted();
    if (current !== generation) throw new Error('STALE_SELECTION');
    replaceSalesPlanWorkflowRows(rows);
  };
}
