/** Local text-only wire compatibility for the AionUi GEA proxy. SSE bytes remain unchanged. */
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import { attributionHeaders } from "@deepseek-ai/dsh-llm";

export async function startAionUiWire(analysis) {
  const target = new URL(analysis.baseUrl);
  if (
    target.protocol !== "http:" ||
    target.hostname !== "127.0.0.1" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error("AIONUI_PROXY_MUST_BE_LOOPBACK");
  const credential = randomBytes(32).toString("base64url");
  const expected = Buffer.from("Bearer " + credential);
  const active = new Set();
  const server = createServer(async (req, res) => {
    const reject = (status, code) => {
      if (!res.headersSent) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code, message: code } }));
      } else res.destroy();
    };
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      reject(401, "AIONUI_WIRE_UNAUTHORIZED");
      return;
    }
    if (req.method !== "POST" || req.url !== "/chat/completions") {
      reject(404, "AIONUI_WIRE_ROUTE_NOT_FOUND");
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    res.on("close", () => controller.abort());
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > analysis.contextWindow * 8) {
          reject(413, "AIONUI_WIRE_INPUT_TOO_LARGE");
          return;
        }
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        reject(400, "AIONUI_WIRE_INVALID_JSON");
        return;
      }
      if (
        !body ||
        body.model !== analysis.model ||
        body.stream !== true ||
        !Array.isArray(body.messages) ||
        (body.tools !== undefined &&
          (!Array.isArray(body.tools) || body.tools.length !== 0))
      ) {
        reject(400, "AIONUI_WIRE_INVALID_REQUEST");
        return;
      }
      for (const message of body.messages) {
        if (
          !message ||
          !["system", "user", "assistant"].includes(message.role)
        ) {
          reject(400, "AIONUI_WIRE_INVALID_ROLE");
          return;
        }
        if (
          Array.isArray(message.content) &&
          message.content.every(
            (block) => block?.type === "text" && typeof block.text === "string",
          )
        )
          message.content = message.content.map((block) => block.text).join("");
        if (typeof message.content !== "string") {
          reject(400, "AIONUI_WIRE_TEXT_ONLY");
          return;
        }
      }
      const upstream = await fetch(target.href + "/chat/completions", {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          ...attributionHeaders(),
          "Content-Type": "application/json",
          Authorization: "Bearer " + analysis.credential,
        },
        body: JSON.stringify(body),
      });
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        reject(
          upstream.ok ? 502 : upstream.status,
          "AIONUI_UPSTREAM_HTTP_" + upstream.status,
        );
        return;
      }
      if (
        !upstream.headers
          .get("Content-Type")
          ?.toLowerCase()
          .includes("text/event-stream")
      ) {
        await upstream.body.cancel();
        reject(502, "AIONUI_UPSTREAM_NOT_SSE");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
      });
      await pipeline(Readable.fromWeb(upstream.body), res, {
        signal: controller.signal,
      });
    } catch {
      if (!controller.signal.aborted)
        reject(502, "AIONUI_WIRE_TRANSPORT_ERROR");
    } finally {
      active.delete(controller);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    credential,
    async close() {
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}
