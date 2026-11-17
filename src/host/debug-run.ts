export class DebugRunCoordinator {
  private current?: string;
  claim(id: string): () => void {
    if (this.current) throw Error("DEBUG_RUN_ACTIVE");
    this.current = id;
    return () => {
      if (this.current === id) this.current = undefined;
    };
  }
}
