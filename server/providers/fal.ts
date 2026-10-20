import sharp from 'sharp';
import type { Bounds } from '../../shared/contracts';
import {
  aborted,
  optionsOf,
  pause,
  ProviderError,
  record,
  requestBytes,
  requestJson,
  validateKey,
  type FetchLike,
  type ProviderOptions,
  type Reserve,
} from './http';

const QUEUE = 'https://queue.fal.run';
const SAM = 'fal-ai/sam-3/image';
const REPAIR = 'fal-ai/object-removal/mask';
const MAX_PIXELS = 40_000_000;
const MAX_FILE = 30 * 1024 * 1024;
const MEDIA_HOSTS = new Set(['fal.media', 'v3.fal.media', 'v3b.fal.media']);
export interface SegmentOptions {
  prompt: string;
  box?: Bounds;
  points?: Array<{ x: number; y: number; label: 0 | 1 }>;
  maxMasks?: number;
}

function trustedUrl(value: unknown, media: boolean): string {
  if (typeof value !== 'string') throw new ProviderError('fal 返回的下载或队列地址无效。');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError('fal 返回的下载或队列地址无效。');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    (media ? !MEDIA_HOSTS.has(url.hostname) : url.hostname !== 'queue.fal.run')
  ) {
    throw new ProviderError('fal 返回了不在允许列表中的地址，已停止访问。');
  }
  return url.toString();
}

function queueUrl(value: unknown, endpoint: string, requestId: string, suffix: string): string {
  const safe = trustedUrl(value, false);
  const url = new URL(safe);
  const app = endpoint.split('/').slice(0, 2).join('/');
  if (url.pathname !== `/${app}/requests/${requestId}${suffix}` || url.search) {
    throw new ProviderError('fal 队列跟踪地址与当前请求不一致。');
  }
  return safe;
}

async function decode(image: Buffer): Promise<{ png: Buffer; width: number; height: number }> {
  if (!Buffer.isBuffer(image) || image.length === 0 || image.length > MAX_FILE)
    throw new ProviderError('fal 图片文件大小无效。');
  try {
    const { data, info } = await sharp(image, { limitInputPixels: MAX_PIXELS })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (data.length > MAX_FILE) throw new Error('size');
    return { png: data, width: info.width, height: info.height };
  } catch {
    throw new ProviderError('fal 图片无法解码或超过像素限制。');
  }
}

function sameAspect(
  width: number,
  height: number,
  originalWidth: number,
  originalHeight: number,
): boolean {
  return Math.abs(width / height / (originalWidth / originalHeight) - 1) <= 0.015;
}

/** REST schema sources are recorded in server/providers/README.md. */
export class FalService {
  private readonly options: Required<ProviderOptions>;
  constructor(
    private readonly key: string,
    private readonly reserve: Reserve,
    options?: ProviderOptions | FetchLike,
  ) {
    this.options = optionsOf(options);
  }
  private headers(): Record<string, string> {
    return { Authorization: `Key ${this.key.trim()}`, 'Content-Type': 'application/json' };
  }

  private async run(
    endpoint: string,
    input: unknown,
    amount: number,
    label: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    validateKey(this.key, 'fal');
    aborted(signal);
    // The reservation must happen before submission, and budget errors stay intact.
    await this.reserve(amount, label);
    aborted(signal);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.queueTimeoutMs);
    let cancellationUrl: string | undefined;
    let finished = false;
    try {
      const submitted = await requestJson(
        this.options.fetchImpl,
        `${QUEUE}/${endpoint}`,
        {
          method: 'POST',
          headers: {
            ...this.headers(),
            'X-Fal-No-Retry': '1',
            'X-Fal-Store-IO': '0',
            'X-Fal-Request-Start-Timeout': '60',
            'x-app-fal-disable-fallback': 'true',
            'X-Fal-Object-Lifecycle-Preference': JSON.stringify({
              expiration_duration_seconds: 3600,
            }),
          },
          body: JSON.stringify(input),
        },
        'fal',
        controller.signal,
        this.options.requestTimeoutMs,
      );
      if (
        !record(submitted) ||
        typeof submitted.request_id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,150}$/.test(submitted.request_id)
      ) {
        throw new ProviderError('fal 未返回有效请求编号；为避免重复计费，未重发。');
      }
      cancellationUrl = queueUrl(submitted.cancel_url, endpoint, submitted.request_id, '/cancel');
      const statusUrl = queueUrl(submitted.status_url, endpoint, submitted.request_id, '/status');
      const responseUrl = queueUrl(submitted.response_url, endpoint, submitted.request_id, '');
      while (true) {
        aborted(controller.signal);
        const state = await requestJson(
          this.options.fetchImpl,
          statusUrl,
          { method: 'GET', headers: this.headers() },
          'fal',
          controller.signal,
          this.options.requestTimeoutMs,
        );
        if (!record(state)) throw new ProviderError('fal 队列状态格式无效。');
        if (state.request_id !== undefined && state.request_id !== submitted.request_id)
          throw new ProviderError('fal 队列状态不属于当前请求。');
        if (state.status === 'COMPLETED') {
          finished = true;
          if (state.error || state.error_type)
            throw new ProviderError('fal 模型处理失败，请检查图片与管理员配置。');
          return await requestJson(
            this.options.fetchImpl,
            responseUrl,
            { method: 'GET', headers: this.headers() },
            'fal',
            controller.signal,
            this.options.requestTimeoutMs,
          );
        }
        if (state.status !== 'IN_QUEUE' && state.status !== 'IN_PROGRESS')
          throw new ProviderError('fal 返回未知队列状态。');
        await pause(this.options.pollIntervalMs, controller.signal);
      }
    } catch (error) {
      if (cancellationUrl && !finished) {
        // A running provider can still finish despite this best-effort request.
        await requestJson(
          this.options.fetchImpl,
          cancellationUrl,
          { method: 'PUT', headers: this.headers() },
          'fal',
          undefined,
          5_000,
        ).catch(() => undefined);
      }
      aborted(signal);
      if (timedOut) throw new ProviderError('fal 处理超时，已尝试取消队列请求；请检查服务方记录。');
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  private async media(url: unknown, signal?: AbortSignal): Promise<Buffer> {
    const safe = trustedUrl(url, true);
    // Deliberately omit Authorization: media must never receive the API key.
    const image = await requestBytes(
      this.options.fetchImpl,
      safe,
      { method: 'GET' },
      'fal 图片下载',
      signal,
      30_000,
      MAX_FILE,
    );
    return image;
  }

  async segment(
    image: Buffer,
    options: SegmentOptions,
    signal?: AbortSignal,
  ): Promise<Array<{ mask: Buffer; score?: number }>> {
    validateKey(this.key, 'fal');
    aborted(signal);
    const source = await decode(image);
    const maxMasks = options.maxMasks ?? 3;
    if (
      typeof options.prompt !== 'string' ||
      !options.prompt.trim() ||
      options.prompt.length > 1000 ||
      !Number.isInteger(maxMasks) ||
      maxMasks < 1 ||
      maxMasks > 32
    )
      throw new ProviderError('分割提示或蒙版数量无效。');
    const box = options.box;
    if (
      box &&
      (![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
        box.x < 0 ||
        box.y < 0 ||
        box.width <= 0 ||
        box.height <= 0 ||
        box.x + box.width > source.width ||
        box.y + box.height > source.height)
    ) {
      throw new ProviderError('分割框超出传入图片范围。');
    }
    const points = options.points ?? [];
    if (
      points.length > 128 ||
      points.some(
        (p) =>
          !Number.isFinite(p.x) ||
          !Number.isFinite(p.y) ||
          p.x < 0 ||
          p.y < 0 ||
          p.x >= source.width ||
          p.y >= source.height ||
          (p.label !== 0 && p.label !== 1),
      )
    ) {
      throw new ProviderError('分割点超出传入图片范围。');
    }
    const result = await this.run(
      SAM,
      {
        image_url: `data:image/png;base64,${source.png.toString('base64')}`,
        prompt: options.prompt.trim(),
        apply_mask: false,
        sync_mode: false,
        output_format: 'png',
        return_multiple_masks: true,
        max_masks: maxMasks,
        include_scores: true,
        include_boxes: true,
        box_prompts: box
          ? [
              {
                x_min: Math.floor(box.x),
                y_min: Math.floor(box.y),
                x_max: Math.ceil(box.x + box.width),
                y_max: Math.ceil(box.y + box.height),
                object_id: 1,
              },
            ]
          : [],
        point_prompts: points.map((p) => ({
          x: Math.floor(p.x),
          y: Math.floor(p.y),
          label: p.label,
          object_id: 1,
        })),
      },
      0.05,
      'fal分割费用预留',
      signal,
    );
    if (!record(result) || !Array.isArray(result.masks) || result.masks.length > maxMasks)
      throw new ProviderError('fal 分割没有返回符合协议的像素蒙版。');
    const masks: Array<{ mask: Buffer; score?: number }> = [];
    for (let i = 0; i < result.masks.length; i++) {
      aborted(signal);
      const item = result.masks[i];
      if (!record(item)) throw new ProviderError('fal 分割蒙版格式无效。');
      const downloaded = await this.media(item.url, signal);
      const decoded = await decode(downloaded);
      aborted(signal);
      if (!sameAspect(decoded.width, decoded.height, source.width, source.height))
        throw new ProviderError('分割蒙版与原图宽高比例不一致，无法安全对齐。');
      // Transparent pixels never designate foreground, regardless of hidden RGB.
      const mask = await sharp(decoded.png)
        .flatten({ background: '#000000' })
        .greyscale()
        .resize(source.width, source.height, { fit: 'fill', kernel: 'nearest' })
        .threshold(127)
        .png()
        .toBuffer();
      aborted(signal);
      const score = Array.isArray(result.scores) ? result.scores[i] : undefined;
      if (
        score !== undefined &&
        (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)
      )
        throw new ProviderError('fal 蒙版置信度格式无效。');
      masks.push({ mask, ...(typeof score === 'number' ? { score } : {}) });
    }
    return masks;
  }

  async repair(image: Buffer, mask: Buffer, signal?: AbortSignal): Promise<Buffer> {
    validateKey(this.key, 'fal');
    aborted(signal);
    const source = await decode(image);
    const maskSource = await decode(mask);
    if (source.width !== maskSource.width || source.height !== maskSource.height)
      throw new ProviderError('修复蒙版与原图尺寸必须相同。');
    const monochrome = await sharp(maskSource.png)
      .flatten({ background: '#000000' })
      .greyscale()
      .threshold(127)
      .png()
      .toBuffer();
    const stats = await sharp(monochrome).stats();
    aborted(signal);
    if (stats.channels[0].max === 0) throw new ProviderError('修复蒙版为空，不提交计费修复请求。');
    const result = await this.run(
      REPAIR,
      {
        image_url: `data:image/png;base64,${source.png.toString('base64')}`,
        mask_url: `data:image/png;base64,${monochrome.toString('base64')}`,
        model: 'best_quality',
        mask_expansion: 0,
      },
      0.2,
      'fal修复费用预留',
      signal,
    );
    if (
      !record(result) ||
      !Array.isArray(result.images) ||
      result.images.length !== 1 ||
      !record(result.images[0])
    )
      throw new ProviderError('fal 修复未返回有效图片。');
    const decoded = await decode(await this.media(result.images[0].url, signal));
    aborted(signal);
    if (!sameAspect(decoded.width, decoded.height, source.width, source.height))
      throw new ProviderError('修复结果宽高比例变化，无法安全对齐。');
    const repaired = await sharp(decoded.png)
      .resize(source.width, source.height, { fit: 'fill' })
      .png()
      .toBuffer();
    aborted(signal);
    return repaired;
  }

  async testConnection(signal?: AbortSignal): Promise<{ message: string }> {
    aborted(signal);
    const image = await sharp({
      create: { width: 128, height: 128, channels: 3, background: '#ffffff' },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 64, height: 64, channels: 3, background: '#ff0000' },
          })
            .png()
            .toBuffer(),
          left: 32,
          top: 32,
        },
      ])
      .png()
      .toBuffer();
    const masks = await this.segment(
      image,
      { prompt: 'red square', box: { x: 30, y: 30, width: 68, height: 68 }, maxMasks: 1 },
      signal,
    );
    if (!masks.length)
      throw new ProviderError('fal 已响应，但测试图片未返回蒙版，尚未确认完整分割链路。');
    return {
      message: 'fal 鉴权与真实 SAM 3 分割调用成功，已返回测试图像素蒙版；本次测试已预留 0.05 元。',
    };
  }
}
