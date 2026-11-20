function modelParameters(model: Record<string, unknown>): Record<string, unknown> | undefined {
  let parameters: unknown = model.modelParams;
  if (typeof parameters === "string") {
    try {
      parameters = JSON.parse(parameters);
    } catch {
      return undefined;
    }
  }
  return parameters && typeof parameters === "object" && !Array.isArray(parameters)
    ? (parameters as Record<string, unknown>)
    : undefined;
}

export function modelContextWindow(model: Record<string, unknown>): number | undefined {
  const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const declared = model.contextWindow ?? model.context_window;
  if (positive(declared)) return declared;
  const parameters = modelParameters(model);
  const configured = parameters?.contextWindow ?? parameters?.context_window;
  return positive(configured) ? configured : undefined;
}

export function modelInputModalities(
  model: Record<string, unknown>,
): ("text" | "image")[] | undefined {
  const parameters = modelParameters(model);
  const declared =
    model.inputModalities ??
    model.input_modalities ??
    parameters?.inputModalities ??
    parameters?.input_modalities;
  if (!Array.isArray(declared)) return undefined;
  if (declared.includes("image")) return ["text", "image"];
  if (declared.includes("text")) return ["text"];
}

export function officialModelContextWindow(model: Record<string, unknown>): number | undefined {
  if (typeof model.provider !== "string" || model.provider.toUpperCase() !== "DEEPSEEK")
    return undefined;
  if (model.modelName !== "deepseek-flash" && model.modelName !== "deepseek-v4-pro")
    return undefined;
  if (typeof model.baseUrl !== "string") return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(model.baseUrl);
  } catch {
    return undefined;
  }
  if (
    endpoint.origin !== "https://api.deepseek.com" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    return undefined;
  if (!["", "/v1"].includes(endpoint.pathname.replace(/\/+$/, ""))) return undefined;
  return 1000000;
}
