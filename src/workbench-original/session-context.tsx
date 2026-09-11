/** DSH session identity supplied to the center document without importing AionUi chat. */
import React, { createContext, useContext } from 'react';

export interface WorkbenchSession {
  conversationId: string | null;
  startAnalysis?: () => void;
  preparingAnalysis?: boolean;
}

const WorkbenchSessionContext = createContext<WorkbenchSession>({ conversationId: null });

/** Pass the actual bound DSH session ID; the workbench never creates a conversation. */
export function WorkbenchSessionProvider({ value, children }: React.PropsWithChildren<{ value: WorkbenchSession }>) {
  return <WorkbenchSessionContext.Provider value={value}>{children}</WorkbenchSessionContext.Provider>;
}

/** Source-compatible hook used by the original workbench context publisher. */
export function useBusinessSurfaceSession(): WorkbenchSession {
  return useContext(WorkbenchSessionContext);
}
