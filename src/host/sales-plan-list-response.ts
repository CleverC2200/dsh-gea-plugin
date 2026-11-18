import { errorEnvelope } from "./error-envelope.ts";

export function salesPlanListResponse(
  signal: AbortSignal,
  read: (signal: AbortSignal, onPage: (page: unknown) => void) => Promise<unknown>,
  flush: () => Promise<void>,
): Response {
  const reader = new AbortController();
  const active = AbortSignal.any([signal, reader.signal]);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      const send = (frame: unknown) => {
        if (!active.aborted) stream.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
      };
      void (async () => {
        try {
          const value = await read(active, (page) => send({ page })).finally(flush);
          send({ ok: true, value });
        } catch (error) {
          send({ ok: false, error: errorEnvelope(error) });
        } finally {
          if (!reader.signal.aborted) stream.close();
        }
      })();
    },
    cancel(reason) {
      reader.abort(reason);
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}
