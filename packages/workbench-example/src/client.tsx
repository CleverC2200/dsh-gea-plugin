/** Example consumer: two independent business instances, using native conversations. */
import React, { useEffect, useState } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@cleverc2200/dsh-agent-workbench/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
const id = "workbench-example" as MainPanelId;
const zh = {
  title: "示例 Agent",
  description: "用于验证独立页面与会话绑定，不连接业务系统。",
  first: "合同 A",
  second: "合同 B",
  remove: "卸载示例页面",
};
const en: typeof zh = {
  title: "Example Agent",
  description:
    "Validates independent pages and sessions without a business connection.",
  first: "Contract A",
  second: "Contract B",
  remove: "Unload example page",
};
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    workbenchExample: keyof typeof zh;
  }
}
export const inject = ["slots", "agentWorkbench", "locale"];
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register("workbenchExample", { zh, en }));
  const t = ctx.locale.bind("workbenchExample");
  let remove = () => {};
  function Page({ useSessions }: PropsRuntime<"main">) {
    const session = useSessions((s) => s.current);
    const [error, setError] = useState("");
    const open = (instance?: string) => {
      void ctx.agentWorkbench
        .open(id, instance)
        .catch((e) => setError(e.message));
    };
    useEffect(() => {
      const hide = ctx.agentWorkbench.showConversation(id);
      open();
      return hide;
    }, []);
    return (
      <section
        data-workbench-example
        style={{
          padding: 24,
          overflow: "auto",
          color: "var(--dsw-alias-text-primary)",
        }}
      >
        <h1>{t("title")}</h1>
        <p>{t("description")}</p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button type="button" onClick={() => open("contract-a")}>
            {t("first")}
          </button>
          <button type="button" onClick={() => open("contract-b")}>
            {t("second")}
          </button>
          <button type="button" onClick={() => remove()}>
            {t("remove")}
          </button>
        </div>
        <output hidden data-example-session>
          {session}
        </output>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  }
  ctx.slots.inject("main", () => {
    const unmount = ctx.slots.register(
      { name: "main", key: id, locale: "workbenchExample" },
      Page,
    );
    const unregister = ctx.agentWorkbench.register({ id, preset: "standard" });
    const unnav = ctx.slots.inject("sidebar.panellist", () =>
      ctx.slots.register(
        { name: "sidebar.panellist", id, label: () => t("title") },
        () => (
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
          >
            <path d="M6 3h9l3 3v15H6zM9 10h6M9 14h6" />
          </svg>
        ),
      ),
    );
    remove = () => {
      unnav();
      unmount();
      unregister();
    };
    return () => remove();
  });
}
