/** 文档内加载工作流；已取消或被新请求取代的读取不会安装结果。 */
import { replaceSalesPlanWorkflowRows, type SalesPlanWorkflowRow } from './original/salesPlanWorkflow.ts';

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
