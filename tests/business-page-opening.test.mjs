import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";

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
