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
