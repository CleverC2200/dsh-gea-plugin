#!/usr/bin/env python3
"""Generate additive Cube measures from a live /playground/files snapshot; never deploy.

Plan plannum/allnum and base qtylive units confirmed as 件 by the user on 2026-09-27.
Existing dealer measures retain their 箱 unit. No source rows or permissions change.
"""
import argparse
import hashlib
import json
from pathlib import Path

import yaml

VERSION = "business-summary-20260927"
MODELS = ("agents_sales_plan_detail_mi", "agents_scm_inventory_age", "agents_scm_cust_inventory_daily")


def col(name):
    return '{CUBE}."' + name + '"'


def measure(name, title, sql, kind, unit, description):
    return dict(name=name, title=title, sql=sql, type=kind, public=True,
                description=description, meta=dict(unit=unit, semantic_version=VERSION))


def distinct(name, title, column, unit, description):
    return measure(name, title, col(column), "count_distinct", unit, description)


def missing(name, title, columns):
    condition = " OR ".join(col(c) + " IS NULL" for c in columns)
    return measure(name, title, "CASE WHEN " + condition + " THEN 1 ELSE 0 END",
                   "sum", "行", "筛选范围内任一指定源字段为 NULL 的记录数；缺失不补零。")


def guarded(name, title, column, checks, unit, description):
    # Aggregate the physical source only after validating each result group's scope.
    sql = "CASE WHEN " + " AND ".join(checks) + " THEN SUM(" + col(column) + ") ELSE NULL END"
    return measure(name, title, sql, "number", unit, description)


def additions(name):
    if name == MODELS[0]:
        result = [
            distinct("customer_count", "有计划记录客户数", "cust_code", "个", "筛选范围内非空客户编码去重数；不是客户主数据或全部授权客户数。"),
            distinct("sku_count", "有计划记录商品数", "material_code", "个", "筛选范围内非空商品编码去重数。"),
            distinct("plan_month_count", "计划月份数", "plane_date", "个月", "每个结果分组中非空计划月份数；汇总要求为1。"),
            distinct("load_batch_count", "加载批次数", "load_time", "批", "每个结果分组中非空加载时间去重数；单批次不代表已核实同步完整。"),
            missing("missing_scope_count", "计划月份或加载时间缺失行数", ["plane_date", "load_time"]),
            missing("missing_plannum_count", "计划量缺失行数", ["plannum"]),
            missing("missing_allnum_count", "合计量缺失行数", ["allnum"]),
            missing("missing_customer_count", "客户编码缺失行数", ["cust_code"]),
            measure("missing_province_count", "省区缺失行数", "CASE WHEN NULLIF(BTRIM(" + col("province_region_name") + "), '') IS NULL THEN 1 ELSE 0 END", "sum", "行",
                    "省区为NULL、空字符串或只有空格的行数；缺失行不能归入已知省区，也不能借其他表猜测归属。按省区回答时同时查询此指标。"),
        ]
        grain = ", ".join(col(c) for c in ("cust_code", "material_code", "belong_base", "repertory_org"))
        result.append(measure("candidate_grain_count", "候选业务粒度去重数", "(" + grain + ")", "count_distinct", "组",
                              "候选粒度=客户×商品×归属基地×提货点；仅2026-08样本核实唯一，不作为已确认主键。与记录数不等时数量汇总返回NULL，需核对粒度。"))
        checks = ["{plan_month_count} = 1", "{load_batch_count} = 1", "{missing_scope_count} = 0", "{candidate_grain_count} = {row_count}"]
        for field, title in (("plannum", "计划量合计"), ("allnum", "最终计划合计量")):
            result.append(guarded(field + "_sum", title, field, checks + ["{missing_" + field + "_count} = 0"], "件",
                "直接汇总源列" + field + "，单位件（业务2026-09-27确认）；每个结果分组限一个计划月、一个加载批次、无数量/范围缺失且候选粒度不重复，否则NULL。只查询本模型，不跨模型连接；NULL不是0，空月份不能回退在线或预测表；plannum和allnum不能相加。单批次不证明同步完整。"))
        return result
    if name == MODELS[1]:
        return [
            distinct("warehouse_count", "有库存记录仓库数", "warehouseid", "个", "筛选范围内非空仓库编码去重数；不是仓库主数据总数。"),
            distinct("sku_count", "有库存记录商品数", "material_code", "个", "筛选范围内非空商品编码去重数。"),
            distinct("snapshot_date_count", "库存快照日期数", "snapshot_date", "天", "每个结果分组中非空快照日期去重数。"),
            distinct("snapshot_batch_count", "库存快照时刻数", "snapshot_time", "批", "每个结果分组中非空快照时刻去重数；单时刻不证明同步完整。"),
            missing("missing_snapshot_count", "快照日期或时刻缺失行数", ["snapshot_date", "snapshot_time"]),
            missing("missing_qtylive_count", "可用库存缺失行数", ["qtylive"]),
            guarded("available_qty_sum", "基地可用库存合计", "qtylive", ["{snapshot_date_count} = 1", "{snapshot_batch_count} = 1", "{missing_snapshot_count} = 0", "{missing_qtylive_count} = 0"], "件",
                "qtylive可用库存源列合计，单位件（业务2026-09-27确认）；每个结果分组限一个快照日期和时刻且无数量/快照缺失，否则NULL。只查询本模型，不跨模型连接；不跨快照累加，不与现存qty相加；单时刻不证明同步完整。"),
        ]
    if name == MODELS[2]:
        return [
            distinct("customer_count", "有库存记录客户数", "cust_code", "个", "筛选范围内非空客户编码去重数；不是全部授权客户数，不能据此断言没有记录的客户库存为0。"),
            distinct("sku_count", "有库存记录商品数", "material_code", "个", "筛选范围内非空商品编码去重数。"),
            distinct("stat_date_count", "统计批次日期数", "stat_date", "天", "汇总必须限定一个stat_date；与实际库存日期不同。"),
            distinct("inventory_snapshot_date_count", "实际库存日期数", "inventory_snapshot_date", "天", "同一统计批次可能包含多个实际库存日期；大于1时不能称为同一天实时库存。"),
            missing("missing_stock_qty_count", "在仓库存缺失行数", ["stock_qty"]),
            missing("missing_in_transit_qty_count", "在途库存缺失行数", ["in_transit_qty"]),
            missing("missing_stock_amt_count", "库存金额缺失行数", ["stock_amt"]),
            missing("missing_snapshot_count", "实际库存日期缺失行数", ["inventory_snapshot_date"]),
            missing("missing_stat_date_count", "统计日期缺失行数", ["stat_date"]),
            missing("missing_customer_count", "客户编码缺失行数", ["cust_code"]),
        ]
    raise ValueError(name)


def transform(name, source):
    before = yaml.safe_load(source)
    cube = before["cubes"][0]
    if cube["name"] != name or cube["data_source"] != "gea_agent" or len(before["cubes"]) != 1:
        raise ValueError("Unexpected model " + name)
    if list(cube)[-1] != "measures":
        raise ValueError("Refuse textual append: measures must be last")
    existing = {m["name"]: m for m in cube["measures"]}
    new = []
    for m in additions(name):
        if m["name"] in existing:
            if m != existing[m["name"]]:
                raise ValueError("Conflicting measure " + m["name"])
        else:
            new.append(m)
    if not new:
        return source
    suffix = yaml.safe_dump(new, allow_unicode=True, sort_keys=False, width=120)
    result = source.rstrip() + "\n" + "\n".join("      " + line for line in suffix.splitlines()) + "\n"
    expected = yaml.safe_load(source)
    expected["cubes"][0]["measures"].extend(new)
    assert yaml.safe_load(result) == expected, "Existing model changed"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    files = {f["fileName"]: f["content"] for f in json.loads(args.snapshot.read_text())["files"]}
    manifest = []
    args.output.mkdir(parents=True, exist_ok=True)
    for name in MODELS:
        path = "cubes/" + name + ".yml"
        source = files[path]
        candidate = transform(name, source)
        assert transform(name, candidate) == candidate
        (args.output / (name + ".yml")).write_text(candidate)
        manifest.append(dict(fileName=path, originalSha256=hashlib.sha256(source.encode()).hexdigest(),
                             candidateSha256=hashlib.sha256(candidate.encode()).hexdigest(),
                             addedMeasures=[m["name"] for m in additions(name)]))
    (args.output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
