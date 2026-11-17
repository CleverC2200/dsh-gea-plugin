import { GeaResponseError } from "../shared/gea-error.js";

export type ErrorEnvelope = {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
};

const CODE_PATTERN = /^[A-Z][A-Z_0-9]{2,}$/;

const UNSAFE = /[\\/]|node_modules|file:|https?:\/\/|Bearer\s|eyJ[A-Za-z0-9_-]{10}/;

export function readableMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > 200 || UNSAFE.test(text)) return undefined;
  return text;
}

export function errorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof GeaResponseError)
    return {
      code: error.code,
      message: readableMessage(error.message) ?? error.code,
      details: error.details,
    };
  const candidate = error as
    | { code?: unknown; message?: unknown; retryable?: unknown }
    | null
    | undefined;
  const message =
    typeof candidate?.message === "string"
      ? candidate.message
      : typeof error === "string"
        ? error
        : "";
  const code =
    typeof candidate?.code === "string" && CODE_PATTERN.test(candidate.code)
      ? candidate.code
      : CODE_PATTERN.test(message)
        ? message
        : "GEA_REQUEST_FAILED";
  return {
    code,
    message: readableMessage(message) ?? code,
    ...(candidate?.retryable === true ? { retryable: true } : {}),
  };
}
