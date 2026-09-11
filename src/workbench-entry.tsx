/** Standalone same-origin business document; DSH remains the conversation owner. */
import React from "react";
import { createRoot } from "react-dom/client";
import { WorkbenchPage } from "./workbench-page.tsx";
import { zh, en, type CopyKey } from "./locales.ts";

const language =
  new URLSearchParams(window.location.search).get("locale") ??
  navigator.language;
const dictionary = language.startsWith("zh") ? zh : en;
document.documentElement.lang = language.startsWith("zh") ? "zh-CN" : "en";
const t = (key: CopyKey) => dictionary[key];
const root = document.getElementById("gea-workbench");
if (!root) throw new Error("GEA_WORKBENCH_ROOT_MISSING");
createRoot(root).render(<WorkbenchPage t={t} />);
