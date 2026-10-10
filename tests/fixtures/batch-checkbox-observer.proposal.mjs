/** Static proposal. Importing defines helpers; it does not launch a browser or Host. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const nativePath = '/api/agent-workbench/native';

function installDomProbe({ key, role, generation, lifetimeMs }) {
  globalThis[key]?.stop();
  const began = performance.now();
  const deadline = Date.now() + lifetimeMs;
  const ids = new WeakMap();
  let nextId = 1, stopped = false, rafId, timerId, lastRaf, lastSample = -Infinity;
  let rafCount = 0, mutationCount = 0, resizeCount = 0, dropped = 0;
  let overheadTotalMs = 0, overheadMaxMs = 0, workCount = 0;
  let firstRoot, firstLabel, firstIframe;
  const records = [];
  const observed = new WeakSet();
  const id = (element) => {
    if (!element) return null;
    if (!ids.has(element)) ids.set(element, nextId++);
    return ids.get(element);
  };
  const rect = (element) => {
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  };
  const visible = (element) => {
    if (!element?.isConnected || element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none';
  };
  const push = (record) => {
    if (records.length === 256) { records.shift(); dropped++; }
    records.push({ atMs: performance.now(), ...record });
  };
  const measured = (work) => {
    const start = performance.now();
    try { work(); } finally {
      const elapsed = performance.now() - start;
      overheadTotalMs += elapsed;
      overheadMaxMs = Math.max(overheadMaxMs, elapsed);
      workCount++;
    }
  };
  const mutation = new MutationObserver((changes) => measured(() => {
    mutationCount += changes.length;
  }));
  const resize = new ResizeObserver((changes) => measured(() => {
    resizeCount += changes.length;
  }));
  // Track subtree additions/removals by count, without reading their content or attributes.
  mutation.observe(document.documentElement, { childList: true, subtree: true });
  const watch = (element) => {
    if (!element || observed.has(element)) return;
    observed.add(element);
    resize.observe(element);
  };
  const node = (element) => element ? {
    id: id(element), isConnected: element.isConnected, rect: rect(element), visible: visible(element),
  } : null;
  const sample = (trigger) => measured(() => {
    const root = role === 'top' ? document.documentElement : document.querySelector('[data-testid="regional-approval-workbench"]');
    const frames = role === 'top' ? document.querySelectorAll('iframe[src^="/api/agent-workbench/native?"]') : [];
    const dialogs = role === 'native' ? document.querySelectorAll('[data-testid="regional-approval-batch-action-dialog"]') : [];
    const dialog = dialogs.length === 1 ? dialogs[0] : null;
    const labels = dialog ? dialog.querySelectorAll('label.arco-checkbox') : [];
    const label = labels.length === 1 ? labels[0] : null;
    const modal = dialog?.closest('.arco-modal') ?? null;
    const input = label?.querySelector('input[type="checkbox"]') ?? null;
    firstRoot ??= root;
    firstLabel ??= label;
    firstIframe ??= frames[0];
    const ancestors = [];
    for (let current = label?.parentElement, count = 0; current && count < 5; current = current.parentElement, count++) {
      const style = getComputedStyle(current);
      ancestors.push({
        id: id(current), tag: current.tagName, rect: rect(current), isConnected: current.isConnected,
        transform: style.transform, transformOrigin: style.transformOrigin,
        transitionDuration: style.transitionDuration, animationName: style.animationName,
        // Only library lifecycle classes; no application data, text, value, URL or attributes.
        modalClasses: [...current.classList].filter((value) => /^(?:arco-modal|zoomModal|fadeModal)/.test(value)),
      });
      watch(current);
    }
    [root, modal, label, dialog?.querySelector('textarea'), frames[0]].forEach(watch);
    push({
      event: 'sample', trigger, visibility: document.visibilityState,
      root: node(root), iframeCount: frames.length, iframe: node(frames[0]),
      dialogCount: dialogs.length, dialog: node(dialog), modal: node(modal), labelCount: labels.length, label: node(label),
      input: input ? { disabled: input.disabled, checked: input.checked } : null,
      textarea: node(dialog?.querySelector('textarea')), ancestors,
      firstObserved: { root: node(firstRoot), label: node(firstLabel), iframe: node(firstIframe) },
      // This is observable DOM actionability, not business authority or a new wait gate.
      ready: role === 'native' ? {
        rootConnected: Boolean(root?.isConnected), rootVisible: visible(root),
        uniqueDialog: dialogs.length === 1, dialogVisible: visible(dialog),
        uniqueLabel: labels.length === 1, labelConnected: Boolean(label?.isConnected),
        labelVisible: visible(label), inputEnabled: Boolean(input && !input.disabled),
      } : null,
      scroll: { x: window.scrollX, y: window.scrollY }, rafCount,
      lastRafAgeMs: lastRaf === undefined ? null : performance.now() - lastRaf,
      mutationCount, resizeCount,
    });
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(rafId);
    clearInterval(timerId);
    mutation.disconnect();
    resize.disconnect();
  };
  const raf = (at) => {
    if (stopped || Date.now() >= deadline) { stop(); return; }
    measured(() => {
      rafCount++;
      if (lastRaf !== undefined && at - lastRaf > 100) push({ event: 'raf-gap', gapMs: at - lastRaf });
      lastRaf = at;
    });
    if (at - lastSample >= 100) { lastSample = at; sample('raf'); }
    rafId = requestAnimationFrame(raf);
  };
  timerId = setInterval(() => {
    if (Date.now() >= deadline) { stop(); return; }
    sample('timer');
  }, 250);
  sample('install');
  rafId = requestAnimationFrame(raf);
  const take = () => ({
    role, generation, stopped, elapsedMs: performance.now() - began,
    timeOriginMs: performance.timeOrigin, records: records.splice(0), dropped,
    overhead: { workCount, totalMs: overheadTotalMs, maxMs: overheadMaxMs },
  });
  globalThis[key] = { take, stop };
  return { role, generation, timeOriginMs: performance.timeOrigin };
}

/** Use only in the explicitly owned fixture page/context; never in an existing user tab. */
export async function startBatchCheckboxObserver({ page, artifactDirectory, sampleId }) {
  if (!/^[a-z0-9-]+$/.test(sampleId)) throw Error('OBSERVER_SAMPLE_ID_REQUIRED');
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const key = '__geaBatchGeometryProbe_' + randomUUID().replaceAll('-', '');
  const start = performance.now(), records = [], frames = new Map();
  let stopping = false, generation = 0, nodeDropped = 0, clickVerdict = 'not-started';
  const record = (value) => {
    if (records.length === 512) { records.shift(); nodeDropped++; }
    records.push({ nodeElapsedMs: performance.now() - start, ...value });
  };
  const target = (frame) => {
    if (frame === page.mainFrame()) return 'top';
    try { return new URL(frame.url()).pathname === nativePath ? 'native' : null; } catch { return null; }
  };
  const bounded = async (promise, limitMs = 1000) => {
    let timer;
    try {
      return await Promise.race([
        promise.then((value) => ({ status: 'captured', value }), (error) => ({ status: 'unknown', reason: error.name })),
        new Promise((done) => { timer = setTimeout(() => done({ status: 'unknown', reason: 'observer-retrieval-deadline' }), limitMs); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const readFrame = (frame, entry) => {
    if (entry.pending || stopping) return;
    entry.pending = true;
    const began = performance.now();
    const operation = frame.evaluate(({ key }) => globalThis[key]?.take() ?? null, { key }).then(async (snapshot) => {
      if (snapshot === null && !stopping) {
        const assigned = ++generation;
        const installed = await frame.evaluate(installDomProbe, { key, role: entry.role, generation: assigned, lifetimeMs: 30000 });
        record({ event: 'document-probe-installed', ...installed, installWallMs: performance.now() - began });
      } else if (snapshot) {
        record({ event: 'document-samples', ...snapshot, drainWallMs: performance.now() - began });
      }
    }).catch((error) => record({ event: 'document-read-unknown', role: entry.role, reason: error.name }))
      .finally(() => { entry.pending = false; entry.operation = undefined; });
    entry.operation = operation;
    // No repeated evaluations accumulate while this renderer is stalled.
    void bounded(operation).then((result) => {
      if (result.status === 'unknown') record({ event: 'document-read-deadline', role: entry.role, reason: result.reason });
    });
  };
  const poll = () => {
    for (const frame of page.frames()) {
      const role = target(frame);
      if (!role) continue;
      if (!frames.has(frame)) frames.set(frame, { role, pending: false });
      readFrame(frame, frames.get(frame));
    }
  };
  const navigated = (frame) => {
    const role = target(frame) ?? frames.get(frame)?.role;
    if (role) record({ event: 'frame-navigated', role });
  };
  const detached = (frame) => {
    const role = frames.get(frame)?.role;
    if (role) { record({ event: 'frame-detached', role }); frames.delete(frame); }
  };
  const crash = () => record({ event: 'page-crash' });
  const closed = () => record({ event: 'page-close' });
  page.on('framenavigated', navigated);
  page.on('framedetached', detached);
  page.on('crash', crash);
  page.on('close', closed);
  poll();
  await bounded(Promise.all([...frames.values()].map((entry) => entry.operation)));
  const timer = setInterval(poll, 250);
  record({ event: 'observer-started', installWallMs: performance.now() - start });
  const save = async (extra = {}) => writeFile(join(artifactDirectory, sampleId + '.observer.json'), JSON.stringify({
    schema: 'gea-batch-checkbox-observer-proposal-v1', sampleId,
    capturedAt: new Date().toISOString(), nodeTimeOriginMs: performance.timeOrigin, clickVerdict,
    bounds: { domRing: 256, nodeRing: 512, rafSampleMs: 100, timerAndDrainMs: 250, autoStopMs: 30000, retrievalMs: 1000 },
    privacy: 'geometry/identity/booleans only; no text, form value, URL, cookie, header or credential collection',
    nodeDropped, records, ...extra,
  }, null, 2) + '\n', { mode: 0o600 });
  return {
    /** callback must be exactly the existing ordinary locator.click(), with no option changes. */
    async originalClick(callback, label) {
      const began = performance.now();
      clickVerdict = 'in-progress';
      record({ event: 'original-click-started' });
      try {
        const value = await callback();
        clickVerdict = 'returned';
        record({ event: 'original-click-returned', clickWallMs: performance.now() - began });
        return value;
      } catch (error) {
        clickVerdict = 'failed';
        record({ event: 'original-click-failed', name: error.name, clickWallMs: performance.now() - began });
        // Preserve the original Playwright click error before any renderer request or fixture cleanup.
        try {
          await writeFile(join(artifactDirectory, sampleId + '.original-click.raw.log'), error.stack ?? String(error), { mode: 0o600 });
          await save({ clickVerdict: 'failed' });
        } catch (captureError) { record({ event: 'primary-persistence-failed', reason: captureError.name }); }
        try {
          const box = await bounded(label.boundingBox());
          if (box.status === 'captured' && box.value && box.value.width > 0 && box.value.height > 0) {
            // Target checkbox only, with its text masked; no fallback to full-page screenshots.
            const screenshot = await bounded(page.screenshot({
              path: join(artifactDirectory, sampleId + '.checkbox.png'), clip: box.value,
              mask: [label.locator('.arco-checkbox-text')], animations: 'allow', timeout: 1000,
            }));
            record({ event: 'checkbox-screenshot', status: screenshot.status, reason: screenshot.reason });
          } else record({ event: 'checkbox-screenshot', status: 'unknown', reason: box.reason ?? 'target-box-unavailable' });
        } catch (captureError) { record({ event: 'checkbox-screenshot', status: 'unknown', reason: captureError.name }); }
        throw error;
      }
    },
    /** Await in the test body's finally, before existing t.after cleanup deletes the profile. */
    async stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      // Drain then stop each live document. Pending renderer requests stay bounded and cannot block cleanup.
      const results = await Promise.all([...frames.entries()].map(async ([frame, entry]) => {
        if (entry.pending) await bounded(entry.operation);
        const result = await bounded(frame.evaluate(({ key }) => {
          const probe = globalThis[key];
          if (!probe) return { missing: true };
          probe.stop();
          const snapshot = probe.take();
          delete globalThis[key];
          return snapshot;
        }, { key }));
        if (result.status === 'captured') record({ event: 'document-final-samples', ...result.value });
        else record({ event: 'document-stop-unknown', role: entry.role, reason: result.reason });
        return { role: entry.role, status: result.status, reason: result.reason };
      }));
      page.off('framenavigated', navigated);
      page.off('framedetached', detached);
      page.off('crash', crash);
      page.off('close', closed);
      record({ event: 'observer-stopped', results });
      try {
        await save();
        return { captureStatus: 'saved', results };
      } catch (error) {
        // Capture failure must not replace the original click error in the caller's finally.
        return { captureStatus: 'unknown', reason: error.name, results };
      }
    },
  };
}
