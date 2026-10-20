export async function api<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const form = options.body instanceof FormData;
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      'X-AI-Picture': '1',
      ...(options.body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    body:
      options.body === undefined
        ? undefined
        : form
          ? (options.body as FormData)
          : JSON.stringify(options.body),
    signal: options.signal,
  });
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error('服务暂时不可用，请确认主机服务已启动。');
  }
  if (!response.ok)
    throw new Error(
      result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
        ? result.error
        : '请求未完成，请重试。',
    );
  return result as T;
}

export function downloadUrl(url: string, filename?: string) {
  const link = document.createElement('a');
  link.href = url;
  if (filename) link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
