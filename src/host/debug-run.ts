/** API重发与权限运行共用的在途互斥，不保存业务或身份状态。 */
export class DebugRunCoordinator {
  private current?: { id: string; controller: AbortController };
  get active(): boolean {
    return this.current !== undefined;
  }
  claim(id: string, controller: AbortController): () => void {
    if (this.current) throw Error("DEBUG_RUN_ACTIVE");
    this.current = { id, controller };
    return () => {
      if (this.current?.id === id) this.current = undefined;
    };
  }
}
