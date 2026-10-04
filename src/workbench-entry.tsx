/** 独立的同源业务文档；会话仍由 DSH 拥有和管理。 */
import React from "react";
import { createRoot } from "react-dom/client";
import { WorkbenchPage } from "./workbench/page.tsx";
import { zh, en, type CopyKey } from "./client/locales.ts";

const language =
  new URLSearchParams(window.location.search).get("locale") ??
  navigator.language;
const dictionary = language.startsWith("zh") ? zh : en;
document.documentElement.lang = language.startsWith("zh") ? "zh-CN" : "en";
const t = (key: CopyKey) => dictionary[key];
const root = document.getElementById("gea-workbench");
if (!root) throw new Error("GEA_WORKBENCH_ROOT_MISSING");
createRoot(root).render(<WorkbenchPage t={t} />);

window.addEventListener("message", event => {
  if (event.source !== window.parent || event.origin !== window.location.origin || event.data?.protocol !== "agent-workbench-theme") return;
  document.body.toggleAttribute("data-ds-dark-theme", event.data.dark === true);
  if (Number.isFinite(event.data.fontSize)) document.documentElement.style.setProperty("--dsh-content-font-size", `${event.data.fontSize}px`);
});
