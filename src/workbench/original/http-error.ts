/** 供复制的工作台和 Host 适配器共用的 HTTP 错误分类。 */
export class BackendHttpError extends Error {
  readonly status: number;
  /** 来自后端 `ErrorResponse.code` 的机器可读错误码；解析失败时为 `''`。 */
  readonly code: string;
  /** 来自 `ErrorResponse.error` 的后端可读消息；解析失败时为原始响应体。 */
  readonly backendMessage: string;
  /** 存在时，保存来自 `ErrorResponse.details` 的结构化后端元数据。 */
  readonly details: unknown;
  /** 解析后的原始响应体（JSON 响应为对象，文本或非 JSON 响应为字符串）。 */
  readonly body: unknown;

  constructor(params: { method: string; path: string; status: number; body: unknown }) {
    const { method, path, status, body } = params;
    let code = '';
    let backendMessage = '';
    let details: unknown;
    if (body && typeof body === 'object') {
      const b = body as { code?: unknown; error?: unknown; details?: unknown };
      if (typeof b.code === 'string') code = b.code;
      if (typeof b.error === 'string') backendMessage = b.error;
      details = b.details;
    } else if (typeof body === 'string') {
      backendMessage = body;
    }
    super(`Backend ${method} ${path} failed (${status}): ${JSON.stringify(body)}`);
    this.name = 'BackendHttpError';
    this.status = status;
    this.code = code;
    this.backendMessage = backendMessage;
    this.details = details;
    this.body = body;
  }
}

export function isBackendHttpError(error: unknown): error is BackendHttpError {
  // 优先使用 instanceof——生产和打包环境中的快速路径。
  if (error instanceof BackendHttpError) return true;
  // 兜底：vite-dev HMR 可能把模块拆到不同 chunk，导致 instanceof 失效。
  // 改用构造函数生成对象的形状进行 duck typing 判断。
  if (
    error &&
    typeof error === 'object' &&
    'name' in error &&
    (error as { name: unknown }).name === 'BackendHttpError' &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return true;
  }
  return false;
}
