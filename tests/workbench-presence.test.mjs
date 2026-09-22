/**
 * "这个对话在不在业务工作台"的校验。
 *
 * 线上现象：用户在**主对话**里问业务问题，助手却把几分钟前在业务工作台留下的快照
 * 当成"你眼前这一屏"，还据此去读页面证据。这里钉住判定顺序与窗口。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKBENCH_PRESENCE_TTL_MS,
  workbenchPresence,
} from "../src/host/workbench-presence.ts";

const now = 1_700_000_000_000;

test("页面桥有心跳就是工作台（最权威），并报告快照年龄", () => {
  const presence = workbenchPresence({
    livePage: true,
    snapshotReceivedAt: now - 120_000,
    now,
  });
  assert.equal(presence.inWorkbench, true);
  assert.equal(presence.signal, "page-bridge");
  assert.equal(presence.staleSnapshotSeconds, 120);
});

test("HTML 插件页靠页面身份判定", () => {
  const presence = workbenchPresence({ hasPageIdentity: true, now });
  assert.equal(presence.inWorkbench, true);
  assert.equal(presence.signal, "page-identity");
});

test("没有心跳时，只有新鲜的原生快照才算还在工作台", () => {
  const fresh = workbenchPresence({
    snapshotReceivedAt: now - 30_000,
    now,
  });
  assert.equal(fresh.inWorkbench, true);
  assert.equal(fresh.signal, "snapshot-fresh");

  const stale = workbenchPresence({
    snapshotReceivedAt: now - (WORKBENCH_PRESENCE_TTL_MS + 1_000),
    now,
  });
  assert.equal(stale.inWorkbench, false);
  assert.equal(stale.signal, "none");
  assert.equal(stale.staleSnapshotSeconds, 61);
});

test("主对话（什么都没有）不在工作台", () => {
  const presence = workbenchPresence({ now });
  assert.equal(presence.inWorkbench, false);
  assert.equal(presence.signal, "none");
  assert.equal(presence.staleSnapshotSeconds, undefined);
});

test("窗口是 60 秒：刚好到点仍算在页面，超过就只算上次留下的", () => {
  assert.equal(WORKBENCH_PRESENCE_TTL_MS, 60_000);
  assert.equal(
    workbenchPresence({ snapshotReceivedAt: now - 60_000, now }).inWorkbench,
    true,
  );
  assert.equal(
    workbenchPresence({ snapshotReceivedAt: now - 61_000, now }).inWorkbench,
    false,
  );
});
