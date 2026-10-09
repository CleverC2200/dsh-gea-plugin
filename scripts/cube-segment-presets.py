#!/usr/bin/env python3
"""从 Cube Playground 的只读 files 快照生成三张模型的预设筛选候选文件。

只生成文件，不连接或修改服务器。保留原 YAML 排版，并记录原始 SHA，供远端写入前核对。
"""

import argparse
import hashlib
import json
from pathlib import Path

import yaml


SEGMENTS = {
    "agents_scm_safety_stock": (
        ("month_start_version", "inventory_version", "月初", "仅月初库存版本；还须指定目标月及库存快照，不能把不同快照相加。"),
        ("rolling_version", "inventory_version", "滚动", "仅滚动库存版本；还须指定目标月及库存快照，不能把不同快照相加。"),
        ("correction_version", "inventory_version", "纠偏", "仅纠偏库存版本；还须指定目标月及库存快照，不能把不同快照相加。"),
    ),
    "agents_scm_branch_plan": (
        ("month_start_version", "plan_version", "MONTH_START", "仅月初计划版本；还须指定目标月和计划快照，BI/MANUAL 来源覆盖规则未由此分段处理。"),
        ("rolling_version", "plan_version", "ROLLING", "仅滚动计划版本；还须指定目标月和计划快照，BI/MANUAL 来源覆盖规则未由此分段处理。"),
    ),
    "agents_sales_forecast_detail_mi": (
        ("month_start_m", "order_type", "M", "仅 M 月初预测；还须指定计划月，不能与 Z 纠偏结果相加。"),
        ("correction_z", "order_type", "Z", "仅 Z 月中纠偏；还须指定计划月，不能与 M 月初结果相加。"),
    ),
}


def sha256(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def transform(name: str, content: str) -> str:
    parsed = yaml.safe_load(content)
    cubes = parsed.get("cubes") if isinstance(parsed, dict) else None
    if not isinstance(cubes, list) or len(cubes) != 1:
        raise ValueError(f"{name}: expected exactly one cube")
    cube = cubes[0]
    if cube.get("name") != name or cube.get("data_source") != "gea_agent" or cube.get("public") is not True:
        raise ValueError(f"{name}: unexpected model, source, or visibility")
    if "segments" in cube:
        raise ValueError(f"{name}: segments already exist; inspect before changing")
    dimensions = {item["name"]: item for item in cube["dimensions"]}
    lines = ["    segments:"]
    for segment_name, column, value, description in SEGMENTS[name]:
        if dimensions.get(column, {}).get("type") != "string":
            raise ValueError(f"{name}: expected string dimension {column}")
        sql = '{CUBE}."' + column + '" = \'' + value + '\''
        lines.extend(
            (
                f"      - name: {json.dumps(segment_name)}",
                f"        sql: {json.dumps(sql, ensure_ascii=False)}",
                "        public: true",
                f"        description: {json.dumps(description, ensure_ascii=False)}",
            )
        )
    anchor = "\n    dimensions:\n"
    if content.count(anchor) != 1:
        raise ValueError(f"{name}: expected one top-level dimensions block")
    candidate = content.replace(anchor, "\n" + "\n".join(lines) + "\n    dimensions:\n", 1)
    new_cube = yaml.safe_load(candidate)["cubes"][0]
    if len(new_cube["segments"]) != len(SEGMENTS[name]):
        raise ValueError(f"{name}: segment count changed after YAML parse")
    if {key: value for key, value in cube.items() if key != "segments"} != {
        key: value for key, value in new_cube.items() if key != "segments"
    }:
        raise ValueError(f"{name}: a preexisting model field changed")
    return candidate


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True, type=Path, help="GET /playground/files response JSON")
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    files = json.loads(args.snapshot.read_text(encoding="utf-8"))["files"]
    indexed = {item["fileName"]: item["content"] for item in files}
    original_dir = args.output_dir / "original"
    candidate_dir = args.output_dir / "candidate"
    original_dir.mkdir(parents=True, exist_ok=True)
    candidate_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    for name in SEGMENTS:
        filename = f"{name}.yml"
        key = f"cubes/{filename}"
        original = indexed[key]
        candidate = transform(name, original)
        (original_dir / filename).write_text(original, encoding="utf-8")
        (candidate_dir / filename).write_text(candidate, encoding="utf-8")
        manifest.append(
            {
                "model": name,
                "server_path": f"/opt/cube-core/conf/model/cubes/{filename}",
                "original_sha256": sha256(original),
                "candidate_sha256": sha256(candidate),
                "segments": [item[0] for item in SEGMENTS[name]],
            }
        )
    (args.output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    for item in manifest:
        print(item["model"], "segments=" + ",".join(item["segments"]), "sha256=" + item["candidate_sha256"])


if __name__ == "__main__":
    main()
