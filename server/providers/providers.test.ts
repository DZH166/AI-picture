import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { DeepSeekService, FalService } from './index';
import { requestBytes, type FetchLike } from './http';

const FAKE_KEY = 'unit-test-not-a-real-key';
const options = (fetchImpl: FetchLike) => ({ fetchImpl, pollIntervalMs: 1, queueTimeoutMs: 1000 });
const makeImage = (width = 100, height = 100, background = '#ffffff') =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();
const completion = (assets: unknown[] = [], watermarks: unknown[] = []) =>
  Response.json({
    choices: [
      {
        finish_reason: 'stop',
        message: { content: JSON.stringify({ assets, watermarks, warnings: [] }) },
      },
    ],
  });
const asset = (x = 10, y = 10, width = 20, height = 20) => ({
  id: 'unsafe-provider-controlled-id',
  label: '完整小猫与标语',
  kind: 'cutout',
  prompt: 'the entire cat sticker including its caption',
  bounds: { x, y, width, height },
});
function queueResponse(app = 'sam-3', id = 'request-1') {
  const root = `https://queue.fal.run/fal-ai/${app}/requests/${id}`;
  return {
    request_id: id,
    status_url: `${root}/status`,
    response_url: root,
    cancel_url: `${root}/cancel`,
  };
}

describe('DeepSeek server adapter', () => {
  it('checks the official model without reserving money or sending images', async () => {
    const reserve = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        object: 'list',
        data: [{ object: 'model', id: 'deepseek-flash', owned_by: 'deepseek' }],
      }),
    );
    const result = await new DeepSeekService(FAKE_KEY, reserve, fetchMock).testConnection();
    expect(result.message).toContain('鉴权成功');
    expect(reserve).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deepseek.com/models',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { Authorization: `Bearer ${FAKE_KEY}` },
      }),
    );
  });

  it('rejects a model listing missing required ownership metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        object: 'list',
        data: [{ object: 'model', id: 'deepseek-flash' }],
      }),
    );
    await expect(
      new DeepSeekService(FAKE_KEY, vi.fn(), fetchMock).testConnection(),
    ).rejects.toThrow('模型列表格式无效');
  });

  it('runs full image plus four overlapping crops and translates/de-duplicates local bounds', async () => {
    const reserve = vi.fn();
    const replies = [
      completion([asset(45, 45)]),
      completion([]),
      completion([asset(5, 45, 20, 15)]),
      completion([]),
      completion([asset(5, 5)]),
    ];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(replies.shift()));
    const result = await new DeepSeekService(FAKE_KEY, reserve, fetchMock).analyze(
      await makeImage(),
      { width: 100, height: 100 },
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(reserve).toHaveBeenCalledTimes(5);
    expect(reserve.mock.calls.every((call) => call[0] === 0.15)).toBe(true);
    // Partial upper tile candidate touches its internal bottom boundary and is dropped.
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].bounds).toEqual({ x: 45, y: 45, width: 20, height: 20 });
    expect(result.assets[0].id).toMatch(/^asset-[a-f0-9]{20}$/);
    expect(result.assets[0].id).not.toContain('unsafe');
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    for (const body of bodies) {
      expect(body.model).toBe('deepseek-flash');
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.messages[0].content[1].image_url.detail).toBe('original');
      expect(body.messages[0].content[0].text).toContain('徽章');
      expect(body.messages[0].content[0].text).toContain('设计本身');
    }
    const sizes = await Promise.all(
      bodies.map((body) =>
        sharp(
          Buffer.from(body.messages[0].content[1].image_url.url.split(',')[1], 'base64'),
        ).metadata(),
      ),
    );
    expect(sizes.map((size) => [size.width, size.height])).toEqual([
      [100, 100],
      [60, 60],
      [60, 60],
      [60, 60],
      [60, 60],
    ]);
  });

  it('produces stable local IDs independent of model-controlled IDs', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(completion([asset(10, 10)])));
    const service = new DeepSeekService(FAKE_KEY, vi.fn(), fetchMock);
    const input = await makeImage();
    const first = await service.analyze(input, { width: 100, height: 100 });
    const second = await service.analyze(input, { width: 100, height: 100 });
    expect(first.assets.map((v) => v.id)).toEqual(second.assets.map((v) => v.id));
  });

  it.each([
    { x: -1, y: 0, width: 10, height: 10 },
    { x: 95, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: 0, height: 10 },
    { x: '1', y: 0, width: 10, height: 10 },
  ])('rejects malformed or out-of-bounds coordinates without a second POST', async (bounds) => {
    const fetchMock = vi.fn().mockResolvedValue(completion([{ ...asset(), bounds }]));
    await expect(
      new DeepSeekService(FAKE_KEY, vi.fn(), fetchMock).analyze(await makeImage(), {
        width: 100,
        height: 100,
      }),
    ).rejects.toThrow('坐标不合规');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the budget exception intact and does not send the blocked request', async () => {
    const failure = Object.assign(new Error('预算已用完'), { name: 'BudgetExceededError' });
    const reserve = vi.fn().mockRejectedValue(failure);
    const fetchMock = vi.fn();
    await expect(
      new DeepSeekService(FAKE_KEY, reserve, fetchMock).analyze(await makeImage(), {
        width: 100,
        height: 100,
      }),
    ).rejects.toBe(failure);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not submit if the caller cancels while a reservation is pending', async () => {
    const controller = new AbortController();
    const reserve = vi.fn(async () => {
      controller.abort();
    });
    const fetchMock = vi.fn();
    await expect(
      new DeepSeekService(FAKE_KEY, reserve, fetchMock).analyze(
        await makeImage(),
        { width: 100, height: 100 },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not expose or retry provider HTTP errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(FAKE_KEY, { status: 401 }));
    await expect(
      new DeepSeekService(FAKE_KEY, vi.fn(), fetchMock).analyze(await makeImage(), {
        width: 100,
        height: 100,
      }),
    ).rejects.toThrow('鉴权失败');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects truncated JSON completions instead of using partial candidate lists', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: 'length',
            message: { content: '{"assets":[],"watermarks":[],"warnings":[]}' },
          },
        ],
      }),
    );
    await expect(
      new DeepSeekService(FAKE_KEY, vi.fn(), fetchMock).analyze(await makeImage(), {
        width: 100,
        height: 100,
      }),
    ).rejects.toThrow('分析结构');
  });
});

describe('fal adapter queue and masks', () => {
  it('uses returned owner/app URLs, correct SAM schema and downloads a real grayscale mask without a key', async () => {
    const input = await makeImage(100, 100);
    const mask = await makeImage(50, 50);
    const queue = queueResponse();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const reserve = vi.fn();
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/image')) return Response.json(queue);
      if (url === queue.status_url)
        return Response.json({ status: 'COMPLETED', request_id: queue.request_id });
      if (url === queue.response_url)
        return Response.json({
          masks: [{ url: 'https://v3.fal.media/files/mask.png' }],
          scores: [0.91],
        });
      return new Response(mask);
    });
    const result = await new FalService(FAKE_KEY, reserve, options(fetchMock)).segment(input, {
      prompt: 'complete cat design',
      box: { x: 10, y: 15, width: 50, height: 60 },
      points: [{ x: 20, y: 30, label: 1 }],
      maxMasks: 1,
    });
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.91);
    const meta = await sharp(result[0].mask).metadata();
    expect([meta.width, meta.height]).toEqual([100, 100]);
    expect(reserve).toHaveBeenCalledWith(0.05, 'fal分割费用预留');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.apply_mask).toBe(false);
    expect(body.box_prompts).toEqual([
      { x_min: 10, y_min: 15, x_max: 60, y_max: 75, object_id: 1 },
    ]);
    expect(body.point_prompts).toEqual([{ x: 20, y: 30, label: 1, object_id: 1 }]);
    expect(calls[0].init.headers).toMatchObject({
      'X-Fal-No-Retry': '1',
      'X-Fal-Store-IO': '0',
      'x-app-fal-disable-fallback': 'true',
      'X-Fal-Object-Lifecycle-Preference': '{"expiration_duration_seconds":3600}',
    });
    expect(calls[3].init.headers).toBeUndefined();
    expect(calls.every((call) => call.init.redirect === 'error')).toBe(true);
  });

  it('uses best_quality mask removal and no mask expansion', async () => {
    const source = await makeImage();
    const queue = queueResponse('object-removal');
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/mask')) return Response.json(queue);
      if (url === queue.status_url) return Response.json({ status: 'COMPLETED' });
      if (url === queue.response_url)
        return Response.json({ images: [{ url: 'https://v3b.fal.media/files/repaired.png' }] });
      return new Response(source);
    });
    const reserve = vi.fn();
    const result = await new FalService(FAKE_KEY, reserve, options(fetchMock)).repair(
      source,
      source,
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('best_quality');
    expect(body.mask_expansion).toBe(0);
    expect(body.mask_url).toMatch(/^data:image\/png;base64,/);
    expect(reserve).toHaveBeenCalledWith(0.2, 'fal修复费用预留');
    expect((await sharp(result).metadata()).width).toBe(100);
  });

  it.each([
    'http://v3.fal.media/mask.png',
    'https://127.0.0.1/mask.png',
    'https://v3.fal.media.evil.test/mask.png',
    'https://user:secret@v3.fal.media/mask.png',
  ])('blocks untrusted media addresses before any download: %s', async (url) => {
    const queue = queueResponse();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(queue))
      .mockResolvedValueOnce(Response.json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(Response.json({ masks: [{ url }] }));
    await expect(
      new FalService(FAKE_KEY, vi.fn(), options(fetchMock)).segment(await makeImage(), {
        prompt: 'cat',
      }),
    ).rejects.toThrow('允许列表');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects queue URL injection without forwarding credentials to another host', async () => {
    const queue = { ...queueResponse(), cancel_url: 'https://attacker.example/cancel' };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(queue));
    await expect(
      new FalService(FAKE_KEY, vi.fn(), options(fetchMock)).segment(await makeImage(), {
        prompt: 'cat',
      }),
    ).rejects.toThrow('允许列表');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels the real queue via PUT when caller aborts while polling', async () => {
    const queue = queueResponse();
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/image')) return Response.json(queue);
      if (url === queue.status_url) {
        controller.abort();
        return Response.json({ status: 'IN_PROGRESS' });
      }
      return Response.json({ status: 'CANCELLATION_REQUESTED' });
    });
    await expect(
      new FalService(FAKE_KEY, vi.fn(), options(fetchMock)).segment(
        await makeImage(),
        { prompt: 'cat' },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledWith(
      queue.cancel_url,
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('cancels on a total queue deadline instead of polling forever', async () => {
    const queue = queueResponse();
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/image')) return Response.json(queue);
      if (url === queue.status_url) return Response.json({ status: 'IN_QUEUE' });
      return Response.json({ status: 'OK' });
    });
    await expect(
      new FalService(FAKE_KEY, vi.fn(), { ...options(fetchMock), queueTimeoutMs: 20 }).segment(
        await makeImage(),
        { prompt: 'cat' },
      ),
    ).rejects.toThrow('处理超时');
    expect(fetchMock).toHaveBeenCalledWith(
      queue.cancel_url,
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(fetchMock.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1);
  });

  it('rejects masks with different aspect ratios', async () => {
    const queue = queueResponse();
    const wrong = await makeImage(100, 50);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(queue))
      .mockResolvedValueOnce(Response.json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(
        Response.json({ masks: [{ url: 'https://fal.media/files/mask.png' }] }),
      )
      .mockResolvedValueOnce(new Response(wrong));
    await expect(
      new FalService(FAKE_KEY, vi.fn(), options(fetchMock)).segment(await makeImage(), {
        prompt: 'cat',
      }),
    ).rejects.toThrow('比例不一致');
  });

  it('does not bill empty repair masks or out-of-bounds prompts', async () => {
    const reserve = vi.fn();
    const fetchMock = vi.fn();
    const service = new FalService(FAKE_KEY, reserve, options(fetchMock));
    const image = await makeImage();
    await expect(service.repair(image, await makeImage(100, 100, '#000000'))).rejects.toThrow(
      '蒙版为空',
    );
    await expect(
      service.segment(image, { prompt: 'cat', box: { x: 90, y: 0, width: 50, height: 20 } }),
    ).rejects.toThrow('超出');
    expect(reserve).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats transparent white mask pixels as background and does not bill an invisible repair mask', async () => {
    const invisible = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const source = await makeImage();
    const queue = queueResponse();
    const reserve = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(queue))
      .mockResolvedValueOnce(Response.json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(
        Response.json({ masks: [{ url: 'https://v3.fal.media/files/transparent.png' }] }),
      )
      .mockResolvedValueOnce(new Response(invisible));
    const service = new FalService(FAKE_KEY, reserve, options(fetchMock));
    const outputs = await service.segment(source, { prompt: 'cat' });
    expect((await sharp(outputs[0].mask).stats()).channels[0].max).toBe(0);
    await expect(service.repair(source, invisible)).rejects.toThrow('蒙版为空');
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('keeps BudgetExceededError identity and never submits on reserve refusal', async () => {
    const failure = Object.assign(new Error('budget'), { name: 'BudgetExceededError' });
    const fetchMock = vi.fn();
    await expect(
      new FalService(
        FAKE_KEY,
        () => {
          throw failure;
        },
        options(fetchMock),
      ).segment(await makeImage(), { prompt: 'cat' }),
    ).rejects.toBe(failure);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not submit or reserve again when cancellation arrives during a reservation', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn();
    const reserve = vi.fn(async () => {
      controller.abort();
    });
    await expect(
      new FalService(FAKE_KEY, reserve, options(fetchMock)).segment(
        await makeImage(),
        { prompt: 'cat' },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry or reveal response bodies when the submit fails', async () => {
    const reserve = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(`upstream detail ${FAKE_KEY}`, { status: 500 }));
    const error = await new FalService(FAKE_KEY, reserve, options(fetchMock))
      .segment(await makeImage(), { prompt: 'cat' })
      .catch((reason) => reason);
    expect(error).toMatchObject({ name: 'ProviderError' });
    expect(error.message).not.toContain(FAKE_KEY);
    expect(error.message).not.toContain('upstream detail');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('connection test generates a tiny image and actually traverses SAM', async () => {
    const queue = queueResponse();
    const mask = await makeImage(128, 128);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(queue))
      .mockResolvedValueOnce(Response.json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(
        Response.json({ masks: [{ url: 'https://v3.fal.media/files/test.png' }] }),
      )
      .mockResolvedValueOnce(new Response(mask));
    const reserve = vi.fn();
    const result = await new FalService(FAKE_KEY, reserve, options(fetchMock)).testConnection();
    expect(result.message).toContain('真实 SAM 3');
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

it('limits actual streamed bytes even if Content-Length is absent', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array(20)));
  await expect(
    requestBytes(fetchMock, 'https://fal.media/a', {}, '测试', undefined, 1000, 10),
  ).rejects.toThrow('超过安全大小');
});
