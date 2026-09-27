import { projectReferenceText } from "./reference.ts";

const MESSAGE_SURFACES =
  '[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"], [data-submission-echo], [data-pending-steering], [data-queue-dock]';

/** Text-only display projection, including native pending/queue bubbles.
 * Keeps text-node identities and native props intact: copy, retry, attachments and model input
 * continue to use the original wire text. The mutation is restored on plugin unload.
 */
export function mountReferenceDisplay(root: Document = document): () => void {
  const originals = new Map<
    Text,
    {
      source: string;
      display: string;
      ranges: Array<{ start: number; end: number }>;
    }
  >();
  const style = root.createElement("style");
  style.textContent =
    "::highlight(dsh-page-reference){color:#336eff;text-decoration:underline;text-underline-offset:3px}";
  root.head.append(style);
  const refresh = () => {
    for (const surface of root.querySelectorAll(MESSAGE_SURFACES)) {
      const walker = root.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const target = node as Text;
        if (
          target.parentElement?.closest(
            '[contenteditable="true"],textarea,button',
          )
        )
          continue;
        const current = target.data;
        if (originals.get(target)?.display === current) continue;
        const projected = projectReferenceText(current);
        if (!projected.labels.length) {
          originals.delete(target);
          continue;
        }
        originals.set(target, {
          source: current,
          display: projected.text,
          ranges: projected.ranges,
        });
        target.data = projected.text;
      }
    }
    const ranges: Range[] = [];
    for (const [node, value] of originals) {
      if (!node.isConnected) {
        originals.delete(node);
        continue;
      }
      for (const part of value.ranges) {
        const range = root.createRange();
        range.setStart(node, part.start);
        range.setEnd(node, part.end);
        ranges.push(range);
      }
    }
    if (typeof Highlight !== "undefined")
      CSS.highlights.set("dsh-page-reference", new Highlight(...ranges));
  };
  const observer = new MutationObserver(refresh);
  observer.observe(root.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  refresh();
  return () => {
    observer.disconnect();
    for (const [node, value] of originals)
      if (node.isConnected && node.data === value.display)
        node.data = value.source;
    originals.clear();
    style.remove();
    if (typeof Highlight !== "undefined")
      CSS.highlights.delete("dsh-page-reference");
  };
}

export function installReferenceDisplay(ctx: any): void {
  ctx.inject(["slots"], (scope: any) => {
    if (typeof document !== "undefined" && scope.slots)
      scope.effect(() => mountReferenceDisplay());
  });
}
