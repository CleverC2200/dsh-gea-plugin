/**
 * 迁移过来的业务页面：宿主扫这一屏 + 用原生输入方式改草稿。
 *
 * 这里在一个最小 DOM 上真跑一遍注入脚本（不是复述实现）：
 *   - 只声明"看得见、能动"的元素：禁用按钮不进目录，只读文本不可写；
 *   - 元素 id 用"行 + 列"对齐人能看懂的文案；
 *   - setValue 走原生 setter 并派发 input/change（等价人手敲）；
 *   - 提交/审批类按钮带上影响等级，交给宿主按契约决定放不放行。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents:
      "export * from './src/html-page-scan.ts'; export * from './src/page-bridge/catalog.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const m = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].contents).toString("base64")
);
const { PAGE_SCAN_SCRIPT, PAGE_SCAN_PROTOCOL } = m;

/** 最小 DOM：只实现脚本真正用到的那几个查询与属性。 */
function makeDom() {
  const all = [];
  const node = (tagName, props = {}, children = []) => {
    const proto =
      tagName === "input" || tagName === "textarea"
        ? inputProto
        : tagName === "select"
          ? selectProto
          : Object.prototype;
    const element = Object.assign(Object.create(proto), {
      tagName: tagName.toUpperCase(),
      attributes: { ...(props.attributes ?? {}) },
      children,
      parentElement: null,
      textContent: props.text ?? "",
      tagNameLower: tagName.toLowerCase(),
      events: [],
      getAttribute(name) {
        return name in this.attributes ? this.attributes[name] : null;
      },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      matches(selector) {
        return selector
          .split(",")
          .map((part) => part.trim())
          .some((part) => matchesSimple(this, part));
      },
      querySelectorAll(selector) {
        const found = [];
        const walk = (current) => {
          for (const child of current.children ?? []) {
            if (child.matches(selector)) found.push(child);
            walk(child);
          }
        };
        walk(this);
        return found;
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
      },
      click() {
        this.events.push("click");
      },
      dispatchEvent(event) {
        this.events.push(event.type);
        return true;
      },
    });
    Object.assign(element, props.value === undefined ? {} : { value: props.value });
    for (const child of children) child.parentElement = element;
    all.push(element);
    return element;
  };
  const matchesSimple = (element, selector) => {
    // 只实现脚本用到的那几种选择器：逗号分组、后代（按最右一段匹配）、标签与属性。
    const simple = selector.trim().split(/\s+/).at(-1);
    const tagMatch = /^[a-z]+/.exec(simple);
    if (tagMatch && element.tagName.toLowerCase() !== tagMatch[0]) return false;
    const attrMatches = simple.match(/\[([^\]=]+)(?:=([^\]]+))?\]/g) ?? [];
    return attrMatches.every((raw) => {
      const [, name, value] = /\[([^\]=]+)(?:=([^\]]+))?\]/.exec(raw);
      const actual = element.getAttribute(name);
      return value === undefined
        ? actual !== null
        : actual === value.replace(/^["']|["']$/g, "");
    });
  };

  const inputProto = {
    get value() {
      return this.__value ?? "";
    },
    set value(next) {
      this.__nativeWrites = (this.__nativeWrites ?? 0) + 1;
      this.__value = String(next);
    },
  };
  const selectProto = inputProto;
  beforeEachDom();
  function beforeEachDom() {
    all.length = 0;
  }
  return { node, all, inputProto };
}

function runScript(dom, extra = {}) {
  const document = dom.node("div", { attributes: {} });
  const posted = [];
  const listeners = [];
  const window = {
    document,
    parent: { postMessage: (message) => posted.push(message) },
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    clearTimeout: () => {},
    addEventListener: (type, handler) => listeners.push({ type, handler }),
    Event: class {
      constructor(type, options) {
        this.type = type;
        this.bubbles = options?.bubbles === true;
      }
    },
    KeyboardEvent: class {
      constructor(type, options) {
        this.type = type;
        this.key = options?.key;
      }
    },
    HTMLInputElement: { prototype: dom.inputProto },
    dispatchEvent: () => true,
    ...extra,
  };
  // document 上的查询要能看到整棵树：把根节点当作 document 用。
  globalThis.window = window;
  globalThis.document = document;
  try {
    new Function(PAGE_SCAN_SCRIPT)();
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
  return { window, document, posted, listeners };
}

/** 跑一遍注入脚本，再把这一屏挂到同一份 document 上（脚本启动后才渲染的真实顺序）。 */
function mount(dom, screen) {
  const { window, document, posted } = runScript(dom);
  for (const child of screen.root.children) {
    document.children.push(child);
    child.parentElement = document;
  }
  return { window, document, posted, scan: window.__geaPageScan };
}

/** 一屏真实形态：一个带表头的表格，行里既有输入框也有只读文本，工具栏有按钮。 */
function buildScreen(dom) {
  const { node } = dom;
  const headerRow = node("tr", {}, [
    node("th", { text: "SKU" }),
    node("th", { text: "补货量" }),
    node("th", { text: "缺货量" }),
  ]);
  const head = node("thead", {}, [headerRow]);
  const qty = node("input", { attributes: { type: "text" } });
  const cells = [
    node("td", { text: "SKU-1001" }),
    node("td", {}, [qty]),
    node("td", { text: "180" }),
  ];
  cells.forEach((cell, index) => {
    cell.cellIndex = index;
  });
  const rows = [node("tr", {}, cells)];
  const body = node("tbody", {}, rows);
  const table = node("table", {}, [head, body]);
  const toolbar = node("div", {}, [
    node("button", { text: "展开" }),
    node("button", { text: "导出本页" }),
    node("button", { text: "提交", attributes: { disabled: "" } }),
    node("button", { text: "通过" }),
  ]);
  const filter = node("select", { attributes: { "aria-label": "分仓" } }, []);
  filter.options = [
    { value: "wh-1", textContent: "郑州分仓" },
    { value: "wh-2", textContent: "武汉分仓" },
  ];
  const root = node("div", {}, [toolbar, filter, table]);
  return { root, qty, filter, toolbar };
}

test("扫描结果只含看得见能动的东西：禁用按钮不进目录，只读文本不可写", () => {
  const dom = makeDom();
  const screen = buildScreen(dom);
  const { scan } = mount(dom, screen);
  const elements = scan.scan();
  const byId = Object.fromEntries(elements.map((element) => [element.id, element]));

  // 表格里的输入框：id 用"行 + 列"，可编辑。
  const field = byId["field:sku-1001:补货量"];
  assert.ok(field, "应声明表格里的输入框：" + Object.keys(byId).join(","));
  assert.equal(field.editable, true);
  assert.equal(field.role, "field");

  // 只读文本：声明出来能读，但没有 editable。
  const readout = byId["readout:sku-1001:缺货量"];
  assert.ok(readout, "应声明只读文本");
  assert.equal(readout.value, "180");
  assert.equal(readout.editable, undefined);

  // 工具栏：能点的按钮进目录；禁用的"提交"不进目录。
  assert.ok(byId["control:展开"]);
  assert.equal(byId["control:提交"], undefined);
  // 通过 = 审批类，要用户明确要求；导出只是本页动作，不升级影响等级。
  assert.equal(byId["control:通过"].effect, "approve");
  assert.equal(byId["control:导出本页"].effect, undefined);
  assert.equal(byId["control:展开"].effect, undefined);

  // 下拉：可编辑 + 带选项（标签(值) 形态，模型能对上人话）。
  const select = byId["control:分仓"];
  assert.deepEqual(select.options, ["郑州分仓(wh-1)", "武汉分仓(wh-2)"]);
  assert.equal(select.editable, true);
});

test("setValue 走原生 setter 并派发 input/change，提交类按钮能点到", () => {
  const dom = makeDom();
  const screen = buildScreen(dom);
  const { scan, posted } = mount(dom, screen);
  scan.report("test");
  assert.deepEqual(
    posted.filter((message) => message.type === "catalog").at(-1).elements.length > 0,
    true,
  );

  const result = scan.apply({
    kind: "setValue",
    target: "field:sku-1001:补货量",
    value: "200",
  });
  assert.deepEqual(result, { applied: true });
  assert.equal(screen.qty.value, "200");
  assert.equal(screen.qty.__nativeWrites, 1, "必须走原生 setter，等价人手敲");
  assert.deepEqual(screen.qty.events, ["input", "change"]);

  const selectResult = scan.apply({
    kind: "setValue",
    target: "control:分仓",
    value: "武汉分仓(wh-2)",
  });
  assert.deepEqual(selectResult, { applied: true });
  assert.equal(screen.filter.value, "wh-2", "按标签找到对应选项值");

  const clicked = scan.apply({ kind: "invoke", target: "control:通过", action: "invoke" });
  assert.deepEqual(clicked, { applied: true });
  assert.deepEqual(screen.toolbar.children[3].events, ["click"]);
});

test("元素不在了就明确失败，不假装改成功", () => {
  const dom = makeDom();
  const screen = buildScreen(dom);
  const { scan } = mount(dom, screen);
  scan.scan();
  assert.deepEqual(scan.apply({ kind: "setValue", target: "field:不存在", value: "1" }), {
    applied: false,
    error: "ELEMENT_GONE",
  });
  assert.equal(scan.apply({ kind: "invoke" }).error, "MISSING_TARGET");
  assert.equal(scan.classify("退回") , "approve");
  assert.equal(scan.classify("保存草稿"), "submit");
  assert.equal(scan.classify("翻页"), undefined);
});

test("扫出来的目录必须能通过宿主校验，宿主自己写死页面标识与工具名", () => {
  const dom = makeDom();
  const screen = buildScreen(dom);
  const { scan } = mount(dom, screen);
  const elements = scan.scan();

  const catalog = m.pageCatalogFromScan({
    pluginId: "inventory-fc",
    label: "分仓库存",
    elements,
  });
  assert.equal(catalog.surface, "gea-html-inventory-fc");
  assert.equal(catalog.tool, "gea_plugin_page_apply");
  // 页面自己不能决定页面标识/工具名/说明：它只能报元素。
  const validated = m.validatePageCatalog(catalog);
  assert.equal(validated.surface, "gea-html-inventory-fc");
  assert.ok(validated.elements.length >= 4);
  const compiled = m.compilePageCatalog(validated);
  assert.match(compiled.description, /分仓库存/);
  assert.match(compiled.description, /只读元素/);

  // 没有元素（页面还没渲染/被清空）时不给目录，宿主据此注销工具。
  assert.equal(
    m.pageCatalogFromScan({ pluginId: "inventory-fc", label: "分仓库存", elements: [] }),
    null,
  );
  // 注入脚本要落到页面 HTML 里，页面自己不用改。
  assert.match(
    m.injectPageScan("<html><body><div id=app></div></body></html>"),
    /<script>[\s\S]*gea-html-v2[\s\S]*<\/script><\/body>/,
  );
});
