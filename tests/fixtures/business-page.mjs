import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";

import { randomUUID } from "node:crypto";
import {
  WELCOME_NOTICE_SETTINGS_NAMESPACE,
  WELCOME_NOTICE_ACK_FIELD,
  WELCOME_NOTICE_VERSION,
} from "../../../../official-latest-standard/packages/client/ui-settings-models/src/onboarding-copy.ts";

/** Read only Core's public, redacted settings view; acknowledgement still happens through Continue. */
async function welcomeNoticeAcknowledged(page) {
  const response = await page.request.post(new URL("/api/settings/describe", page.url()).href, {
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

async function showBusinessMenu(page) {
  await preparePageStartup(page);
  if (await page.getByRole("navigation", { name: "业务导航", exact: true }).isVisible()) return;
  await page
    .getByRole("button", { name: /^(业务工作台|Business workbenches)$/ })
    .first()
    .click();
}

export async function openWorkbenchPage(page, label) {
  await showBusinessMenu(page);
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page
    .locator(".gea-directory-owned")
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
