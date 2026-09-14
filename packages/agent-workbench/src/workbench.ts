/** Page registration and instance-to-session navigation, independent of React. */
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

/** One page's session preset; page components remain ordinary DSH main entries. */
export interface WorkbenchPage {
  readonly id: MainPanelId;
  readonly preset: string;
}
/** Dependencies supplied by the DSH layout adapter. */
export interface WorkbenchPorts {
  storage?: Pick<Storage, "getItem" | "setItem">;
  create(preset: string): Promise<SessionId>;
  prepare(id: SessionId): Promise<void>;
  available(id: SessionId): boolean;
  select(id: SessionId | undefined): void;
  panel(id: MainPanelId | null): void;
  beginNavigation(): AbortSignal;
  showConversation(id: MainPanelId): () => void;
}
/** Public workbench operations. Opening never changes an existing Session's preset. */
export interface AgentWorkbench {
  register(page: WorkbenchPage): () => void;
  open(
    id: MainPanelId,
    instance?: string,
    sessionId?: SessionId,
  ): Promise<void>;
  showConversation(id: MainPanelId): () => void;
  forget(id: MainPanelId): void;
}

/** Owns one selected instance per page and coalesces creation per instance. */
export class WorkbenchController implements AgentWorkbench {
  private readonly pages = new Map<MainPanelId, WorkbenchPage>();
  private readonly sessions = new Map<MainPanelId, Map<string, SessionId>>();
  private readonly instances = new Map<MainPanelId, string>();
  private readonly pending = new Map<
    WorkbenchPage,
    Map<string, Promise<SessionId>>
  >();
  private disposed = false;
  constructor(private readonly ports: WorkbenchPorts) {
    try {
      const raw = ports.storage?.getItem("agent-workbench:v1");
      if (!raw) return;
      const stored: unknown = JSON.parse(raw);
      if (!Array.isArray(stored)) return;
      for (const row of stored) {
        if (
          !Array.isArray(row) ||
          row.length !== 3 ||
          typeof row[0] !== "string" ||
          typeof row[1] !== "string" ||
          !Array.isArray(row[2])
        )
          continue;
        const bindings = new Map<string, SessionId>();
        for (const pair of row[2]) {
          if (
            Array.isArray(pair) &&
            pair.length === 2 &&
            typeof pair[0] === "string" &&
            typeof pair[1] === "string" &&
            /^session-[0-9a-f-]{36}$/.test(pair[1])
          )
            bindings.set(pair[0], pair[1] as SessionId);
        }
        this.sessions.set(row[0] as MainPanelId, bindings);
        this.instances.set(row[0] as MainPanelId, row[1]);
      }
    } catch {
      /* Malformed browser storage is discarded; durable Sessions are untouched. */
    }
  }

  private save(): void {
    try {
      this.ports.storage?.setItem(
        "agent-workbench:v1",
        JSON.stringify(
          [...this.sessions].map(([id, bindings]) => [
            id,
            this.instances.get(id) ?? "default",
            [...bindings],
          ]),
        ),
      );
    } catch {
      /* Storage quota/privacy settings leave associations memory-only. */
    }
  }

  /** Register after the page's main slot; the disposer forgets its associations. */
  register(page: WorkbenchPage): () => void {
    if (this.disposed) throw new Error("Workbench disposed");
    if (this.pages.has(page.id))
      throw new Error(`Duplicate workbench page: ${page.id}`);
    const owned = { ...page };
    this.pages.set(page.id, owned);
    return () => {
      if (this.pages.get(page.id) !== owned) return;
      this.pending.delete(owned);
      this.pages.delete(page.id);
      this.forget(page.id);
    };
  }

  /** Called by the layout on every panel selection, including native navigation. */
  selectPanel(id: MainPanelId | null): void {
    if (id === null || !this.pages.has(id)) return;
    const session = this.sessions
      .get(id)
      ?.get(this.instances.get(id) ?? "default");
    this.ports.select(
      session !== undefined && this.ports.available(session)
        ? session
        : undefined,
    );
  }

  /** Create/reuse an instance Session, or explicitly associate a host-created Session. */
  async open(
    id: MainPanelId,
    instance?: string,
    sessionId?: SessionId,
  ): Promise<void> {
    const page = this.pages.get(id);
    if (!page || this.disposed)
      throw new Error(`Unknown workbench page: ${id}`);
    instance ??= this.instances.get(id) ?? "default";
    const navigation = this.ports.beginNavigation();
    const alive = () => !this.disposed && this.pages.get(id) === page;
    let bindings = this.sessions.get(id);
    if (!bindings) this.sessions.set(id, (bindings = new Map()));
    const ownedBindings = bindings;
    if (sessionId !== undefined) this.pending.get(page)?.delete(instance);
    let selected = sessionId ?? bindings.get(instance);
    if (!selected) {
      let flights = this.pending.get(page);
      if (!flights) this.pending.set(page, (flights = new Map()));
      let flight = flights.get(instance);
      if (!flight) {
        flight = this.ports
          .create(page.preset)
          .then((created) => {
            if (
              alive() &&
              this.sessions.get(id) === ownedBindings &&
              flights.get(instance) === flight
            )
              ownedBindings.set(instance, created);
            return created;
          })
          .finally(() => {
            if (flights.get(instance) === flight) flights.delete(instance);
          });
        flights.set(instance, flight);
      }
      selected = await flight;
    }
    if (
      !alive() ||
      this.sessions.get(id) !== ownedBindings ||
      navigation.aborted
    )
      return;
    await this.ports.prepare(selected);
    if (
      !alive() ||
      this.sessions.get(id) !== ownedBindings ||
      navigation.aborted
    )
      return;
    bindings.set(instance, selected);
    this.instances.set(id, instance);
    this.save();
    this.ports.panel(id);
  }

  /** Opt a mounted page into the native conversation column. */
  showConversation(id: MainPanelId): () => void {
    if (!this.pages.has(id)) throw new Error(`Unknown workbench page: ${id}`);
    return this.ports.showConversation(id);
  }

  /** Drop local associations, without deleting or stopping durable Sessions. */
  forget(id: MainPanelId): void {
    this.sessions.delete(id);
    this.instances.delete(id);
    const page = this.pages.get(id);
    if (page) this.pending.delete(page);
    this.save();
  }

  /** Invalidate pending navigation without cancelling host-owned Agent work. */
  dispose(): void {
    this.disposed = true;
    this.pages.clear();
    this.sessions.clear();
    this.instances.clear();
    this.pending.clear();
  }
}
