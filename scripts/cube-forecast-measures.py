#!/usr/bin/env python3
"""2026-09-24 已核实粒度的三张预测输入表补量。默认只生成，--apply 才写配置。

执行前必须重新核对业务键唯一性；另外四张有重复/冲突，故不在本脚本中补 sum。
保留 total_* 兼容名称；新名称采用 *_sum / *_avg / *_count。
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import yaml


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def measure(name, column, kind, description, record_type=None):
    result = dict(name=name, type=kind, public=True, sql='{CUBE}."' + column + '"', description=description)
    if record_type:
        result['filters'] = [dict(sql='{CUBE}."record_type" = \'' + record_type + '\'')]
    result['meta'] = dict(semantic_status='observed', semantic_version='forecast-closure-20260924', evidence=['2026-09-24 live business-grain audit'])
    return result


def transform(name, source):
    data = yaml.safe_load(source)
    cube = data['cubes'][0]
    if cube['name'] != name or cube['data_source'] != 'gea_agent':
        raise ValueError('Unexpected model or data source: ' + name)
    fields = {d['name'] for d in cube['dimensions']}
    existing = cube.setdefault('measures', [])
    if name == 'agents_sales_target':
        additions = [measure('target_amount_sum', 'target_amount', 'sum', '客户计划月目标金额合计；与 total_target_amount 同义，旧名保留兼容。不得连接 SKU 明细后重复相加。'),
                     measure('dealer_count', 'dealer_code', 'countDistinct', '筛选范围内有目标的经销商去重数；不是记录行数。')]
    elif name == 'agents_sales_shipment':
        additions = [measure('shipment_quantity_sum', 'shipment_quantity', 'sum', '实际发货数量合计；与 total_shipment_quantity 同义，旧名保留兼容。使用 biz_date 发货日，数量沿用源单位。'),
                     measure('dealer_count', 'dealer_code', 'countDistinct', '筛选范围内发货经销商去重数。'),
                     measure('sku_count', 'sku_code', 'countDistinct', '筛选范围内发货 SKU 去重数。')]
    elif name == 'stg_sales_forecast_input':
        cube['description'] = '多类型销售预测输入；业务键 record_type + biz_date + dealer_code + sku_code 已核实唯一。SHIPMENT、TARGET、PRICE 的度量内置类型过滤，不混算 SCOPE 或 MATERIAL。目标金额按计划月×客户唯一，不与 SKU 范围连接后重复累计。价格均值仅为行均价，不是加权成交价。'
        for dim in cube['dimensions']:
            if dim['name'] in ('record_type', 'biz_date', 'dealer_code', 'sku_code'):
                dim['primary_key'] = True
            if dim['name'] == 'record_type':
                dim['description'] += ' 现网另有 MATERIAL 原始类型；本次不对 MATERIAL 定义金额或数量度量。'
        if not existing:
            existing.append(dict(name='row_count', type='count', public=True, description='物理记录数；不是客户数或业务数量。'))
        additions = [measure('shipment_quantity_sum', 'shipment_quantity', 'sum', '仅 SHIPMENT 发货类型的数量合计；按 biz_date 发货日筛选，保留源单位。', 'SHIPMENT'),
                     measure('target_amount_sum', 'target_amount', 'sum', '仅 TARGET 目标类型的金额合计；按 plan_month 筛选，不按商品范围展开。', 'TARGET'),
                     measure('untaxed_landed_price_avg', 'untaxed_landed_price', 'avg', '仅 PRICE 类型的未税到岸行均价；不是加权价格，不对价格求和。', 'PRICE')]
    else:
        raise ValueError('Unsupported model')
    for item in additions:
        if item['sql'].split('"')[1] not in fields:
            raise ValueError('Missing source column: ' + item['name'])
        prior = next((m for m in existing if m['name'] == item['name']), None)
        if prior is not None and prior != item:
            raise ValueError('Conflicting existing measure: ' + item['name'])
        if prior is None:
            existing.append(item)
    try:
        return yaml.safe_dump(data, allow_unicode=True, sort_keys=False)
    except TypeError as error:
        if 'sort_keys' not in str(error):
            raise
        return yaml.safe_dump(data, allow_unicode=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', required=True, type=Path, help='JSON object containing the three original YAML documents')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--config-root', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    originals = json.loads(args.snapshot.read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    generated = {name: transform(name, source) for name, source in originals.items()}
    for name, text in generated.items():
        (args.output / (name + '.yml')).write_text(text)
    if args.apply:
        if not args.config_root or not args.config_root.is_dir():
            raise ValueError('--config-root must be an existing directory')
        expected = {name: None if name == 'stg_sales_forecast_input' else hashlib.sha256(originals[name].encode()).hexdigest() for name in generated}
        for name, sha in expected.items():
            if digest(args.config_root / (name + '.yml')) != sha:
                raise ValueError('Configuration changed since audit: ' + name)
        backup = Path(tempfile.mkdtemp(prefix='forecast-closure-20260924-', dir=args.output))
        for name, sha in expected.items():
            if sha:
                shutil.copy2(args.config_root / (name + '.yml'), backup / (name + '.yml'))
        (backup / 'manifest.json').write_text(json.dumps(expected, indent=2))
        touched = []
        try:
            for name, text in generated.items():
                target = args.config_root / (name + '.yml')
                temporary = target.with_suffix('.yml.pending')
                temporary.write_text(text)
                temporary.replace(target)
                touched.append(name)
        except Exception:
            for name in touched:
                target = args.config_root / (name + '.yml')
                if expected[name]:
                    shutil.copy2(backup / (name + '.yml'), target)
                else:
                    target.unlink()
            raise
        print('backup:', backup)
    for name, text in generated.items():
        print(name, 'measures=', len(yaml.safe_load(text)['cubes'][0]['measures']), 'sha256=', hashlib.sha256(text.encode()).hexdigest())


if __name__ == '__main__':
    main()
