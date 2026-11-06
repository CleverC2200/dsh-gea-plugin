import { readFile } from "node:fs/promises";
import { stock } from "./branch-stock.mjs";

/** The source-update fixture serves the installed fixed SQL, including its daily bundle. */
export async function configuredBranchStockFixture() {
  const config = JSON.parse(
    await readFile("../dsh-agent-workbench/business/inventory-fc/sql.config.json", "utf8"),
  );
  const metadata = {
    batch_id: "fixture_20260929",
    business_date: "2026-09-29",
    stock_date: "2026-09-29",
    target_month: "2026-09-01",
  };
  const inventory = stock.map((row) => ({
    warehouse_code: "FC06",
    warehouse_name: "长沙分仓",
    sku: row.material_code,
    material_name: row.material_name,
    category: row.product_categ_name,
    material_group: "测试产品",
    stock_date: metadata.stock_date,
    inventory_qty: row.live_qty,
    available_qty: row.available_qty,
    occupied_qty: row.live_qty - row.available_qty,
    frozen_qty: 0,
    stock_present: 1,
    plan_present: 1,
    source_rows: 1,
    plan_calculable: 1,
    cycle_days: 7,
    calculation_status: "fixture",
    daily_plan: 10,
    target_inventory_qty: 100,
    recommended_qty: Math.max(100 - row.available_qty, 0),
    page_scope_total: stock.length,
    page_row_present: 1,
    page_scope_has_material_group: 1,
  }));
  const rowsFor = (id) => {
    const query = config.queries[id];
    const name = id.replace(/^snapshot(?:-default)?\./, "");
    const blank = () => Object.fromEntries(query.resultColumns.map((column) => [column, null]));
    if (id === "summary.snapshot") return [metadata];
    if (id === "summary.bootstrap" || id === config.dailySummary.bundle.queryId) {
      const combined = config.dailySummary.bundle.members.flatMap((member) => {
        const rows = rowsFor(member.queryId);
        return (rows.length ? rows : [null]).map((row) => ({
          ...blank(),
          ...metadata,
          bundle_part: member.part,
          bundle_total: rows.length,
          bundle_present: row ? 1 : null,
          bundle_scope_total: rows.length,
          ...Object.fromEntries(
            Object.entries(member.columns).map(([field, alias]) => [alias, row?.[field] ?? null]),
          ),
        }));
      });
      const scalar = {
        ...blank(),
        ...metadata,
        bundle_part: "scalar",
        bundle_total: 1,
        bundle_present: 1,
      };
      for (const member of config.dailySummary.bundle.members.filter(
        (part) => part.part === "scalar",
      )) {
        const first = rowsFor(member.queryId)[0];
        for (const [field, alias] of Object.entries(member.columns))
          scalar[alias] = first?.[field] ?? null;
      }
      const bundleRows = [...combined.filter((row) => row.bundle_part !== "scalar"), scalar];
      return bundleRows.map((row) => ({ ...row, bundle_scope_total: bundleRows.length }));
    }
    if (name === "branch-warehouse.directory")
      return [{ warehouse_code: "FC06", warehouse_name: "长沙分仓", base: "郑州" }];
    if (name === "branch-warehouse.directory.count") return [{ total: 1 }];
    if (name.startsWith("source.") && name.endsWith("-date"))
      return [
        {
          ...blank(),
          day: metadata.stock_date,
          row_count: 2,
          total_qty: 160,
          available_qty: 130,
          pack_unit_qty: 1,
          freeze_qty: 0,
        },
      ];
    if (name.startsWith("replenishment") && name.endsWith(".atomic"))
      return inventory.map((row) => ({ ...blank(), ...row }));
    if (/replenishment.*(?:summary|overview)/.test(name))
      return [
        {
          ...blank(),
          row_count: 2,
          inventory_qty: 160,
          available_qty: 130,
          occupied_qty: 30,
          frozen_qty: 0,
          recommended_qty: 70,
          target_inventory_qty: 200,
        },
      ];
    if (name.endsWith(".count") || name.endsWith("_count")) return [{ total: 0 }];
    if (/summary|overview/.test(name)) return [{ ...blank(), row_count: 0 }];
    if (/health|orders|shipment|support|production|calendar/.test(name)) return [];
    throw Error("UNEXPECTED_CONFIGURED_BRANCH_FIXTURE: " + id);
  };
  return (request) => {
    const entry = Object.entries(config.queries).find(
      ([, query]) => query.request.sql === request.sql,
    );
    if (!entry) return undefined;
    const [id, query] = entry;
    return { rows: rowsFor(id), returnedColumns: query.resultColumns };
  };
}
