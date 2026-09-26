#!/usr/bin/env python3
"""Run a focused offline check of the two local sales forecast Cube drafts."""

from __future__ import annotations

import json
import math
import sqlite3
from datetime import date
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures.json"
BASE_MODEL = ROOT / "agents_sales_forecast_detail_mi.yml"
EFFECTIVE_MODEL = ROOT / "agents_sales_forecast_effective_revision.yml"
Q01 = ROOT / "Q01.cube-query.json"
REPORT = ROOT / "validation-report.json"


def equal(actual: float, expected: float, label: str) -> None:
    if not math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-12):
        raise AssertionError(f"{label}: {actual} != {expected}")


def run() -> dict:
    fixture = json.loads(FIXTURES.read_text())
    assert fixture["synthetic"] is True
    as_of = date.fromisoformat(fixture["as_of_date"])
    base = yaml.safe_load(BASE_MODEL.read_text())["cubes"][0]
    effective = yaml.safe_load(EFFECTIVE_MODEL.read_text())["cubes"][0]
    assert base["name"] == "agents_sales_forecast_detail_mi"
    assert effective["name"] == "agents_sales_forecast_effective_revision"
    assert len(base["dimensions"]) == 51
    assert len(base["measures"]) == 10
    assert next(m for m in base["measures"] if m["name"]=="row_count")["type"]=="count"
    assert len(effective["measures"]) == 5
    q01 = json.loads(Q01.read_text())
    measure_members = {f'{effective["name"]}.{m["name"]}' for m in effective["measures"]}
    dimension_members = {f'{effective["name"]}.{d["name"]}' for d in effective["dimensions"]}
    assert set(q01["measures"]) <= measure_members
    assert set(q01["dimensions"]) <= dimension_members
    assert q01["filters"] == [{"member": "agents_sales_forecast_effective_revision.plan_month", "operator": "equals", "values": ["202608"]}]

    expected_filters = {
        "monthly_initial_predicted_sales_amount": ("'M'", '"is_split" = 1'),
        "monthly_initial_actual_sales_amount": ("'M'",),
        "correction_rows_predicted_sales_amount": ("'Z'",),
        "correction_rows_actual_sales_amount": ("'Z'",),
        "monthly_initial_predicted_quantity": ("'M'", '"is_split" = 1'),
        "monthly_initial_actual_sales_quantity": ("'M'",),
        "correction_rows_predicted_quantity": ("'Z'",),
        "correction_rows_actual_sales_quantity": ("'Z'",),
    }
    for measure in base["measures"]:
        if measure["name"] == "row_count":
            continue
        if measure["name"] == "monthly_initial_attainment_rate":
            assert measure["type"] == "number"
            assert "{monthly_initial_actual_sales_amount}" in measure["sql"]
            assert "{monthly_initial_predicted_sales_amount}" in measure["sql"]
            assert "NULLIF" in measure["sql"]
            continue
        sql = measure["filters"][0]["sql"]
        for token in expected_filters[measure["name"]]:
            assert token in sql, (measure["name"], token)
        if measure["name"] in {"monthly_initial_actual_sales_amount", "monthly_initial_actual_sales_quantity"}:
            assert "is_split" not in sql
        if "quantity" in measure["name"]:
            assert measure["meta"]["unit"] == "件"

    rows = fixture["rows"]
    columns = list(rows[0])
    assert all(list(row) == columns for row in rows)
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("ATTACH DATABASE ':memory:' AS data_service")
    definitions = []
    for column in columns:
        type_name = "REAL" if column in {"predicted_sales_amount", "actual_sales_amount", "actual_sales_quantity"} else "TEXT"
        if column in {"id", "sku_code", "is_split", "predicted_quantity"}:
            type_name = "INTEGER"
        definitions.append(f'"{column}" {type_name}')
    conn.execute(f'CREATE TABLE data_service.agents_sales_forecast_detail_mi ({", ".join(definitions)})')
    placeholders = ", ".join("?" for _ in columns)
    conn.executemany(
        f'INSERT INTO data_service.agents_sales_forecast_detail_mi VALUES ({placeholders})',
        [tuple(row.values()) for row in rows],
    )

    expected_base_values = {
        "monthly_initial_predicted_sales_amount": fixture["expected"]["august_monthly_initial_split_scope"]["predicted"],
        "monthly_initial_actual_sales_amount": fixture["expected"]["august_monthly_initial_split_scope"]["actual_all_m"],
        "correction_rows_predicted_sales_amount": fixture["expected"]["august_z_rows_only"]["predicted"],
        "correction_rows_actual_sales_amount": fixture["expected"]["august_z_rows_only"]["actual"],
        "monthly_initial_predicted_quantity": fixture["expected"]["august_monthly_initial_split_scope"]["predicted_quantity"],
        "monthly_initial_actual_sales_quantity": fixture["expected"]["august_monthly_initial_split_scope"]["actual_quantity_all_m"],
        "correction_rows_predicted_quantity": fixture["expected"]["august_z_rows_only"]["predicted_quantity"],
        "correction_rows_actual_sales_quantity": fixture["expected"]["august_z_rows_only"]["actual_quantity"],
    }
    for measure in base["measures"]:
        if measure["type"] != "sum":
            continue
        expression = measure["sql"].replace("{CUBE}", "t")
        condition = measure["filters"][0]["sql"].replace("{CUBE}", "t")
        value = conn.execute(
            f'SELECT SUM({expression}) FROM data_service.agents_sales_forecast_detail_mi AS t '
            f'WHERE t.plan_month = ? AND ({condition})',
            ("202608",),
        ).fetchone()[0]
        equal(value, expected_base_values[measure["name"]], measure["name"])

    # Execute the exact SQL string in the Cube draft against a small compatible table.
    selected = [dict(row) for row in conn.execute(effective["sql"])]
    august = [row for row in selected if row["plan_month"] == "202608"]
    want = fixture["expected"]["august_correction_effective"]
    assert sorted(row["id"] for row in august) == want["selected_ids"]
    assert len({(r["plan_month"], r["dealer_code"], r["sku_code"]) for r in selected}) == len(selected)
    predicted = sum(r["predicted_sales_amount"] for r in august)
    actual = sum(r["actual_sales_amount"] for r in august)
    equal(predicted, want["predicted"], "effective predicted")
    equal(actual, want["actual"], "effective actual")
    equal(actual / predicted, want["attainment"], "effective attainment")
    equal(sum(r["predicted_quantity"] for r in august), want["predicted_quantity"], "effective predicted quantity")
    equal(sum(r["actual_sales_quantity"] for r in august), want["actual_quantity"], "effective actual quantity")

    m_all = [r for r in rows if r["plan_month"] == "202608" and r["order_type"] == "M"]
    m_rows = [r for r in m_all if r["is_split"] == 1]
    m_expected = fixture["expected"]["august_monthly_initial_split_scope"]
    equal(sum(r["predicted_sales_amount"] for r in m_rows), m_expected["predicted"], "M predicted")
    equal(sum(r["actual_sales_amount"] for r in m_all), m_expected["actual_all_m"], "M actual")
    equal(m_expected["actual_all_m"] / m_expected["predicted"], m_expected["attainment"], "M attainment")
    equal(sum(r["predicted_quantity"] for r in m_rows), m_expected["predicted_quantity"], "M predicted quantity")
    equal(sum(r["actual_sales_quantity"] for r in m_all), m_expected["actual_quantity_all_m"], "M actual quantity")
    z_rows = [r for r in rows if r["plan_month"] == "202608" and r["order_type"] == "Z"]
    z_expected = fixture["expected"]["august_z_rows_only"]
    equal(sum(r["predicted_sales_amount"] for r in z_rows), z_expected["predicted"], "Z subset predicted")
    equal(sum(r["actual_sales_amount"] for r in z_rows), z_expected["actual"], "Z subset actual")
    equal(sum(r["predicted_quantity"] for r in z_rows), z_expected["predicted_quantity"], "Z subset predicted quantity")
    equal(sum(r["actual_sales_quantity"] for r in z_rows), z_expected["actual_quantity"], "Z subset actual quantity")

    for region, region_expected in fixture["expected"]["august_correction_region"].items():
        subset = [r for r in august if (r["region_code"] or "unassigned") == region]
        region_predicted = sum(r["predicted_sales_amount"] for r in subset)
        region_actual = sum(r["actual_sales_amount"] for r in subset)
        equal(region_predicted, region_expected["predicted"], f"{region} predicted")
        equal(region_actual, region_expected["actual"], f"{region} actual")
        equal(region_predicted / predicted, region_expected["predicted_share"], f"{region} predicted share")
        equal(region_actual / actual, region_expected["actual_share"], f"{region} actual share")

    current = fixture["expected"]["september_current_month"]
    september = [r for r in selected if r["plan_month"] == "202609"]
    assert as_of.strftime("%Y%m") == "202609" and current["must_label_partial_month"] is True
    equal(sum(r["actual_sales_amount"] for r in september) / sum(r["predicted_sales_amount"] for r in september), current["attainment_to_date"], "current attainment")
    assert fixture["expected"]["zero_denominator_response"] == "无定义"
    return {
        "offline": "pass",
        "checks": ["YAML members and filters", "Q01 REST query members and filter", "base measure SQL filters and sums", "effective model SQL selection", "M actual includes unsplit rows", "M and Z amount and piece totals", "effective amount and attainment", "region shares with unassigned", "current month fixture"],
        "fixture_version": fixture["schema_version"],
        "cube_compile": "not_run",
        "cube_query": "not_run",
        "gea_replay": "not_run",
        "production_validation": "not_run",
    }


if __name__ == "__main__":
    try:
        result = run()
    except Exception as error:
        result = {"offline": "fail", "error": str(error), "cube_compile": "not_run", "cube_query": "not_run", "gea_replay": "not_run", "production_validation": "not_run"}
        REPORT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        raise
    REPORT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False))
