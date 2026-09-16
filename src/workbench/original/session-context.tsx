/** 向中心文档提供 DSH Session 身份，但不导入 AionUi 聊天能力。 */
import React, { createContext, useContext } from 'react';

export interface WorkbenchSession {
  conversationId: string | null;
  startAnalysis?: () => void;
  preparingAnalysis?: boolean;
}

const WorkbenchSessionContext = createContext<WorkbenchSession>({ conversationId: null });

/** 传递真实绑定的 DSH Session ID；工作台不会创建会话。 */
export function WorkbenchSessionProvider({ value, children }: React.PropsWithChildren<{ value: WorkbenchSession }>) {
  return <WorkbenchSessionContext.Provider value={value}>{children}</WorkbenchSessionContext.Provider>;
}

/** 供原工作台上下文发布器兼容使用的 Hook。 */
export function useBusinessSurfaceSession(): WorkbenchSession {
  return useContext(WorkbenchSessionContext);
}
