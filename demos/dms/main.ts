import { MockDmsWriteback, type DmsMockOutcome } from "../../src/mock-dms.ts";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const type = $<HTMLSelectElement>("type");
const order = $<HTMLSelectElement>("order");
const outcome = $<HTMLSelectElement>("outcome");
let model: MockDmsWriteback;
function reset() {
  model = new MockDmsWriteback({
    planId: `MOCK-${type.value}-${order.value}`,
    versionId: "MOCK-V1",
    typeCode: type.value,
    orderType: order.value as "M" | "Z",
    status: 4,
    skus: [
      {
        skuCode: "MOCK-SKU-01",
        qty: "12.500",
        addQty: order.value === "Z" ? "2.500" : "0",
        cutQty: order.value === "Z" ? "1.250" : "0",
      },
    ],
  });
  $("error").textContent = "";
  render();
}
function render() {
  const state = model.read();
  outcome.querySelector<HTMLOptionElement>("option[value=partial]")!.disabled =
    state.plan.orderType !== "Z";
  if (state.plan.orderType !== "Z" && outcome.value === "partial")
    outcome.value = "success";
  $("status").textContent =
    state.plan.status === 4
      ? "4 · 待品类终审"
      : state.plan.status === 5
        ? "5 · 品类已审批（待回写）"
        : "10 · 回写完成";
  $("sync").textContent = state.syncStatus;
  $("finished").textContent = state.finishedAt ?? "尚未完成";
  $("deliveries").textContent = String(state.remoteDeliveries);
  $("attempts").textContent = String(state.attempts);
  $("source").textContent = `${state.plan.planId} / ${state.plan.versionId}`;
  $("packets").textContent = JSON.stringify(state.packets, null, 2);
  $("receipts").textContent = JSON.stringify(state.receipts, null, 2);
  $("logs").textContent =
    state.logs
      .map(
        (log) =>
          `${log.at}  ${log.action}  ${log.status} / ${log.syncStatus}\n${log.detail}`,
      )
      .join("\n\n") || "尚无操作";
  $<HTMLButtonElement>("approve").disabled = state.plan.status !== 4;
  $<HTMLButtonElement>("send").disabled =
    state.plan.status !== 5 || state.syncStatus === "UNKNOWN";
  $<HTMLButtonElement>("reconcile").disabled = state.plan.status !== 5;
  $<HTMLButtonElement>("duplicate").disabled = state.syncStatus !== "SYNCED";
  $("notice").textContent =
    state.syncStatus === "UNKNOWN"
      ? "结果未知：先对账，不能直接重投。"
      : state.syncStatus === "FAILED"
        ? "失败仍停在 5；选择成功场景后可按原键重试。"
        : state.syncStatus === "SYNCED"
          ? "所有报文已确认，同步状态与完成时间同时落定。"
          : "只有品类终审后才允许模拟回写。";
}
function run(action: () => void) {
  try {
    action();
    $("error").textContent = "";
  } catch (error) {
    $("error").textContent =
      error instanceof Error ? error.message : String(error);
  }
  render();
}
$("approve").onclick = () => run(() => model.approve());
$("send").onclick = () =>
  run(() => model.deliver(outcome.value as DmsMockOutcome));
$("reconcile").onclick = () => run(() => model.reconcile());
$("duplicate").onclick = () =>
  run(() => model.acceptReceipts(model.read().receipts));
$("reset").onclick = reset;
type.onchange = reset;
order.onchange = reset;
reset();
