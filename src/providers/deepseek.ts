import type { ProviderSettings } from '../types';

export const DEFAULT_SETTINGS: ProviderSettings = {
  apiBaseUrl: 'https://api.deepseek.com',
  apiKey: '',
  modelId: 'deepseekv4.1flash1017',
  timeoutMs: 30_000,
  allowImageUpload: false,
};

export const API_CAPABILITIES = {
  visionVerified: true,
  imageEditingVerified: false,
  verifiedVisionModels: ['deepseek-flash'],
  recommendedModelId: 'deepseek-flash',
  verifiedAt: '2026-10-20',
  sources: [
    'https://api-docs.deepseek.com/zh-cn/updates/',
    'https://api-docs.deepseek.com/zh-cn/api/list-models/',
    'https://api-docs.deepseek.com/zh-cn/guides/vision/',
    'https://api-docs.deepseek.com/api/create-chat-completion/',
  ],
  note: '官方文档确认 deepseek-flash 支持图像理解，并对应 V4.1-Flash-1017。原始填写的 deepseekv4.1flash1017 尚未证实是有效 API ID。图像修复与逐角色像素分割接口尚未证实；图像理解测试不代表这些能力已接入。',
} as const;

const MAX_RESPONSE_CHARS = 1_000_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cancelled(): Error {
  return new Error('请求已取消。');
}

function endpoint(base: string, path: string): URL {
  let url: URL;
  try {
    url = new URL(base.trim());
  } catch {
    throw new Error('API 地址格式无效，请填写完整的 HTTPS 地址。');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'API 地址须使用 HTTPS（本机地址可用 HTTP），且不能含账号、密码、查询参数或片段。',
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path}`;
  return url;
}

function safeHttpError(status: number): Error {
  const messages: Record<number, string> = {
    400: '请求参数未被接口接受，请检查模型和接口配置。',
    401: 'API 鉴权失败，请检查 Key。',
    402: 'API 账户余额不足，请检查服务方账户。',
    403: 'API 拒绝访问，请检查账户权限。',
    404: '未找到 API 路径或模型，请检查 API 地址和模型 ID。',
    422: 'API 参数验证失败，请检查配置。',
    429: 'API 请求过于频繁，请稍后再试。',
  };
  return new Error(messages[status] ?? `API 请求失败（HTTP ${status}），请稍后重试。`);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Uses fetch without persisting settings, API keys or response bodies.
 * The caller must confirm each image upload in a cancellable dialog immediately
 * before testVision; allowImageUpload is an additional persistent opt-in only.
 */
export class DeepSeekProvider {
  private readonly settings: ProviderSettings;

  constructor(settings: ProviderSettings) {
    this.settings = { ...settings };
  }

  private validateSettings(): void {
    if (!this.settings.apiKey.trim() || /[\r\n]/.test(this.settings.apiKey)) {
      throw new Error('请先填写有效的 API Key。');
    }
    if (!this.settings.modelId.trim()) {
      throw new Error('请先填写模型 ID。');
    }
    if (
      !Number.isFinite(this.settings.timeoutMs) ||
      this.settings.timeoutMs < 1_000 ||
      this.settings.timeoutMs > 120_000
    ) {
      throw new Error('请求超时须设置为 1 至 120 秒。');
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
    retryRead = false,
  ): Promise<unknown> {
    this.validateSettings();
    const url = endpoint(this.settings.apiBaseUrl, path);
    const attempts = retryRead ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted) throw cancelled();
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.settings.timeoutMs);
      let shouldRetry = false;
      let failure: Error | undefined;
      try {
        const response = await fetch(url.toString(), {
          ...init,
          headers: {
            Accept: 'application/json',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            Authorization: `Bearer ${this.settings.apiKey.trim()}`,
          },
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
        if (!response.ok) {
          // Never parse or expose server error bodies: they can echo credentials.
          void response.body?.cancel().catch(() => undefined);
          failure = safeHttpError(response.status);
          shouldRetry = RETRYABLE_STATUS.has(response.status);
        } else {
          const responseText = await response.text();
          if (responseText.length > MAX_RESPONSE_CHARS) {
            throw new Error('unexpected_response');
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(responseText);
          } catch {
            throw new Error('unexpected_response');
          }
          return parsed;
        }
      } catch (error: unknown) {
        if (signal?.aborted) throw cancelled();
        if (timedOut) {
          failure = new Error('API 请求超时，请检查网络或增加超时时间。');
          shouldRetry = true;
        } else if (error instanceof Error && error.message === 'unexpected_response') {
          failure = new Error('API 返回了无法识别的数据，请检查 API 地址和接口兼容性。');
        } else {
          failure = new Error('无法连接 API，请检查网络、地址及浏览器跨域限制。');
          shouldRetry = true;
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      if (!shouldRetry || attempt + 1 >= attempts) {
        throw failure ?? new Error('API 请求失败。');
      }
      await delay(500, signal);
    }
    throw new Error('API 请求失败。');
  }

  async testConnection(
    signal?: AbortSignal,
  ): Promise<{ models: string[]; selectedModelAvailable: boolean }> {
    const result = await this.request('models', { method: 'GET' }, signal, true);
    if (
      !isRecord(result) ||
      result.object !== 'list' ||
      !Array.isArray(result.data) ||
      result.data.length > 10_000
    ) {
      throw new Error('模型列表返回格式不符合文档，尚不能确认连接有效。');
    }
    const models: string[] = [];
    for (const item of result.data) {
      if (
        !isRecord(item) ||
        item.object !== 'model' ||
        typeof item.owned_by !== 'string' ||
        typeof item.id !== 'string' ||
        !/^[A-Za-z0-9._:/-]{1,160}$/.test(item.id) ||
        item.id.includes(this.settings.apiKey.trim())
      ) {
        throw new Error('模型列表返回格式不符合文档，尚不能确认连接有效。');
      }
      models.push(item.id);
    }
    return {
      models: [...new Set(models)],
      selectedModelAvailable: models.includes(this.settings.modelId.trim()),
    };
  }

  async testVision(imageDataUrl: string, signal?: AbortSignal): Promise<{ message: string }> {
    if (!this.settings.allowImageUpload) {
      throw new Error('图片外发尚未开启；请先开启并确认本次图片上传。');
    }
    if (
      !API_CAPABILITIES.verifiedVisionModels.some(
        (modelId) => modelId === this.settings.modelId.trim(),
      )
    ) {
      throw new Error('所选模型的视觉请求格式尚未核验；请使用文档确认的 deepseek-flash。');
    }
    const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      imageDataUrl,
    );
    if (!match || match[1].length % 4 !== 0) {
      throw new Error('视觉测试只接受 JPEG、PNG、GIF 或 WebP 的有效 Base64 图片。');
    }
    if ((match[1].length * 3) / 4 > MAX_IMAGE_BYTES) {
      throw new Error('本应用视觉测试图片上限为 10 MiB，请先缩小图片。');
    }
    const result = await this.request(
      'chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({
          model: this.settings.modelId.trim(),
          stream: false,
          thinking: { type: 'disabled' },
          max_tokens: 256,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '请用一句简短中文描述这张图片可见的主要内容。' },
                { type: 'image_url', image_url: { url: imageDataUrl, detail: 'low' } },
              ],
            },
          ],
        }),
      },
      signal,
    );
    if (
      !isRecord(result) ||
      result.object !== 'chat.completion' ||
      !Array.isArray(result.choices) ||
      result.choices.length === 0 ||
      !isRecord(result.choices[0]) ||
      !isRecord(result.choices[0].message) ||
      result.choices[0].message.role !== 'assistant' ||
      typeof result.choices[0].message.content !== 'string' ||
      !result.choices[0].message.content.trim()
    ) {
      throw new Error('视觉测试未返回有效的文字结果，尚不能确认视觉连接有效。');
    }
    // Render plain text only in the UI; never treat this as executable HTML.
    const message = result.choices[0].message.content
      .split(this.settings.apiKey.trim())
      .join('[已隐藏]')
      .slice(0, 2_000);
    return { message };
  }
}
