import { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const require = createRequire(import.meta.url);
const bundle = build({
  alias: {
    react: dirname(require.resolve("react/package.json")),
    "react-dom": dirname(require.resolve("react-dom/package.json")),
  },
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "tsx",
    contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import '@arco-design/web-react/dist/css/arco.css';
import '../../../dsh-agent-workbench/src/workbench/workbench.css';
import zh from '../../../dsh-agent-workbench/src/workbench/original/zh-CN.json';
import Workbench from '../../../dsh-agent-workbench/src/workbench/original/workbenches/regionalApproval/RegionalApprovalWorkbench.tsx';
import { WorkbenchHostProvider } from '../../../dsh-agent-workbench/src/workbench/original/bridge.ts';
const i18n = i18next.createInstance();
await i18n.init({lng:'zh-CN',resources:{'zh-CN':{translation:{common:zh}}},interpolation:{escapeValue:false}});
const plans = window.fixturePlans;
const versionSkus = versionId => window.fixtureVersionSkus[versionId] ?? [sku(versionId)];
const sku = versionId => ({id:'s'+versionId,skuCode:'9001',versionId,productCategName:'汤圆',materialDescription:'黑芝麻汤圆 500g',qty:'10',baseQty:'10',amt:plans.find(p=>p.versionId===versionId).currentAmount,amtBase:'10',price:'1'});
const forbidden = async () => { throw Error('PRESENTATION_WRITE_FORBIDDEN'); };
const client = {
  periods:{invoke:async()=>({records:[{periodId:'period-1',periodMonth:'2026-09',planTypeCode:'Y',status:'OPEN'}],total:1,size:100,current:1,pages:1})},
  list:{invoke:async(q)=>{const records=q?.status===undefined||q.status===1?plans:[];return {records,total:records.length,size:200,current:1,pages:1}}},
  detail:{invoke:async({planId})=>{const plan=plans.find(p=>p.planId===planId);return {currentVersion:{...plan,id:plan.versionId,effective:true},skus:[sku(plan.versionId)],versions:[],logs:[]}}},
  versions:{invoke:async({planId})=>plans.filter(p=>p.planId===planId).map(p=>({...p,id:p.versionId,effective:true}))},
  versionSkus:{invoke:async({versionId})=>versionSkus(versionId)},
  draft:{invoke:async()=>({draft:null})},logs:{invoke:async()=>[]},
  action:{invoke:forbidden},submit:{invoke:forbidden}
};
createRoot(document.getElementById('root')).render(<WorkbenchHostProvider value={{salesPlan:client}}><div className="gea-original-workbench"><Workbench stateScope="presentation" t={i18n.t.bind(i18n)} onContextChange={()=>{}} approvalStages={['region']} liveActionsEnabled/></div></WorkbenchHostProvider>);
`,
  },
  outfile: "/fixture/app.js",
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  define: { "process.env.NODE_ENV": '"test"' },
  loader: { ".svg": "dataurl", ".png": "dataurl" },
});
let browser;
after(async () => {
  await browser?.close();
});

export async function openSalesPlanPresentation(t, rows, { versionSkus = {} } = {}) {
  t.signal.throwIfAborted();
  let context;
  const assets = new Map(
    (await bundle).outputFiles.map((file) => [file.path.split("/").at(-1), file.contents]),
  );
  const server = createServer((request, response) => {
    const name = request.url.slice(1);
    response.setHeader(
      "content-type",
      name.endsWith(".css")
        ? "text/css"
        : assets.has(name)
          ? "text/javascript"
          : "text/html; charset=utf-8",
    );
    response.end(
      assets.get(name) ??
        '<meta charset="utf-8"><link rel="stylesheet" href="/app.css"><style>html,body,#root{height:100%;margin:0}</style><div id="root" class="gea-workbench-document"></div><script type="module" src="/app.js"></script>',
    );
  });
  t.after(async () => {
    await context?.close();
    await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  if (!browser?.isConnected())
    browser = await chromium.launch({
      channel: process.env.GEA_TEST_CHROMIUM ? undefined : "chrome",
      executablePath: process.env.GEA_TEST_CHROMIUM,
      headless: true,
    });
  context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1536, height: 920 } });
  await context.addInitScript((skus) => {
    window.fixtureVersionSkus = skus;
  }, versionSkus);
  const abort = () => {
    void context.close().catch(() => {});
  };
  t.signal.addEventListener("abort", abort, { once: true });
  t.after(() => t.signal.removeEventListener("abort", abort));
  await context.addInitScript(
    (plans) => {
      window.fixturePlans = plans;
    },
    rows.map((row, index) => ({
      planId: "plan-" + index,
      versionId: "version-" + index,
      seq: 1,
      periodId: "period-1",
      planTypeCode: "Y",
      orderType: "M",
      dealerCode: "customer-" + index,
      dealerName: "客户" + index,
      orgCode: "org-" + index,
      orgName: "销售组" + index,
      provinceCode: "province-" + index,
      provinceName: "省区" + index,
      areaCode: "area-" + index,
      areaName: "大区" + index,
      status: 1,
      skuCount: 1,
      ...row,
    })),
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const origin = "http://127.0.0.1:" + server.address().port;
  await context.route("**/*", (route) =>
    route
      .request()
      .url()
      .startsWith(origin + "/")
      ? route.continue()
      : route.abort(),
  );
  await page.goto(origin);
  await expect(page.getByTestId("regional-approval-workbench")).toBeVisible();
  return page;
}
