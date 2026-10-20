export type Reserve = (amountCny: number, label: string) => void | Promise<void>;
export type FetchLike = typeof fetch;
export interface ProviderOptions {
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
  queueTimeoutMs?: number;
  pollIntervalMs?: number;
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('操作已取消。', 'AbortError');
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function optionsOf(options?: ProviderOptions | FetchLike): Required<ProviderOptions> {
  const v = typeof options === 'function' ? { fetchImpl: options } : (options ?? {});
  return {
    fetchImpl: v.fetchImpl ?? fetch,
    requestTimeoutMs: v.requestTimeoutMs ?? 90_000,
    queueTimeoutMs: v.queueTimeoutMs ?? 180_000,
    pollIntervalMs: v.pollIntervalMs ?? 1_500,
  };
}

export function validateKey(key: string, service: string): void {
  if (!key.trim() || /[\r\n]/.test(key))
    throw new ProviderError(`请由管理员配置有效的 ${service} Key。`);
}

export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  aborted(signal);
  await new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(new DOMException('操作已取消。', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

/** Response bodies and upstream errors are never attached as causes or logged. */
export async function requestBytes(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  service: string,
  signal?: AbortSignal,
  timeoutMs = 90_000,
  maxBytes = 2 * 1024 * 1024,
): Promise<Buffer> {
  aborted(signal);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      const detail =
        response.status === 401 || response.status === 403
          ? '鉴权失败，请检查管理员配置'
          : response.status === 402
            ? '余额不足'
            : response.status === 429
              ? '请求限流，请稍后重试'
              : `请求失败（HTTP ${response.status}）`;
      throw new ProviderError(`${service} ${detail}。`);
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw new ProviderError(`${service} 返回内容超过安全大小限制。`);
    }
    if (!response.body) throw new ProviderError(`${service} 返回了空内容。`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        aborted(controller.signal);
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ProviderError(`${service} 返回内容超过安全大小限制。`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    aborted(signal);
    return Buffer.concat(chunks, size);
  } catch (error) {
    aborted(signal);
    if (timedOut) throw new ProviderError(`${service} 请求超时，未自动重复提交。`);
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(`${service} 网络请求失败，未自动重复提交。`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  service: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<unknown> {
  const bytes = await requestBytes(fetchImpl, url, init, service, signal, timeoutMs);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new ProviderError(`${service} 返回的数据格式无效。`);
  }
}
