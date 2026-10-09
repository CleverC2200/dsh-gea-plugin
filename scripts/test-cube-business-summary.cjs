/* Run inside the existing Cube container. Uses its compiler and PostgreSQL driver.
 * Only read-only SQL and in-memory VALUES fixtures; no schema/table changes.
 * Usage: node test-cube-business-summary.cjs CANDIDATE_DIRECTORY
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { compile, PostgresQuery } = require('@cubejs-backend/schema-compiler');
const { Client } = require('pg');
const root = '/cube/conf/model';
const stage = process.argv[2];
const names = ['agents_sales_plan_detail_mi', 'agents_scm_inventory_age', 'agents_scm_cust_inventory_daily'];
const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(yml|yaml|js)$/.test(p)) {
      const alternative = path.join(stage, e.name);
      files.push({ fileName: path.relative(root, p), content: fs.readFileSync(fs.existsSync(alternative) ? alternative : p, 'utf8') });
    }
  }
}
const p = 'CUBEJS_DS_GEA_AGENT_DB_';
const db = new Client({ host: process.env[p + 'HOST'], port: process.env[p + 'PORT'], database: process.env[p + 'NAME'],
  user: process.env[p + 'USER'], password: process.env[p + 'PASS'], connectionTimeoutMillis: 5000 });
const report = { compiler: 'installed Cube 1.7.2', tests: [] };
async function read(sql, params = []) {
  await db.query('BEGIN READ ONLY');
  try {
    await db.query("SET LOCAL statement_timeout='15s'");
    return (await db.query(sql, params)).rows;
  } finally { await db.query('ROLLBACK'); }
}
function pass(name, evidence = {}) { report.tests.push({ name, pass: true, ...evidence }); }
async function main() {
  walk(root);
  const c = await compile({ dataSchemaFiles: async () => files, localPath: () => root }, { allowNodeRequire: false });
  pass('all-models-compile', { files: files.length });
  await db.connect();
  const sqlFor = (model, members, filters = []) => new PostgresQuery(c, {
    measures: members.map(m => model + '.' + m), filters, timezone: 'Asia/Shanghai',
  }).buildSqlAndParams();
  const run = async (i, members, filters) => read(...sqlFor(names[i], members, filters));
  const value = (row, i, name) => row[names[i] + '__' + name];
  // Read latest periods from source, rather than inventing a current-month fallback.
  for (const [i, date, sums] of [[0, 'plane_date', ['plannum', 'allnum']], [1, 'snapshot_date', ['qtylive']]]) {
    const table = 'data_service.' + names[i];
    const direct = (await read(`SELECT max(${date})::text AS period FROM ${table}`))[0];
    const raw = (await read(`SELECT ${sums.map(s => `sum(${s})::text AS ${s}`).join(',')} FROM ${table} WHERE ${date}::text = $1`, [direct.period]))[0];
    const members = i === 0 ? ['plannum_sum', 'allnum_sum', 'row_count', 'customer_count', 'candidate_grain_count', 'missing_province_count'] : ['available_qty_sum', 'row_count', 'warehouse_count'];
    const filters = [{ member: names[i] + '.' + date, operator: i === 0 ? 'equals' : 'inDateRange', values: i === 0 ? [direct.period] : [direct.period, direct.period] }];
    const got = (await run(i, members, filters))[0];
    sums.forEach((s, j) => assert.equal(value(got, i, members[j]), raw[s]));
    assert.notEqual(value(got, i, members[0]), null);
    pass('live-' + names[i] + '-matches-source', { period: direct.period, rows: value(got, i, 'row_count') });
    if (i === 0) {
      const q = new PostgresQuery(c, { measures: ['plannum_sum', 'allnum_sum'].map(m => names[0] + '.' + m),
        dimensions: [names[0] + '.province_region_name'], filters, timezone: 'Asia/Shanghai' });
      const grouped = await read(...q.buildSqlAndParams());
      const source = await read(`SELECT province_region_name, sum(plannum)::text AS plannum, sum(allnum)::text AS allnum
        FROM ${table} WHERE plane_date = $1 GROUP BY province_region_name`, [direct.period]);
      const normalized = grouped.map(r => [value(r, 0, 'province_region_name'), value(r, 0, 'plannum_sum'), value(r, 0, 'allnum_sum')]);
      assert.deepEqual(normalized.sort(), source.map(r => [r.province_region_name, r.plannum, r.allnum]).sort());
      pass('live-plan-province-groups-match-source', { groups: source.length });
      const missing = (await read(`SELECT count(*) AS n FROM ${table} WHERE plane_date = $1 AND nullif(btrim(province_region_name),'') IS NULL`, [direct.period]))[0].n;
      assert.equal(value(got, 0, 'missing_province_count'), missing);
      pass('live-plan-missing-province-matches-source', { missing });
    }
  }
  const dealerDate = (await read('SELECT max(stat_date)::text AS period FROM data_service.' + names[2]))[0].period;
  const dealerMembers = ['customer_count', 'inventory_snapshot_date_count', 'missing_stock_qty_count', 'missing_in_transit_qty_count', 'missing_stock_amt_count', 'missing_snapshot_count'];
  const got = (await run(2, dealerMembers, [{ member: names[2] + '.stat_date', operator: 'inDateRange', values: [dealerDate, dealerDate] }]))[0];
  const raw = (await read(`SELECT count(distinct cust_code) customer_count, count(distinct inventory_snapshot_date) inventory_snapshot_date_count,
    count(*) filter(where stock_qty is null) missing_stock_qty_count, count(*) filter(where in_transit_qty is null) missing_in_transit_qty_count,
    count(*) filter(where stock_amt is null) missing_stock_amt_count, count(*) filter(where inventory_snapshot_date is null) missing_snapshot_count
    FROM data_service.${names[2]} WHERE stat_date::text = $1`, [dealerDate]))[0];
  dealerMembers.forEach(m => assert.equal(value(got, 2, m), raw[m]));
  pass('live-dealer-quality-matches-source', { period: dealerDate, quality: raw });
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
  for (const entry of manifest) {
    const model = path.basename(entry.fileName, '.yml');
    const [sql] = sqlFor(model, entry.addedMeasures);
    // PostgreSQL identifiers are limited to 63 bytes, including the Cube prefix.
    entry.addedMeasures.forEach(m => assert.ok(Buffer.byteLength(model + '__' + m) <= 63, m));
    assert.ok(sql.length > 0);
  }
  pass('all-29-added-members-generate-sql-and-fit-postgres-identifiers');
  const empty = (await run(0, ['plannum_sum', 'allnum_sum', 'row_count'], [{ member: names[0] + '.plane_date', operator: 'equals', values: ['1900-01'] }]))[0];
  assert.equal(value(empty, 0, 'plannum_sum'), null);
  assert.equal(value(empty, 0, 'row_count'), '0');
  pass('empty-plan-is-null-not-zero');
  // Execute compiler-produced SQL against typed JSON fixtures in a CTE.
  async function fixture(i, name, rows, expected) {
    const members = i === 0 ? ['plannum_sum', 'allnum_sum'] : ['available_qty_sum'];
    const [sql, params] = sqlFor(names[i], members);
    assert.equal(params.length, 0);
    const fields = i === 0 ? 'cust_code text, material_code text, belong_base text, repertory_org text, plane_date text, load_time timestamp, plannum numeric, allnum numeric'
      : 'snapshot_date date, snapshot_time timestamptz, qtylive numeric';
    const from = `"data_service"."${names[i]}"`;
    assert.ok(sql.includes(from));
    const rowsOut = await read(`WITH fixture AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(${fields})) ` + sql.replace(from, 'fixture'), [JSON.stringify(rows)]);
    members.forEach((m, j) => assert.equal(value(rowsOut[0], i, m) === null ? null : Number(value(rowsOut[0], i, m)), expected[j], name + ':' + m));
    pass(name);
  }
  const a = { cust_code: 'c1', material_code: 's1', belong_base: 'b1', repertory_org: 'w1', plane_date: '2026-08', load_time: '2026-07-23 09:00:00', plannum: 10, allnum: 12 };
  const b = { ...a, material_code: 's2', plannum: 5, allnum: 8 };
  await fixture(0, 'plan-single-scope', [a, b], [15, 20]);
  await fixture(0, 'plan-cross-month', [a, { ...b, plane_date: '2026-09' }], [null, null]);
  await fixture(0, 'plan-cross-batch', [a, { ...b, load_time: '2026-07-24 09:00:00' }], [null, null]);
  await fixture(0, 'plan-missing-month', [a, { ...b, plane_date: null }], [null, null]);
  await fixture(0, 'plan-missing-batch', [a, { ...b, load_time: null }], [null, null]);
  await fixture(0, 'plan-missing-initial-keeps-final', [a, { ...b, plannum: null }], [null, 20]);
  await fixture(0, 'plan-missing-final-keeps-initial', [a, { ...b, allnum: null }], [15, null]);
  await fixture(0, 'plan-duplicate-candidate-grain', [a, a], [null, null]);
  await fixture(0, 'plan-confirmed-zero-kept', [{ ...a, plannum: 0, allnum: 0 }], [0, 0]);
  const stock = { snapshot_date: '2026-09-27', snapshot_time: '2026-09-27T09:00:00+08:00', qtylive: 10 };
  await fixture(1, 'base-single-snapshot', [stock, { ...stock, qtylive: 5 }], [15]);
  await fixture(1, 'base-cross-date', [stock, { ...stock, snapshot_date: '2026-09-26' }], [null]);
  await fixture(1, 'base-cross-time', [stock, { ...stock, snapshot_time: '2026-09-27T10:00:00+08:00' }], [null]);
  await fixture(1, 'base-missing-quantity', [stock, { ...stock, qtylive: null }], [null]);
  await fixture(1, 'base-missing-snapshot', [stock, { ...stock, snapshot_time: null }], [null]);
  await fixture(1, 'base-confirmed-zero-kept', [{ ...stock, qtylive: 0 }], [0]);
  await fixture(1, 'base-empty-is-null', [], [null]);
}
main().then(() => { console.log(JSON.stringify(report, null, 2)); process.exitCode = 0; })
  .catch(e => { console.error(JSON.stringify({ ...report, error: e.message })); process.exitCode = 1; })
  .finally(async () => { await db.end(); process.exit(process.exitCode); });
