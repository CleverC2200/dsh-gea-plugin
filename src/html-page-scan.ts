/**
 * 迁移页面的通用适配器：宿主把这段脚本注入到"同源框架里的业务页面"中，页面本身不用改。
 *
 * 它只做两件与业务无关的事：
 *   1) 读取当前这一屏真实渲染出来的东西 —— 可编辑控件、可点按钮、表格行列的文本；
 *   2) 接收宿主下发的通用动词（setValue / invoke / select / clear），按浏览器原生的
 *      输入方式落到页面上（等价人手敲、人手点），再把结果回填。
 *
 * 边界：只声明"看得见、人能操作"的元素；只读文本只声明不可写；提交/审批类按钮带上
 * 影响等级，最终是否下发由宿主按能力契约决定（页面的 disabled 状态在这里已经过滤掉）。
 *
 * 脚本是自包含的：不依赖打包器的模块系统，只用 window/document/MutationObserver，
 * 因此测试可以把它当成一段普通脚本来跑。
 */

/** 页面与宿主之间的第二代协议：页面报元素、宿主下改单。 */
export const PAGE_SCAN_PROTOCOL = "gea-html-v2";

/** 把扫描脚本注入到要发给浏览器的业务页面里（页面本身不用改）。 */
export function injectPageScan(html: string): string {
  const tag = `<script>${PAGE_SCAN_SCRIPT}</script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${tag}</body>`);
  return html + tag;
}

export type ScannedPageCatalogInput = {
  pluginId: string;
  label: string;
  elements: unknown;
};

/**
 * 把"页面扫出来的元素"包成宿主认可的页面目录。
 *
 * 页面只能报元素，页面标识、工具名与说明由宿主自己写死：这样页面无法冒充别的页面，
 * 也没有机会把说明文字改成自己想说的话。元素本身仍按不可信数据校验（validatePageCatalog）。
 */
export function pageCatalogFromScan(
  input: ScannedPageCatalogInput,
): { surface: string; tool: string; description: string; reasonField: string; elements: unknown[] } | null {
  if (!Array.isArray(input.elements) || input.elements.length === 0) return null;
  return {
    surface: `gea-html-${input.pluginId}`,
    tool: "gea_plugin_page_apply",
    reasonField: "reason",
    description:
      `操作「${input.label}」这一屏（宿主按页面实际渲染出来的内容生成）。` +
      "invoke 只能点元素列出的可执行动作；setValue 只能写「可编辑」的字段；select 选中元素；clear 关浮层。" +
      "只读元素只能读不能改；后台状态、接口和凭据都不在清单里。" +
      "标了「点开是对话框」「点开有选项」的控件要先 invoke 打开，里面的元素会在下一轮读取里出现，" +
      "再按新出现的 id 操作；不要凭空猜选项 id，也不要以为点开就等于选好了。" +
      "标了「提交类」「审批类」的元素只有用户这一轮明确要求时才能调用，并且必须带 confirm=true。",
    elements: input.elements,
  };
}

export const PAGE_SCAN_SCRIPT = String.raw`(function () {
  "use strict";
  var W = typeof window !== "undefined" ? window : null;
  if (!W || !W.document) return;
  var D = W.document;
  var PROTOCOL = "gea-html-v2";
  var MAX_ELEMENTS = 300;
  var MAX_TEXT = 200;
  var MAX_LABEL = 200;
  var MAX_OPTIONS = 24;
  var CONTROL_SELECTOR =
    "input, textarea, select, button, [role=button], [role=option], [role=menuitem]," +
    "[role=tab], [role=switch], [role=radio], [role=checkbox], [contenteditable]";

  function trim(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  function bounded(value, max) {
    var text = trim(value);
    if (!text) return undefined;
    return text.length > max ? text.slice(0, max) : text;
  }

  function slug(value, fallback) {
    var text = trim(value)
      .toLowerCase()
      .replace(/[^0-9a-z\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!text) return fallback;
    return text.slice(0, 24);
  }

  function attr(node, name) {
    if (!node || typeof node.getAttribute !== "function") return null;
    return node.getAttribute(name);
  }

  function typeOf(node) {
    return trim(attr(node, "type")).toLowerCase() || "text";
  }

  function disabled(node) {
    if (node.disabled === true) return true;
    if (attr(node, "disabled") !== null) return true;
    if (attr(node, "aria-disabled") === "true") return true;
    void node;
    return false;
  }

  /** 明确被排除的节点（隐藏字段、标记忽略、aria-hidden）。 */
  function ignored(node) {
    if (!node) return true;
    if (attr(node, "data-gea-ignore") !== null) return true;
    if (attr(node, "aria-hidden") === "true") return true;
    var tag = trim(node.tagName).toLowerCase();
    if (tag === "input" && typeOf(node) === "hidden") return true;
    return false;
  }

  function textOf(node) {
    if (!node) return "";
    if (typeof node.value === "string" && node.value) return trim(node.value);
    var text = trim(node.textContent);
    if (text) return text;
    if (node.children) {
      for (var index = 0; index < node.children.length; index++) {
        var nested = trim(node.children[index].textContent);
        if (nested) return nested;
      }
    }
    return "";
  }

  function placeholderOf(node) {
    return (
      trim(attr(node, "aria-label")) ||
      trim(attr(node, "placeholder")) ||
      trim(attr(node, "title")) ||
      trim(attr(node, "name")) ||
      trim(attr(node, "data-label"))
    );
  }

  function closest(node, selector) {
    var current = node;
    while (current) {
      if (typeof current.matches === "function" && current.matches(selector))
        return current;
      current = current.parentElement || null;
    }
    return null;
  }

  /** 表头：优先找同一列的表头文本，找不到再用字段名兜底。 */
  function headerOf(node) {
    var cell = closest(node, "td, th");
    if (cell && typeof cell.cellIndex === "number") {
      var table = closest(node, "table");
      var headers = table ? table.querySelectorAll("thead th") : [];
      var header = headers[cell.cellIndex];
      var text = header ? trim(header.textContent) : "";
      if (text) return text;
    }
    return "";
  }

  function labelOf(node) {
    var labelled = trim(attr(node, "data-gea-label"));
    if (labelled) return labelled;
    var tag = trim(node.tagName).toLowerCase();
    // 按钮/选项类元素自己的文字就是它的名字（"展开""通过""10天"）。
    if (clickable(node)) {
      var own = bounded(textOf(node), MAX_LABEL);
      if (own) return own;
    }
    var id = trim(attr(node, "id"));
    if (id && D.querySelector) {
      var escaped = String(id).replace(/"/g, '\\"');
      var found = D.querySelector('label[for="' + escaped + '"]');
      if (found && trim(found.textContent)) return trim(found.textContent);
    }
    var wrapper = closest(node, "label");
    if (wrapper && trim(wrapper.textContent)) return trim(wrapper.textContent);
    var header = headerOf(node);
    if (header) return header;
    return placeholderOf(node);
  }

  /** 能点的东西：原生按钮，或带交互 role 的元素（弹层里的选项往往是 div）。 */
  function clickable(node) {
    var tag = trim(node.tagName).toLowerCase();
    if (tag === "button") return true;
    var role = trim(attr(node, "role"));
    return (
      role === "button" ||
      role === "option" ||
      role === "menuitem" ||
      role === "tab" ||
      role === "switch" ||
      role === "radio" ||
      role === "checkbox"
    );
  }

  /** 影响等级：提交/审批类按钮必须让宿主知道，用户没明说就不能点。 */
  function classify(text) {
    if (/通过|退回|审批|核准|批准/.test(text)) return "approve";
    if (/提交|保存|下发|发布|删除|停用|启用|确认/.test(text)) return "submit";
    return undefined;
  }

  /**
   * 弹层提示：下拉/对话框类的控件，它的选项要点开之后才渲染出来。
   * 不写清楚的话，模型只会看到一个"当前值"的按钮，改不了里面的选项。
   */
  function hintOf(node) {
    var hints = [];
    var popup = trim(attr(node, "aria-haspopup"));
    if (popup && popup !== "false")
      hints.push(popup === "dialog" ? "点开是对话框" : "点开有选项");
    var expanded = trim(attr(node, "aria-expanded"));
    if (expanded === "true") hints.push("当前展开");
    else if (expanded === "false") hints.push("当前收起");
    return hints;
  }

  function optionsOf(node) {
    var options = node.options || [];
    var listed = [];
    for (var index = 0; index < options.length && listed.length < MAX_OPTIONS; index++) {
      var option = options[index];
      var value = trim(option.value) || trim(option.textContent);
      var label = trim(option.textContent) || value;
      if (!value) continue;
      listed.push(label && label !== value ? label + "(" + value + ")" : value);
    }
    return { listed: listed, total: options.length };
  }

  function rowKeyOf(row) {
    var cells = row.children || [];
    for (var index = 0; index < cells.length; index++) {
      var text = trim(cells[index].textContent);
      if (text) return slug(text, "r" + index);
    }
    return "row";
  }

  function pushUnique(elements, element) {
    if (elements.length >= MAX_ELEMENTS) return;
    for (var index = 0; index < elements.length; index++)
      if (elements[index].id === element.id) return;
    elements.push(element);
  }

  function collectControls(root, elements) {
    var controls = root.querySelectorAll(CONTROL_SELECTOR) || [];
    var used = {};
    for (var index = 0; index < controls.length; index++) {
      var node = controls[index];
      if (ignored(node)) continue;
      var tag = trim(node.tagName).toLowerCase();
      var type = typeOf(node);
      var role = trim(attr(node, "role"));
      var label = labelOf(node) || placeholderOf(node) || tag;
      // 弹层控件把"点开会怎样"写进名字，模型才知道要两步走。
      var hints = hintOf(node);
      if (hints.length) label = label + "（" + hints.join("；") + "）";
      label = bounded(label, MAX_LABEL);
      var row = closest(node, "tr");
      var key = row ? rowKeyOf(row) : "";
      var cell = closest(node, "td, th");
      var column =
        cell && typeof cell.cellIndex === "number" ? cell.cellIndex : index;
      var headerKey = slug(headerOf(node), "");
      var base = row
        ? "field:" + key + ":" + (headerKey || "c" + column)
        : "control:" + slug(label, "c" + index);
      var id = base;
      var bump = 2;
      while (used[id]) id = base + ":" + bump++;
      used[id] = true;
      if (typeof node.setAttribute === "function") node.setAttribute("data-gea-el", id);
      var isButton =
        clickable(node) ||
        type === "button" ||
        type === "submit";
      if (isButton) {
        // 只声明"现在真的能点"的按钮：disabled / aria-disabled 一律不进目录，
        // 这样模型看到的可点清单和人工能点的范围一致（提交/审批类同理）。
        if (disabled(node)) continue;
        var element = {
          id: id,
          role: "control",
          label: label,
          actions: ["invoke"],
        };
        var effect = classify(label);
        if (effect) element.effect = effect;
        pushUnique(elements, element);
        continue;
      }
      var editable = !disabled(node) && attr(node, "readonly") === null;
      var record = {
        id: id,
        role: tag === "select" ? "control" : "field",
        label: label,
      };
      var value = bounded(node.value, MAX_TEXT);
      if (value === undefined) value = bounded(textOf(node), MAX_TEXT);
      if (value !== undefined) record.value = value;
      if (editable) record.editable = true;
      if (tag === "select") {
        var options = optionsOf(node);
        if (options.listed.length) record.options = options.listed;
        if (options.total > options.listed.length)
          record.label = (
            label +
            "（共 " +
            options.total +
            " 项，只列前 " +
            options.listed.length +
            " 项，也可直接填名称或编码）"
          ).slice(0, MAX_LABEL);
      }
      pushUnique(elements, record);
    }
  }

  /** 只读内容：表格的行与单元格文本，供模型"念出这一屏有什么"。 */
  function collectReadouts(root, elements) {
    var tables = root.querySelectorAll("table") || [];
    for (var index = 0; index < tables.length; index++) {
      var rows = tables[index].querySelectorAll("tbody tr") || [];
      for (var rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        var row = rows[rowIndex];
        if (ignored(row)) continue;
        var key = rowKeyOf(row);
        var cells = row.children || [];
        for (var cellIndex = 0; cellIndex < cells.length; cellIndex++) {
          var cell = cells[cellIndex];
          if (ignored(cell)) continue;
          if (cell.querySelectorAll && cell.querySelectorAll(CONTROL_SELECTOR).length)
            continue;
          var value = bounded(textOf(cell), MAX_TEXT);
          if (value === undefined) continue;
          var header = "";
          var headers = tables[index].querySelectorAll("thead th") || [];
          if (headers[cellIndex]) header = slug(trim(headers[cellIndex].textContent), "");
          pushUnique(elements, {
            id: "readout:" + key + ":" + (header || "c" + cellIndex),
            role: "field",
            label: bounded((header || "第 " + (cellIndex + 1) + " 列") + " · " + key, MAX_LABEL),
            value: value,
          });
        }
      }
    }
  }

  function scan() {
    var controls = [];
    var readouts = [];
    try {
      collectControls(D, controls);
      collectReadouts(D, readouts);
    } catch (error) {
      return controls;
    }
    var elements = controls.slice(0);
    for (var index = 0; index < readouts.length; index++)
      pushUnique(elements, readouts[index]);
    return elements;
  }

  function find(id) {
    if (!id || !D.querySelector) return null;
    var escaped = String(id).replace(/"/g, '\\"');
    return D.querySelector('[data-gea-el="' + escaped + '"]');
  }

  function setNativeValue(node, value) {
    var proto = null;
    var tag = trim(node.tagName).toLowerCase();
    if (tag === "input" && W.HTMLInputElement) proto = W.HTMLInputElement.prototype;
    else if (tag === "textarea" && W.HTMLTextAreaElement) proto = W.HTMLTextAreaElement.prototype;
    else if (tag === "select" && W.HTMLSelectElement) proto = W.HTMLSelectElement.prototype;
    if (proto) {
      var descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor && descriptor.set) {
        descriptor.set.call(node, value);
        return;
      }
    }
    node.value = value;
  }

  function dispatch(node, type) {
    var event =
      typeof W.Event === "function"
        ? new W.Event(type, { bubbles: true })
        : null;
    if (event) node.dispatchEvent(event);
  }

  function optionValue(node, wanted) {
    var options = node.options || [];
    var text = trim(wanted);
    var inside = /\(([^()]*)\)\s*$/.exec(text);
    var candidates = inside ? [inside[1], text] : [text];
    for (var c = 0; c < candidates.length; c++) {
      for (var index = 0; index < options.length; index++) {
        var option = options[index];
        if (trim(option.value) === candidates[c]) return trim(option.value);
      }
      for (var labelIndex = 0; labelIndex < options.length; labelIndex++) {
        if (trim(options[labelIndex].textContent) === candidates[c])
          return trim(options[labelIndex].value);
      }
    }
    return text;
  }

  function applyOne(args) {
    var kind = trim(args && args.kind);
    if (kind === "clear") {
      if (typeof W.dispatchEvent === "function" && typeof W.KeyboardEvent === "function") {
        try {
          W.dispatchEvent(new W.KeyboardEvent("keydown", { key: "Escape" }));
        } catch (error) {
          void error;
        }
      }
      return { applied: true };
    }
    var targets = [];
    if (args && typeof args.target === "string") targets.push(args.target);
    if (args && Object.prototype.toString.call(args.targets) === "[object Array]")
      for (var index = 0; index < args.targets.length; index++)
        if (typeof args.targets[index] === "string") targets.push(args.targets[index]);
    if (!targets.length) return { applied: false, error: "MISSING_TARGET" };
    for (var cursor = 0; cursor < targets.length; cursor++) {
      var node = find(targets[cursor]);
      if (!node) return { applied: false, error: "ELEMENT_GONE" };
      if (disabled(node)) return { applied: false, error: "ELEMENT_DISABLED" };
      if (kind === "setValue") {
        var tag = trim(node.tagName).toLowerCase();
        var type = typeOf(node);
        if (type === "checkbox" || type === "radio") {
          node.checked = !/^(false|0|off|否)$/i.test(trim(args.value));
          dispatch(node, "change");
          continue;
        }
        var value = typeof args.value === "string" ? args.value : "";
        if (tag === "select") value = optionValue(node, value);
        if (attr(node, "contenteditable") !== null) {
          node.textContent = value;
          dispatch(node, "input");
          continue;
        }
        setNativeValue(node, value);
        dispatch(node, "input");
        dispatch(node, "change");
        continue;
      }
      if (kind === "invoke" || kind === "select") {
        if (typeof node.click !== "function")
          return { applied: false, error: "ELEMENT_NOT_CLICKABLE" };
        node.click();
        continue;
      }
      return { applied: false, error: "INVALID_PAGE_ACTION" };
    }
    return { applied: true };
  }

  function post(message) {
    message.protocol = PROTOCOL;
    try {
      if (W.parent && W.parent !== W) W.parent.postMessage(message, "*");
    } catch (error) {
      void error;
    }
  }

  function report(reason) {
    var elements = scan();
    post({ type: "catalog", source: "scan", reason: reason || "scan", elements: elements });
  }

  function onMessage(event) {
    var message = event && event.data;
    if (!message || typeof message !== "object") return;
    if (message.protocol !== PROTOCOL) return;
    if (message.type === "apply") {
      var result;
      try {
        result = applyOne(message.args || {});
      } catch (error) {
        result = { applied: false, error: "APPLY_FAILED" };
      }
      post({
        type: "applied",
        toolCallId: message.toolCallId,
        applied: result.applied === true,
        error: result.error,
      });
      if (result.applied === true && W.setTimeout) W.setTimeout(function () { report("applied"); }, 0);
      return;
    }
    if (message.type === "rescan") report("rescan");
  }

  if (typeof W.addEventListener === "function") W.addEventListener("message", onMessage);
  report("boot");
  if (typeof W.MutationObserver === "function" && D.documentElement) {
    var pending = null;
    var observer = new W.MutationObserver(function () {
      if (pending && W.clearTimeout) W.clearTimeout(pending);
      pending = W.setTimeout(function () { report("mutation"); }, 300);
    });
    try {
      observer.observe(D.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    } catch (error) {
      void error;
    }
  }
  // 调试/验收用的入口：不参与业务逻辑，只把这一屏读成了什么暴露出来。
  W.__geaPageScan = { scan: scan, apply: applyOne, classify: classify, report: report };
})();`;
