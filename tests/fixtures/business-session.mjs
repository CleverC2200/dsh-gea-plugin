import assert from "node:assert/strict";

/** Exercise the authenticated public HTTP surface of this test's isolated profile. */
export async function fixtureRequest(app, path, body) {
  const response = await fetch(app.origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: app.cookie, Origin: app.origin },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, value: await response.json() };
}

/** Select an installed resource through Manage without creating or binding a Session privately. */
export async function selectBusinessResource(app, resourceId = "gea-readonly") {
  const selected = await fixtureRequest(app, "/api/agent-manage/resources/select", {
    id: resourceId,
    cwd: app.runtime + "/workspace",
  });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  return selected.value;
}

/** Business resources are mounted by selection before the official Session is created. */
export async function createBusinessSession(app, resourceId = "gea-readonly") {
  const selected = await selectBusinessResource(app, resourceId);
  const created = await app.remote("session/create", {
    cwd: app.runtime + "/workspace",
    agentPreset: selected.preset,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return created.value.sessionId;
}

/** Bind this existing official Session to a registered page; only Host returns the owner. */
export async function openBusinessPageSession(
  app,
  sessionId,
  pageId = "gea-proof",
  resourceId = "gea-readonly",
) {
  const opened = await fixtureRequest(app, "/api/agent-workbench/page", {
    operation: "open",
    pageId,
    sessionId,
    resourceId,
  });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(typeof opened.value.owner, "string");
  const owner = opened.value.owner;
  return {
    owner,
    context: (parameters) =>
      fixtureRequest(app, "/api/agent-workbench/page", { operation: "context", owner, parameters }),
    catalog: (parameters) =>
      fixtureRequest(app, "/api/agent-workbench/page", {
        operation: "catalog",
        owner,
        parameters: { ...parameters, pageSource: "self-report" },
      }),
    close: () => fixtureRequest(app, "/api/agent-workbench/page", { operation: "close", owner }),
  };
}

const environments = new WeakMap();
/** Keep fake process credentials in one test lifetime; repeated profiles retain the first snapshot. */
export function fixtureEnvironment(t, values) {
  let snapshots = environments.get(t);
  if (!snapshots) {
    snapshots = new Map();
    environments.set(t, snapshots);
    t.after(() => {
      for (const [name, previous] of snapshots) {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
      environments.delete(t);
    });
  }
  for (const [name, value] of Object.entries(values)) {
    if (!snapshots.has(name)) snapshots.set(name, process.env[name]);
    process.env[name] = value;
  }
}

/** Edit only this plugin Agent's Skill configuration through the current authenticated UI contract. */
export async function configurePluginSkills(app, configure, preset = "gea-readonly") {
  const response = await fetch(app.origin + "/api/agent-manage/agents/plugins", {
    headers: { Cookie: app.cookie, Origin: app.origin },
  });
  assert.equal(response.ok, true);
  const agent = (await response.json()).find((row) => row.id === preset);
  assert.ok(agent, "the target plugin Agent must be registered");
  const saved = await fixtureRequest(app, "/api/agent-manage/agents/plugin/skills", {
    id: preset,
    skills: configure(agent.skills),
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.value.publication, "ready", JSON.stringify(saved));
  return saved.value;
}
