import { createServer } from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export async function downloadRegistry(t, root, initialMode) {
  const name = "fixture-network-dependency";
  const directory = join(root, "network-archive");
  await mkdir(join(directory, "package"), { recursive: true });
  await writeFile(
    join(directory, "package/package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "index.js" }),
  );
  await writeFile(join(directory, "package/index.js"), 'module.exports = "complete";\n');
  const archive = join(directory, "dependency.tgz");
  execFileSync("tar", ["-czf", archive, "-C", directory, "package"]);
  const bytes = await readFile(archive);
  let mode = initialMode;
  let failures = 2;
  const requests = [];
  let origin;
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/zod") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          name: "zod",
          "dist-tags": { latest: "1.0.0" },
          versions: { "1.0.0": { name: "zod", version: "1.0.0" } },
        }),
      );
    } else if (request.url === "/" + name) {
      if (mode === "unavailable" || (mode === "transient" && failures-- > 0)) {
        response.writeHead(503).end("temporary outage");
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          name,
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              name,
              version: "1.0.0",
              dist: {
                tarball: origin + "/dependency.tgz",
                integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
              },
            },
          },
        }),
      );
    } else if (request.url === "/dependency.tgz") {
      if (mode === "corrupt") {
        response.end(bytes.subarray(0, Math.floor(bytes.length / 2)));
        return;
      }
      response.writeHead(200, { "Content-Length": bytes.length });
      if (mode === "partial") response.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
      else response.end(bytes);
    } else response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { name, origin, requests, recover: () => (mode = "healthy") };
}
