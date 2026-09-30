import { getElementAtPoint, isElementGrabbable } from "react-grab/primitives";
import { PAGE_INTERACTION, type PageReference } from "./reference.ts";

export type PickerOptions = {
  describe?: (element: Element, reference: PageReference) => PageReference;
};
const clean = (value: string | null | undefined) =>
  (value ?? "").replace(/\s+/g, " ").trim();

export type SelectionKind = "row" | "table" | "block";
const BLOCKS =
  "[data-page-block],article,section,fieldset,figure,[role=region],.arco-card";

/** Promote tiny DOM hits to a business-sized selection. Never select the whole document. */
export function selectionTarget(
  element: Element | null,
  kind: SelectionKind = "row",
): Element | null {
  if (!element || element.closest("[data-react-grab-ignore]")) return null;
  if (kind === "table")
    return element.closest("table,[role=table],[role=grid]");
  if (kind === "row") {
    const row = element.closest("tbody tr,[role=row]");
    if (row) return row;
    if (element.closest("thead") || element.matches("table,tbody"))
      return element.closest("table");
  }
  const block = element.closest(BLOCKS);
  if (block) return block;
  for (
    let node: Element | null = element;
    node && !node.matches("body,html,main");
    node = node.parentElement
  ) {
    const box = node.getBoundingClientRect();
    const display = getComputedStyle(node).display;
    if (
      box.width >= 120 &&
      box.height >= 48 &&
      /^(block|flex|grid|inline-block)$/.test(display) &&
      clean(node.textContent)
    )
      return node;
  }
  return null;
}

const isRendered = (element: Element) =>
  element.getClientRects().length > 0 &&
  getComputedStyle(element).visibility !== "hidden";
function visibleText(element: Element): string {
  if (!isRendered(element) || element.closest("[data-gea-ignore]")) return "";
  if (element.matches("select"))
    return Array.from((element as HTMLSelectElement).selectedOptions)
      .map((option) => clean(option.textContent))
      .join(" ");
  if (element.matches("input,textarea")) {
    const input = element as HTMLInputElement;
    return ["checkbox", "radio", "hidden", "password"].includes(input.type)
      ? ""
      : input.value;
  }
  return clean(
    Array.from(element.childNodes)
      .map((node) =>
        node.nodeType === 3
          ? node.textContent
          : node.nodeType === 1
            ? visibleText(node as Element)
            : "",
      )
      .join(" "),
  );
}
const cellText = visibleText;
function rowText(row: Element) {
  const headers = row.closest("table")?.querySelectorAll("thead th");
  return Array.from(row.children)
    .map((cell, index) => {
      const value = cellText(cell);
      return value
        ? `${(headers?.[index] ? visibleText(headers[index]) : "") || `第 ${index + 1} 列`}：${value}`
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function describeElement(element: Element, page: string): PageReference {
  const pageState = element.closest("[data-page-reference-ready]");
  if (pageState && pageState.getAttribute("data-page-reference-ready") !== "true")
    throw Error("页面数据正在更新，请完成查询后重新选择。");
  const kind: SelectionKind = element.matches("tr,[role=row]")
    ? "row"
    : element.matches("table,[role=table],[role=grid]")
      ? "table"
      : "block";
  const rowCell = element.querySelector("td:not(:has(input[type=checkbox]))");
  const rowLabel = clean(
    element.getAttribute("data-page-label") || (rowCell ? visibleText(rowCell) : ""),
  );
  const targets = new Set<string>();
  const ownTarget = element.getAttribute("data-page-target");
  const targetElements = ownTarget
    ? [element]
    : [
        element,
        ...Array.from(
          element.querySelectorAll("[data-page-target],[data-gea-el]"),
        ),
      ];
  for (const target of targetElements) {
    if (!isRendered(target)) continue;
    for (const id of (
      target.getAttribute("data-page-target") ||
      target.getAttribute("data-gea-el") ||
      ""
    )
      .split("\n")
      .filter(Boolean))
      targets.add(id);
  }
  const rows =
    kind === "table"
      ? Array.from(element.querySelectorAll("tbody tr")).filter(
          (row) => row.closest("table") === element && isRendered(row),
        )
      : [];
  const body =
    kind === "row"
      ? rowText(element)
      : kind === "table"
        ? rows
            .map((row, index) => `第 ${index + 1} 行\n${rowText(row)}`)
            .join("\n\n") || visibleText(element)
        : cellText(element);
  const headingElement = element.querySelector("caption,h1,h2,h3,h4,[role=heading]");
  const heading = clean(
    element.getAttribute("aria-label") || (headingElement ? visibleText(headingElement) : ""),
  );
  const label =
    kind === "row"
      ? `${rowLabel || "当前"} · 整行`
      : kind === "table"
        ? `${heading || "表格"} · ${rows.length} 行`
        : heading || visibleText(element).slice(0, 32) || "内容块";
  return {
    page,
    kind,
    label,
    text: body.slice(0, 6000),
    row: kind === "row" ? rowLabel : "",
    targets: [...targets],
    capturedAt: new Date().toISOString(),
    ...(pageState?.getAttribute("data-page-reference-scope")
      ? { scope: pageState.getAttribute("data-page-reference-scope")! }
      : {}),
    truncated: body.length > 6000,
  };
}

/** Selection is hover-to-highlight, click-to-quote. No preview or confirmation panel. */
export function mountPicker(options: PickerOptions = {}): () => void {
  const ui = document.createElement("div");
  ui.className = "dspi";
  ui.setAttribute("data-react-grab-ignore", "");
  ui.setAttribute("data-gea-ignore", "");
  const style = document.createElement("style");
  style.textContent = `
.dspi{position:fixed;right:16px;bottom:64px;z-index:2147483646}.dspi[hidden],.dspi button[hidden]{display:none}
.dspi-pointer{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border:1px solid #dfe4eb;border-radius:7px;background:white;color:#606977;cursor:pointer}.dspi-pointer:hover,.dspi-pointer[aria-pressed=true]{color:#df1d28;background:#fff1f1}.dspi-pointer:focus-visible{outline:2px solid #d0132c;outline-offset:2px}
.dspi-status{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.dspi-outline{position:fixed;pointer-events:none;border:2px solid #d92d34;background:rgba(217,45,52,.06);z-index:2147483645;box-sizing:border-box}`;
  const outline = document.createElement("div");
  outline.className = "dspi-outline";
  outline.hidden = true;
  outline.setAttribute("data-react-grab-ignore", "");
  outline.setAttribute("data-gea-ignore", "");
  const status = document.createElement("div");
  status.className = "dspi-status";
  status.setAttribute("role", "status");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "dspi-pointer";
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "20");
  icon.setAttribute("height", "20");
  icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(icon.namespaceURI, "path");
  path.setAttribute("d", "M3.5 3.5 21 11.5l-7.5 2-2 7.5L3.5 3.5Z");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linejoin", "round");
  icon.append(path);
  toggle.append(icon);
  ui.append(toggle, status);
  ui.hidden = true;
  document.head.append(style);
  document.body.append(outline, ui);
  let pinned = false,
    altHeld = false,
    altSuppressed = false;
  let active = false,
    hover: Element | null = null,
    channel = "",
    page = document.title;
  let pending: { id: string } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSelection: { target: EventTarget | null; at: number } | undefined;
  const repeatClick = (event: Event) =>
    Boolean(
      lastSelection &&
        performance.now() - lastSelection.at < 800 &&
        event.target === lastSelection.target &&
        (event as MouseEvent).detail > 1,
    );
  const send = (message: object) =>
    window.parent.postMessage(
      { protocol: PAGE_INTERACTION, channel, ...message },
      "*",
    );
  const paint = (target: Element | null) => {
    outline.hidden = !target?.isConnected;
    if (!target?.isConnected) return;
    const box = target.getBoundingClientRect();
    Object.assign(outline.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
  };
  const clearPending = () => {
    clearTimeout(timer);
    pending = undefined;
  };
  const cancelPending = () => {
    if (pending) send({ type: "cancel-reference", requestId: pending.id });
    clearPending();
  };
  const mode = (next: boolean, cancel = true) => {
    active = next;
    toggle.setAttribute("aria-pressed", String(active));
    toggle.setAttribute("aria-label", active ? "退出选择" : "选择内容");
    toggle.title = active ? "退出选择（Esc）" : "选择内容";
    if (!active) {
      if (cancel) cancelPending();
      hover = null;
      paint(null);
    }
    if (channel) send({ type: "selection-state", active });
  };
  const syncMode = () => mode(pinned || (altHeld && !altSuppressed), false);
  const holdAlt = (held: boolean) => {
    if (!channel || (held === altHeld && (held || !altSuppressed))) return;
    altHeld = held;
    if (!held) altSuppressed = false;
    syncMode();
  };
  const stopSelection = (holdingAlt = altHeld) => {
    pinned = false;
    altHeld = holdingAlt;
    altSuppressed = holdingAlt;
    mode(false);
  };
  const toggleSelection = () => {
    if (active) stopSelection();
    else {
      pinned = true;
      mode(true, false);
    }
  };
  const pointerAlt = (event: MouseEvent) => {
    if (typeof event.altKey === "boolean")
      holdAlt(event.altKey && !event.ctrlKey && !event.metaKey);
  };
  toggle.addEventListener("click", toggleSelection);
  const own = (event: Event) => event.composedPath().includes(ui);
  const hit = (event: MouseEvent) =>
    selectionTarget(
      getElementAtPoint(event.clientX, event.clientY, {
        container: document.body,
        filter: (candidate) =>
          isElementGrabbable(candidate) && !ui.contains(candidate),
      }),
    );
  const move = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    pointerAlt(event);
    if (!active || pending || own(event)) return;
    hover = hit(event);
    paint(hover);
  };
  const suppress = (event: Event) => {
    if (!event.isTrusted && !repeatClick(event)) return;
    pointerAlt(event as MouseEvent);
    if ((active && !own(event)) || repeatClick(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const click = (event: MouseEvent) => {
    pointerAlt(event);
    if (repeatClick(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!event.isTrusted || !active || own(event)) return;
    suppress(event);
    if (event.button !== 0 || pending) return;
    const target = hit(event);
    if (!target) return;
    let original: PageReference;
    try { original = describeElement(target, page); }
    catch (error) {
      send({ type: "selection-error", error: error instanceof Error ? error.message : "页面引用暂不可用" });
      return;
    }
    const reference = options.describe?.(target, original) ?? original;
    if (!reference.text) return;
    lastSelection = { target: event.target, at: performance.now() };
    hover = target;
    paint(target);
    pending = { id: crypto.randomUUID() };
    status.textContent = "正在加入对话…";
    send({ type: "reference", requestId: pending.id, reference });
    timer = setTimeout(() => {
      cancelPending();
      status.textContent = "引用未加入，请重试。";
      send({ type: "selection-error", error: status.textContent });
    }, 5000);
  };
  const key = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === "Alt" && !event.ctrlKey && !event.metaKey && channel) {
      event.preventDefault();
      holdAlt(true);
    }
    if ((active || pending) && event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      stopSelection(event.altKey);
    }
  };
  const keyup = (event: KeyboardEvent) => {
    if (event.key === "Alt") {
      if (altHeld) event.preventDefault();
      holdAlt(false);
    }
  };
  const releaseAlt = () => {
    altHeld = false;
    syncMode();
  };
  const visibility = () => {
    if (document.hidden) releaseAlt();
  };
  const scroll = () => paint(hover);
  const message = (event: MessageEvent) => {
    if (
      event.source !== window.parent ||
      event.data?.protocol !== PAGE_INTERACTION
    )
      return;
    const data = event.data;
    if (data.type === "configure" && typeof data.channel === "string") {
      cancelPending();
      clearPending();
      channel = data.channel;
      page = typeof data.page === "string" ? data.page : document.title;
      toggle.hidden = data.externalTrigger === true;
      pinned = false;
      altHeld = false;
      altSuppressed = false;
      mode(false);
      ui.hidden = false;
      return;
    }
    if (data.channel !== channel) return;
    if (data.type === "toggle-selection") toggleSelection();
    if (data.type === "hold-selection") holdAlt(data.held === true);
    if (data.type === "suspend-selection") releaseAlt();
    if (data.type === "stop-selection")
      stopSelection(typeof data.altHeld === "boolean" ? data.altHeld : altHeld);
    if (data.type === "disconnect") {
      pinned = false;
      altHeld = false;
      altSuppressed = false;
      mode(false);
      clearPending();
      ui.hidden = true;
    }
    if (data.type === "result" && data.requestId === pending?.id) {
      clearPending();
      if (data.ok) {
        hover = null;
        paint(null);
        syncMode();
        status.textContent = "已加入输入框，写下问题即可。";
      } else {
        status.textContent = data.error || "引用未加入，请重试。";
        send({ type: "selection-error", error: status.textContent });
      }
    }
  };
  window.addEventListener("message", message);
  window.addEventListener("pointermove", move, true);
  const suppressed = [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "dblclick",
    "contextmenu",
  ];
  for (const type of suppressed) window.addEventListener(type, suppress, true);
  window.addEventListener("click", click, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("keyup", keyup, true);
  window.addEventListener("blur", releaseAlt);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("scroll", scroll, true);
  window.addEventListener("resize", scroll);
  send({ type: "ready" });
  return () => {
    cancelPending();
    clearPending();
    window.removeEventListener("message", message);
    window.removeEventListener("pointermove", move, true);
    for (const type of suppressed)
      window.removeEventListener(type, suppress, true);
    window.removeEventListener("click", click, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("keyup", keyup, true);
    window.removeEventListener("blur", releaseAlt);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("scroll", scroll, true);
    window.removeEventListener("resize", scroll);
    ui.remove();
    outline.remove();
    style.remove();
  };
}
