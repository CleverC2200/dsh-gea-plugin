import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const moduleUrl = (source) => "data:text/javascript," + encodeURIComponent(source);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/fixtures/business-page.mjs")) {
      if (specifier === "@playwright/test")
        return {
          shortCircuit: true,
          url: moduleUrl(`export function expect(locator) { return { toBeVisible: () => locator.visible() }; }
            expect.poll = (read) => ({ not: { toBe: async (unexpected) => { if (await read() === unexpected) throw Error("STARTUP_PENDING"); } } });`),
        };
      if (specifier.endsWith("/onboarding-copy.ts"))
        return {
          shortCircuit: true,
          url: moduleUrl(`export const WELCOME_NOTICE_SETTINGS_NAMESPACE = "test-welcome";
            export const WELCOME_NOTICE_ACK_FIELD = "ack";
            export const WELCOME_NOTICE_VERSION = "test-current";`),
        };
    }
    return next(specifier, context);
  },
});
const fixture = await import("./fixtures/business-page.mjs");
hooks.deregister();

const sessionId = "session-11111111-1111-4111-8111-111111111111";
class BrowserPage extends EventEmitter {
  operations = [];
  frame = {};
  request = {
    post: async () => {
      this.operations.push("startup/read");
      return {
        ok: () => true,
        json: async () => ({
          result: {
            ok: true,
            value: { namespaces: [{ ns: "test-welcome", value: { ack: "test-current" } }] },
          },
        }),
      };
    },
  };
  constructor(anonymous = false) {
    super();
    this.anonymous = anonymous;
  }
  url() {
    return "http://127.0.0.1:12345";
  }
  getByRole(role) {
    return role === "dialog"
      ? {
          getByRole: () => ({}),
          waitFor: async () => {
            this.operations.push("startup/resolved");
          },
        }
      : {
          isVisible: async () => {
            this.operations.push("menu/visible");
            return true;
          },
        };
  }
  locator(selector) {
    return selector.includes("data-gea-business-entry")
      ? {
          click: async () => {
            this.operations.push("entry/click");
          },
        }
      : {
          visible: async () => {
            this.operations.push("frame/visible");
          },
          contentFrame: () => this.frame,
        };
  }
  evaluate() {
    return Promise.resolve({ page: "gea-proof", sessionId, preset: "gea-readonly", active: true });
  }
  waitForResponse(predicate) {
    this.operations.push("owner/observe");
    if (this.anonymous) return Promise.reject(Error("ANONYMOUS_OWNER_WAIT"));
    return new Promise((resolve, reject) => {
      this.once("response", async (response) => {
        try {
          if (await predicate(response)) resolve(response);
        } catch (error) {
          reject(error);
        }
      });
    });
  }
  ownerResponse(
    status = 200,
    body = { owner: "owner", binding: { surface: "gea-workbench", tool: "gea_page" } },
  ) {
    this.emit("response", {
      url: () => this.url() + "/api/agent-workbench/page",
      request: () => ({
        postDataJSON: () => ({
          operation: "open",
          pageId: "gea-proof",
          resourceId: "gea-readonly",
          sessionId,
        }),
      }),
      ok: () => status === 200,
      status: () => status,
      json: async () => body,
    });
  }
}

test("anonymous opening returns the visible login frame without waiting for a business owner", async () => {
  const page = new BrowserPage(true);
  assert.equal(await fixture.openSalesPlan(page), page.frame);
  assert.deepEqual(page.operations, [
    "startup/read",
    "startup/resolved",
    "menu/visible",
    "entry/click",
    "frame/visible",
  ]);
});

test("authenticated reading starts owner observation after startup and before its only entry click", async () => {
  const page = new BrowserPage();
  let returned = false;
  const opening = fixture.openReadySalesPlan(page).then((frame) => {
    returned = true;
    return frame;
  });
  await setImmediate();
  assert.equal(returned, false);
  assert.deepEqual(page.operations, [
    "startup/read",
    "startup/resolved",
    "menu/visible",
    "owner/observe",
    "entry/click",
  ]);
  page.ownerResponse();
  assert.equal(await opening, page.frame);
  assert.equal(page.operations.at(-1), "frame/visible");
});

test("authenticated opening preserves a rejected owner response", async () => {
  const page = new BrowserPage();
  const opening = fixture.openReadySalesPlan(page);
  const rejected = assert.rejects(opening, /PAGE_ACCESS_DENIED/);
  await setImmediate();
  page.ownerResponse(403, { error: "PAGE_ACCESS_DENIED" });
  await rejected;
  assert.equal(page.operations.includes("frame/visible"), false);
});

test("registered business pages open directly from current business navigation", async () => {
  const page = new BrowserPage();
  page.getByRole = (role) =>
    role === "dialog"
      ? { getByRole: () => ({}), waitFor: async () => {} }
      : role === "navigation"
        ? {
            isVisible: async () => true,
            getByRole: (entryRole, entry) => ({
              click: async () => page.operations.push([entryRole, entry.name]),
            }),
          }
        : {
            click: async () => {
              throw Error("RETIRED_DIRECTORY_USED");
            },
          };
  await fixture.openWorkbenchPage(page, "分仓库存");
  assert.deepEqual(page.operations.at(-1), ["button", "分仓库存"]);
});

test("native conversation uses the current public new conversation action", async () => {
  const page = new BrowserPage();
  page.getByRole = (role, options) =>
    role === "dialog"
      ? { getByRole: () => ({}), waitFor: async () => {} }
      : { first: () => ({ click: async () => page.operations.push(String(options.name)) }) };
  await fixture.openWorkbenchPage(page, "原生对话");
  assert.equal(page.operations.at(-1), "/^(新会话|New conversation)$/");
});

test("fixture page access preserves profile roots and opens only declared public pages", async (t) => {
  const runtime = await mkdtemp(resolve(tmpdir(), "workbench-page-access-"));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  await fixture.prepareWorkbenchPageAccess(
    [
      ["gea-api-log", "接口日志"],
      ["inventory-probe", "库存样例"],
    ],
    fixture.prepareWorkbenchHtmlRoots(["/fixture/html"]),
  )({ runtime });
  const patch = JSON.parse(
    await readFile(
      resolve(runtime, "home/profiles/plugin-split-validation/cordis.patch.yml"),
      "utf8",
    ),
  );
  assert.deepEqual(patch[0].config.htmlRoots, ["/fixture/html"]);
  assert.equal(patch[1].insert[0].id, "fixture-workbench-page-access");
  let contribution, component;
  const opened = [];
  runInNewContext(
    await readFile(resolve(runtime, "fixtures/workbench-page-access/client.js"), "utf8"),
    {
      window: {
        __ModuleLoader__: {
          load: (value) => {
            contribution = value;
          },
        },
      },
    },
  );
  const plugin = contribution.factory((id) => {
    assert.equal(id, "react");
    return { createElement: (type, props, ...children) => ({ type, props, children }) };
  });
  assert.deepEqual(Array.from(plugin.inject), ["slots", "agentWorkbench"]);
  plugin.apply({
    slots: {
      inject: (slot, mount) => {
        assert.equal(slot, "shell.overlay");
        mount();
      },
      register: (options, render) => {
        assert.equal(options.name, "shell.overlay");
        component = render;
      },
    },
    agentWorkbench: { open: async (id) => opened.push(id) },
  });
  const buttons = component().children.filter((element) => element.type === "button");
  assert.deepEqual(
    buttons.map((button) => button.children[0]),
    ["打开测试页面：接口日志", "打开测试页面：库存样例"],
  );
  for (const button of buttons) await button.props.onClick();
  assert.deepEqual(opened, ["gea-api-log", "inventory-probe"]);
});
