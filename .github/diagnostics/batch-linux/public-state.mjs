import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function installBatchObserver() {
  const previousObserver = window.__geaBatchObserver;
  if (previousObserver?.body === document.body) {
    previousObserver.capture('action-check');
    return;
  }
  previousObserver?.controller.abort();
  previousObserver?.observers.forEach((observer) => observer.disconnect());
  const controller = new AbortController();
  const observers = [];
  let previous;
  let counter = 0;
  const nodes = new WeakMap();
  const roots = new WeakSet();
  const send = (value) => void window.__batchPublicDiagnostic(value).catch(() => {});
  const all = (root, selector) => {
    const found = [...root.querySelectorAll(selector)];
    for (const node of root.querySelectorAll('*')) {
      if (!node.shadowRoot) continue;
      watch(node.shadowRoot);
      found.push(...all(node.shadowRoot, selector));
    }
    return found;
  };
  const capture = (reason, event) => {
    const dialog = all(document, '[data-testid="regional-approval-batch-action-dialog"]')[0];
    if (!dialog) return;
    const confirm = all(document, 'button').find((button) => button.textContent.replace(/\s/g, '').includes('确认批量退回'));
    if (!confirm) return;
    const textarea = all(dialog, 'textarea')[0];
    if (textarea && !nodes.has(textarea)) nodes.set(textarea, ++counter);
    const state = {
      node: textarea ? nodes.get(textarea) : null,
      remarkValue: textarea?.value?.slice(0, 80) ?? null,
      remarkDefaultValue: textarea?.defaultValue?.slice(0, 80) ?? null,
      confirmDisabled: confirm.disabled,
      confirmAriaDisabled: confirm.getAttribute('aria-disabled'),
      summary: dialog.querySelector('[data-testid="regional-approval-batch-summary"]')?.textContent ?? null,
      resultPresent: !!all(document, '[data-testid="regional-approval-batch-result"]').length,
      busy: confirm.classList.contains('arco-btn-loading') || !!confirm.querySelector('.arco-icon-loading'),
      inputDisabled: textarea?.disabled ?? null,
      inputFocused: textarea === document.activeElement || textarea === textarea?.getRootNode()?.activeElement,
    };
    const signature = JSON.stringify(state);
    if (signature === previous && !event) return;
    previous = signature;
    send({ kind: 'dialog', reason, pageTime: performance.now(), documentOrigin: performance.timeOrigin, state, ...(event ? { event: { type: event.type, trusted: event.isTrusted, inputType: event.inputType ?? null, composing: event.isComposing ?? null } } : {}) });
  };
  function watch(root) {
    if (roots.has(root)) return;
    roots.add(root);
    const observer = new MutationObserver(() => capture('mutation'));
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'aria-busy', 'data-testid', 'value'] });
    observers.push(observer);
    for (const name of ['input', 'change', 'focusin', 'focusout']) root.addEventListener(name, (event) => {
      if (event.target instanceof HTMLTextAreaElement) {
        capture('event', event);
        queueMicrotask(() => capture('after-event'));
      }
    }, { capture: true, signal: controller.signal });
  }
  window.__geaBatchObserver = { body: document.body, controller, observers, capture };
  watch(document);
  capture('observer-installed');
  send({ kind: 'observer-installed', documentReadyState: document.readyState });
}

if (process.env.GEA_BATCH_DIAGNOSTICS === '1' && process.argv.some((arg) => arg.endsWith('tests/group-selection-web.test.mjs') || arg.endsWith('observer-selfcheck.mjs'))) {
  const require = createRequire(process.env.GEA_BATCH_DIAGNOSTIC_PACKAGE);
  const { chromium } = require('@playwright/test');
  const output = process.env.GEA_BATCH_DIAGNOSTIC_OUTPUT;
  let contextIndex = 0;
  const locatorPrototypes = new WeakSet();
  const write = (value) => appendFileSync(output, JSON.stringify({ tag: 'DEBUG-batch-linux-20261026', at: new Date().toISOString(), pid: process.pid, ...value }) + '\n', { mode: 0o600 });
  const hash = (value) => typeof value === 'string' ? createHash('sha256').update(value).digest('hex').slice(0, 12) : null;
  const launch = chromium.launch;
  chromium.launch = async function (...args) {
    const browser = await launch.apply(this, args);
    const newContext = browser.newContext;
    browser.newContext = async function (...args) {
      const context = await newContext.apply(this, args);
      const contextId = ++contextIndex;
      const frames = new WeakMap();
      let frameIndex = 0;
      await context.exposeBinding('__batchPublicDiagnostic', ({ frame }, state) => {
        if (!frames.has(frame)) frames.set(frame, ++frameIndex);
        write({ contextId, frameId: frames.get(frame), ...state });
      });
      const observe = (page) => {
        for (const frame of page.frames()) void frame.evaluate(installBatchObserver).catch((error) => write({ kind: 'observer-unavailable', error: error.name }));
      };
      context.on('page', (page) => {
        const prototype = Object.getPrototypeOf(page.locator('body'));
        if (!locatorPrototypes.has(prototype)) {
          locatorPrototypes.add(prototype);
          for (const method of ['click', 'fill']) {
            const original = prototype[method];
            prototype[method] = function (...args) {
              const result = original.apply(this, args);
              void result.then(() => observe(this.page())).catch(() => {});
              return result;
            };
          }
        }
        page.on('response', async (response) => {
        if (new URL(response.url()).pathname !== '/api/agent-workbench/page') return;
        try {
          const input = response.request().postDataJSON();
          if (input?.operation !== 'open' || input.pageId !== 'gea-proof') return;
          const receipt = await response.json();
          const association = await page.evaluate(() => {
            const record = JSON.parse(localStorage.getItem('agent-workbench.presentation.v2') ?? 'null');
            return record?.version === 2 ? record.selections.find((row) => row.page === 'gea-proof' && row.active) : null;
          });
          write({ kind: 'owner', contextId, status: response.status(), sessionHash: hash(input.sessionId), ownerHash: hash(receipt.owner), associationMatchesRequest: association?.sessionId === input.sessionId, presetMatchesRequest: association?.preset === input.resourceId, surface: receipt.binding?.surface ?? null, tool: receipt.binding?.tool ?? null });
        } catch (error) { write({ kind: 'owner-unavailable', contextId, error: error.name }); }
        });
      });
      return context;
    };
    return browser;
  };
}
