import { mkdir, readFile, writeFile } from "node:fs/promises";
import YAML from "yaml";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { waitForNativeOwner } from "./native-page.mjs";

import { randomUUID } from "node:crypto";
import {
  WELCOME_NOTICE_SETTINGS_NAMESPACE,
  WELCOME_NOTICE_ACK_FIELD,
  WELCOME_NOTICE_VERSION,
} from "../../../../official-latest-standard/packages/client/ui-settings-models/src/onboarding-copy.ts";

/** Read only Core's public, redacted settings view; acknowledgement still happens through Continue. */
async function welcomeNoticeAcknowledged(page) {
  const response = await page.request.post(new URL("/api/settings/describe", page.url()).href, {
    maxRetries: 2,
    headers: { Origin: new URL(page.url()).origin },
    data: {
      type: "client-request",
      rpcId: randomUUID(),
      method: "settings/describe",
      payload: { args: {} },
    },
  });
  if (!response.ok()) throw Error("WELCOME_SETTINGS_READ_FAILED: " + response.status());
  const reply = await response.json();
  if (!reply.result?.ok) throw Error("WELCOME_SETTINGS_READ_FAILED");
  const welcome = reply.result.value.namespaces.find(
    (entry) => entry.ns === WELCOME_NOTICE_SETTINGS_NAMESPACE,
  );
  if (!welcome) throw Error("WELCOME_SETTINGS_NAMESPACE_UNAVAILABLE");
  return welcome.value?.[WELCOME_NOTICE_ACK_FIELD] === WELCOME_NOTICE_VERSION;
}

/** Wait for Core's asynchronous first-run decision; already acknowledged restarts need no dialog. */
export async function preparePageStartup(page) {
  const notice = page.getByRole("dialog", { name: /内测声明|预览版说明/ });
  const proceed = notice.getByRole("button", { name: "继续", exact: true });
  let action;
  await expect
    .poll(
      async () => {
        action = (await welcomeNoticeAcknowledged(page))
          ? "acknowledged"
          : (await proceed.evaluateAll((buttons) =>
                buttons.some((button) => {
                  const style = getComputedStyle(button);
                  return (
                    !button.disabled &&
                    button.getClientRects().length > 0 &&
                    style.visibility !== "hidden" &&
                    style.visibility !== "collapse"
                  );
                }),
              ))
            ? "continue"
            : "pending";
        return action;
      },
      {
        message:
          "Core welcome notice must resolve to its current acknowledgement or a usable Continue button",
      },
    )
    .not.toBe("pending");
  if (action === "continue") {
    await proceed.click();
    await expect.poll(() => welcomeNoticeAcknowledged(page)).toBe(true);
  }
  await notice.waitFor({ state: "hidden" });
}

/** Follow the same public company menu as a user; the Document owns its real frame. */
export async function openBusinessPage(page, id) {
  await showBusinessMenu(page);
  await page.locator(`[data-gea-business-entry="${id}"]`).click();
}

export function salesPlanFrameElement(page) {
  return page.locator('iframe[src^="/api/agent-workbench/native?"]');
}

export function salesPlanFrame(page) {
  return salesPlanFrameElement(page).contentFrame();
}

export async function openSalesPlan(page) {
  await openBusinessPage(page, "gea-proof");
  await expect(salesPlanFrameElement(page)).toBeVisible();
  return salesPlanFrame(page);
}

/** Authenticated business reads wait for the Session association and its current page owner. */
export async function openReadySalesPlan(page) {
  await showBusinessMenu(page);
  const ownerReady = waitForNativeOwner(page, "gea-proof", "gea-readonly");
  await Promise.all([page.locator('[data-gea-business-entry="gea-proof"]').click(), ownerReady]);
  await expect(salesPlanFrameElement(page)).toBeVisible();
  return salesPlanFrame(page);
}

async function showBusinessMenu(page) {
  await preparePageStartup(page);
  if (await page.getByRole("navigation", { name: "业务导航", exact: true }).isVisible()) return;
  await page
    .getByRole("button", { name: /^(业务工作台|Business workbenches)$/ })
    .first()
    .click();
}

export async function openWorkbenchPage(page, label) {
  if (label === "原生对话") {
    await preparePageStartup(page);
    await page
      .getByRole("button", { name: /^(新会话|New conversation)$/ })
      .first()
      .click();
    return;
  }
  await showBusinessMenu(page);
  await page
    .getByRole("navigation", { name: "业务导航", exact: true })
    .getByRole("button", { name: label, exact: true })
    .click();
}

/** The public Workbench loader configuration belongs to this isolated profile only. */
export function prepareWorkbenchHtmlRoots(roots) {
  return async ({ runtime }) => {
    const directory = resolve(runtime, "home/profiles/plugin-split-validation");
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, "cordis.patch.yml"),
      JSON.stringify([
        { id: "agent-workbench", config: { cwd: resolve(runtime, "workspace"), htmlRoots: roots } },
      ]),
    );
  };
}
export function htmlFrameElement(page, id) {
  return page.locator(`iframe[src^="/api/agent-workbench/html?id=${id}&"]`);
}

export function prepareWorkbenchPageAccess(pages, beforeStart) {
  return async (input) => {
    await beforeStart?.(input);
    const directory = resolve(input.runtime, "fixtures/workbench-page-access");
    await mkdir(directory, { recursive: true });
    const files = {
      "package.json": JSON.stringify({
        name: "@fixture/workbench-page-access",
        version: "0.0.1",
        private: true,
        type: "module",
        main: "index.js",
        exports: { ".": "./index.js", "./client": "./client.js" },
        dsh: { client: { platform: "web" } },
      }),
      "index.js": "export function apply() {}\n",
      "client.js": `window.__ModuleLoader__.load({
        id: '@fixture/workbench-page-access',
        factory(require) {
          const React = require('react');
          return {
            inject: ['slots', 'agentWorkbench'],
            apply(ctx) {
              ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'fixture-workbench-page-access' },
                () => React.createElement('details', { style: { position: 'fixed', top: 0, right: 0, zIndex: 99999 } },
                  React.createElement('summary', null, '测试页面入口'),
                  ...${JSON.stringify(pages)}.map(([id, label]) => React.createElement('button', {
                    key: id, type: 'button', onClick: () => void ctx.agentWorkbench.open(id),
                  }, '打开测试页面：' + label)))));
            },
          };
        },
      });`,
    };
    for (const [name, bytes] of Object.entries(files))
      await writeFile(resolve(directory, name), bytes);
    const profile = resolve(input.runtime, "home/profiles/plugin-split-validation");
    await mkdir(profile, { recursive: true });
    const patch = resolve(profile, "cordis.patch.yml");
    let entries = [];
    try {
      entries = YAML.parse(await readFile(patch, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    entries.push({
      insert: [{ id: "fixture-workbench-page-access", name: resolve(directory, "index.js") }],
    });
    await writeFile(patch, JSON.stringify(entries));
  };
}

export async function openRegisteredWorkbenchPage(page, label) {
  await preparePageStartup(page);
  const launcher = page
    .locator("details")
    .filter({ has: page.getByText("测试页面入口", { exact: true }) });
  await launcher.locator("summary").click();
  await launcher.getByRole("button", { name: "打开测试页面：" + label, exact: true }).click();
  await launcher.locator("summary").click();
}
