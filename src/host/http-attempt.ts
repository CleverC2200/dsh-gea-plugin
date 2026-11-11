export type HttpAttempt = { requestId?: string; retryOfRequestId?: string };
export const httpAttempt = Symbol("gea-http-attempt");
export type AttemptInit = RequestInit & { [httpAttempt]?: HttpAttempt };
export function retryingFetch(fetchImpl: typeof fetch) {
  let previous = new Map<string, string>();
  const current = new Map<string, string>();
  const send: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const attempt: HttpAttempt = { retryOfRequestId: previous.get(url) };
    try {
      return await fetchImpl(input, { ...init, [httpAttempt]: attempt } as AttemptInit);
    } finally {
      if (attempt.requestId) current.set(url, attempt.requestId);
    }
  };
  return {
    fetch: send,
    retry: () => {
      previous = new Map(current);
    },
  };
}
