import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build, transform } from "esbuild";
import ts from "typescript";
import { delimiter } from "node:path";

async function load(file) {
  const { outputFiles } = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    nodePaths: (process.env.GEA_TEST_NODE_PATH || "").split(delimiter).filter(Boolean),
  });
  return import(
    "data:text/javascript;base64," + Buffer.from(outputFiles[0].text).toString("base64")
  );
}

async function peopleRoute(business) {
  const source = await readFile("src/host.ts", "utf8");
  const ast = ts.createSourceFile("host.ts", source, ts.ScriptTarget.Latest, true);
  const apply = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "apply",
  );
  const registration = apply.body.statements.find(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(ast) === "registerEndpoints" &&
      node.expression.arguments[0].getText(ast).includes('"memory/state"'),
  );
  const register = apply.body.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "registerEndpoints",
  );
  const compiled = await transform(registration.getText(ast) + "\n" + register.getText(ast), {
    loader: "ts",
  });
  const routes = new Map();
  const ctx = {
    effect: (fn) => fn(),
    connection: {
      fetch: { register: (route) => routes.set(route.path, route.fetch) },
    },
  };
  const persistence = { flush: async () => {} };
  const { errorEnvelope } = await load("src/host/error-envelope.ts");
  new Function(
    "ctx",
    "business",
    "desktopLogin",
    "webLogin",
    "object",
    "errorEnvelope",
    compiled.code,
  )(ctx, business, persistence, persistence, (value) => value, errorEnvelope);
  return (payload, signal = new AbortController().signal) => {
    const request = new Request("http://localhost/api/gea-proof/people/search", {
      method: "POST",
      body: JSON.stringify(payload),
      signal,
    });
    return (
      routes.get(new URL(request.url).pathname)?.(request) ??
      new Response("not found", { status: 404 })
    );
  };
}

test("the actual registered people endpoint serves the warning picker instead of plain text 404", async () => {
  const people = [{ username: "member01", realname: "测试人员", orgCodeTxt: "华南" }];
  const route = await peopleRoute({
    assertOperation: (operation) => assert.equal(operation, "people/search"),
    capture: { run: (_session, _operation, fn) => fn() },
    searchPeople: async (payload, signal) => {
      assert.equal(payload.keyword, "测试人员");
      assert.equal(signal.aborted, false);
      return { people, hasMore: false };
    },
  });
  const response = await route({
    op: "people",
    keyword: "测试人员",
    pageNo: 1,
    pageSize: 10,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    value: { people, hasMore: false },
  });
});

test("the directory search uses scoped name and account queries, paginates and only projects picker fields", async () => {
  const { searchPeople } = await load("src/host/people-search.ts");
  const paths = [];
  const active = {
    username: "member01",
    realname: "测试人员",
    orgCodeTxt: "华南",
    status: 1,
    phone: "private",
    token: "private",
  };
  const result = await searchPeople(
    { op: "people", keyword: " 测试 人员& ", pageNo: 2, pageSize: 10 },
    async (path) => {
      paths.push(path);
      return {
        records: [active, { ...active, username: "disabled", status: 2 }],
        total: path.includes("realname=") ? 25 : 11,
      };
    },
    new AbortController().signal,
  );
  assert.equal(paths.length, 2);
  for (const path of paths) {
    const url = new URL(path, "https://gea.example");
    assert.equal(url.pathname, "/sys/user/queryUserComponentData");
    assert.equal(url.searchParams.get("pageNo"), "2");
    assert.equal(url.searchParams.get("pageSize"), "10");
    assert.equal(
      url.searchParams.get("realname") || url.searchParams.get("username"),
      "测试 人员&",
    );
    assert.notEqual(url.searchParams.has("realname"), url.searchParams.has("username"));
  }
  assert.deepEqual(result, {
    people: [{ username: "member01", realname: "测试人员", orgCodeTxt: "华南" }],
    hasMore: true,
  });
});

test("blank searches, invalid pagination and caller supplied identity or URLs never reach the backend", async () => {
  const { searchPeople } = await load("src/host/people-search.ts");
  for (const payload of [
    { keyword: "" },
    { keyword: "member", pageNo: 0 },
    { keyword: "member", pageSize: 1000 },
    { keyword: "member", token: "forged" },
    { keyword: "member", base: "https://elsewhere.example" },
  ]) {
    await assert.rejects(
      searchPeople(
        { op: "people", ...payload },
        async () => assert.fail("unexpected request"),
        new AbortController().signal,
      ),
      /PEOPLE_SEARCH_INVALID_REQUEST/,
    );
  }
});

test("empty directories are successful but upstream rejection or malformed data stays a failure", async () => {
  const { searchPeople } = await load("src/host/people-search.ts");
  const payload = { op: "people", keyword: "unknown" },
    signal = new AbortController().signal;
  assert.deepEqual(await searchPeople(payload, async () => ({ records: [], total: 0 }), signal), {
    people: [],
    hasMore: false,
  });
  await assert.rejects(
    searchPeople(payload, async () => "not found", signal),
    /PEOPLE_SEARCH_INVALID_RESPONSE/,
  );
  await assert.rejects(
    searchPeople(
      payload,
      async (path) => {
        if (path.includes("username=")) throw Error("DATA_PERMISSION_DENIED");
        return { records: [], total: 0 };
      },
      signal,
    ),
    /DATA_PERMISSION_DENIED/,
  );
});

test("the actual Business method keeps APS admission, authenticated identity and identity cancellation", async () => {
  const { searchPeople } = await load("src/host/people-search.ts");
  const source = await readFile("src/host/business.ts", "utf8");
  const ast = ts.createSourceFile("business.ts", source, ts.ScriptTarget.Latest, true);
  const business = ast.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === "Business",
  );
  const method = business.members.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === "searchPeople",
  );
  const compiled = await transform("class Subject {" + method.getText(ast) + "}\nreturn Subject;", {
    loader: "ts",
  });
  const Subject = new Function("searchPeople", compiled.code)(searchPeople);
  const subject = new Subject(),
    identity = {},
    epoch = new AbortController();
  let entered = 0;
  const pending = Promise.withResolvers();
  Object.assign(subject, {
    assertExecutionAllowed: (consumer) => assert.equal(consumer, "aps"),
    authenticated: () => identity,
    epoch,
    gatewayRequests: {
      read: async (_path, auth, signal) => {
        assert.equal(auth, identity);
        assert.equal(signal.aborted, false);
        entered++;
        return pending.promise;
      },
    },
  });
  const lookup = subject.searchPeople(
    { op: "people", keyword: "member" },
    new AbortController().signal,
  );
  assert.equal(entered, 2);
  epoch.abort(Error("STALE_SELECTION"));
  pending.resolve({ records: [], total: 0 });
  await assert.rejects(lookup, /STALE_SELECTION/);
  subject.authenticated = () => {
    throw Error("GEA_LOGIN_REQUIRED");
  };
  await assert.rejects(
    subject.searchPeople({ op: "people", keyword: "member" }, new AbortController().signal),
    /GEA_LOGIN_REQUIRED/,
  );
  assert.equal(entered, 2);
});
