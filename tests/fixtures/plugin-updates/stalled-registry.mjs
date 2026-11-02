import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

export async function configureStalledPnpmRegistry(t, profile) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url !== "/pnpm") response.writeHead(503).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const directory = join(dirname(profile.dir), "stalled-registry-config");
  await mkdir(directory);
  const config = join(directory, "npmrc");
  await writeFile(
    config,
    [
      `registry=http://127.0.0.1:${server.address().port}/`,
      "update-notifier=true",
      "ci=false",
      "fetch-timeout=60000",
      "fetch-retries=0",
      "",
    ].join("\n"),
  );
  profile.packageManager.env = {
    ...profile.packageManager.env,
    npm_config_userconfig: config,
    npm_config_globalconfig: config,
    XDG_STATE_HOME: directory,
    XDG_CACHE_HOME: directory,
    PNPM_MAX_WORKERS: "1",
  };
  return { requests };
}
