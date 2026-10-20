import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, DeepSeekProvider } from './deepseek';
import {
  UnconfiguredCharacterSegmentationProvider,
  UnconfiguredWatermarkRepairProvider,
} from './pipeline';

const settings = { ...DEFAULT_SETTINGS, apiKey: 'test-secret-value', modelId: 'deepseek-flash' };
const list = {
  object: 'list',
  data: [{ id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' }],
};
const imageDataUrl = 'data:image/png;base64,aGVsbG8=';
const visionResult = {
  object: 'chat.completion',
  choices: [{ message: { role: 'assistant', content: '图中有一个红色圆形。' } }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('DeepSeekProvider connection', () => {
  it('validates the model list and sends credentials only to the configured URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(list));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new DeepSeekProvider({
      ...settings,
      apiBaseUrl: 'https://gateway.example.test/v1/',
    }).testConnection();
    expect(result).toEqual({ models: ['deepseek-flash'], selectedModelAvailable: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example.test/v1/models',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: expect.objectContaining({ Authorization: 'Bearer test-secret-value' }),
      }),
    );
  });

  it('preserves the requested default ID and reports unavailable instead of substituting it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(list)));
    const result = await new DeepSeekProvider({
      ...DEFAULT_SETTINGS,
      apiKey: settings.apiKey,
    }).testConnection();
    expect(DEFAULT_SETTINGS.modelId).toBe('deepseekv4.1flash1017');
    expect(result.selectedModelAvailable).toBe(false);
  });

  it.each([
    { data: [] },
    { object: 'list', data: [{ id: 'deepseek-flash' }] },
    { object: 'list', data: [{ id: 'test-secret-value', object: 'model', owned_by: 'x' }] },
  ])('rejects unexpected response schemas without exposing raw response', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
    await expect(new DeepSeekProvider(settings).testConnection()).rejects.toThrow(
      '模型列表返回格式不符合文档',
    );
  });

  it('does not retry or expose an authentication error body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('your key was test-secret-value', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new DeepSeekProvider(settings).testConnection()).rejects.toThrow(
      'API 鉴权失败，请检查 Key。',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transient GET failure once', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json(list));
    vi.stubGlobal('fetch', fetchMock);
    const result = new DeepSeekProvider(settings).testConnection();
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toEqual({
      models: ['deepseek-flash'],
      selectedModelAvailable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts timed out requests and caps GET attempts at two', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('network secret')));
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = new DeepSeekProvider({ ...settings, timeoutMs: 1_000 }).testConnection();
    const assertion = expect(result).rejects.toThrow('API 请求超时');
    await vi.advanceTimersByTimeAsync(2_500);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels retry backoff immediately', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const result = new DeepSeekProvider(settings).testConnection(controller.signal);
    const assertion = expect(result).rejects.toThrow('请求已取消');
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'http://external.example',
    'https://username:password@example.com',
    'https://example.com?key=value',
    'https://example.com/#fragment',
  ])('rejects unsafe configuration before making requests: %s', async (apiBaseUrl) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new DeepSeekProvider({ ...settings, apiBaseUrl }).testConnection(),
    ).rejects.toThrow('API 地址须使用 HTTPS');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('DeepSeekProvider vision', () => {
  it('requires opt-in and a verified model before uploading', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new DeepSeekProvider(settings).testVision(imageDataUrl)).rejects.toThrow(
      '图片外发尚未开启',
    );
    await expect(
      new DeepSeekProvider({
        ...settings,
        modelId: DEFAULT_SETTINGS.modelId,
        allowImageUpload: true,
      }).testVision(imageDataUrl),
    ).rejects.toThrow('视觉请求格式尚未核验');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the documented image_url block and returns plain text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(visionResult));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new DeepSeekProvider({ ...settings, allowImageUpload: true }).testVision(imageDataUrl),
    ).resolves.toEqual({ message: '图中有一个红色圆形。' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('deepseek-flash');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: imageDataUrl, detail: 'low' },
    });
  });

  it('does not automatically repeat a potentially billable vision POST', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new DeepSeekProvider({ ...settings, allowImageUpload: true }).testVision(imageDataUrl),
    ).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not upload when the caller cancelled during image preparation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(
      new DeepSeekProvider({ ...settings, allowImageUpload: true }).testVision(
        imageDataUrl,
        controller.signal,
      ),
    ).rejects.toThrow('请求已取消');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts an in-flight vision request when its caller is cancelled', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const result = new DeepSeekProvider({ ...settings, allowImageUpload: true }).testVision(
      imageDataUrl,
      controller.signal,
    );
    const assertion = expect(result).rejects.toThrow('请求已取消');
    controller.abort();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid data URLs without sending them', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new DeepSeekProvider({ ...settings, allowImageUpload: true }).testVision(
        'https://external.example/image.png',
      ),
    ).rejects.toThrow('Base64 图片');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never echoes an accidentally returned API key in generated text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          ...visionResult,
          choices: [{ message: { role: 'assistant', content: settings.apiKey } }],
        }),
      ),
    );
    await expect(
      new DeepSeekProvider({ ...settings, allowImageUpload: true }).testVision(imageDataUrl),
    ).resolves.toEqual({ message: '[已隐藏]' });
  });
});

it('unconfigured pixel providers fail explicitly without inventing repaired images or masks', async () => {
  const raster = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  const mask = { width: 1, height: 1, data: new Uint8Array(1) };
  await expect(new UnconfiguredWatermarkRepairProvider().repair(raster, mask)).rejects.toThrow(
    '水印修复模型尚未接入',
  );
  await expect(new UnconfiguredCharacterSegmentationProvider().segment(raster)).rejects.toThrow(
    'AI 逐角色像素分割模型尚未接入',
  );
});
