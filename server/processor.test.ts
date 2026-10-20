import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candidate, StoredAsset, StoredJob } from '../shared/contracts';
import {
  decodeMask,
  decodeRgba,
  emptyMask,
  encodeMask,
  encodeRgba,
  fullMask,
  type RgbaImage,
} from './imaging';
import { processJob, type ProcessContext } from './processor';

const calls = vi.hoisted(() => ({
  analyze: vi.fn(),
  segment: vi.fn(),
  repair: vi.fn(),
}));
vi.mock('./providers/index', () => ({
  DeepSeekService: class {
    analyze = calls.analyze;
  },
  FalService: class {
    segment = calls.segment;
    repair = calls.repair;
  },
}));

const temporary: string[] = [];
const candidate = (id: string, x = 0, kind: 'cutout' | 'rectangle' = 'cutout'): Candidate => ({
  id,
  label: `设计 ${id}`,
  kind,
  prompt: `complete design ${id}`,
  bounds: { x, y: 2, width: 10, height: 10 },
});
const asset = (item: Candidate): StoredAsset => ({
  ...item,
  candidate: item,
  status: 'pending',
  warnings: [],
});

function solid(width: number, height: number, color = [20, 80, 140, 255]): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(color, offset);
  return { width, height, data };
}

function designMask() {
  const mask = emptyMask({ width: 10, height: 10 });
  for (let y = 2; y < 8; y++) {
    for (let x = 2; x < 8; x++) mask.data[y * 10 + x] = 255;
  }
  return mask;
}

function edgeWatermark(item: StoredAsset): StoredAsset {
  item.correction = {
    strokes: [
      {
        mode: 'add',
        radius: 0.1,
        points: [{ x: item.bounds.x + 2, y: item.bounds.y + 5 }],
      },
    ],
  };
  return item;
}

async function context(assets?: StoredAsset[]): Promise<ProcessContext> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-processor-'));
  temporary.push(directory);
  const sourcePath = path.join(directory, 'source.png');
  await writeFile(sourcePath, await encodeRgba(solid(40, 20)));
  const job: StoredJob = {
    id: 'job',
    ownerId: 'owner',
    filename: 'source.png',
    sourcePath,
    width: 40,
    height: 20,
    originalUrl: '',
    status: 'queued',
    stage: '',
    createdAt: Date.now(),
    expiresAt: Date.now() + 1000,
    spentCny: 0,
    budgetCny: 10,
    assets: assets ?? [],
    warnings: [],
    ...(assets
      ? { analysis: { assets: assets.map((item) => item.candidate), watermarks: [], warnings: [] } }
      : {}),
  };
  return {
    job,
    config: {
      deepseekKey: 'test-only',
      falKey: 'test-only',
      deepseekEnabled: true,
      falEnabled: true,
      budgetCny: 10,
    },
    signal: new AbortController().signal,
    save: vi.fn(),
    reserve: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.analyze.mockResolvedValue({ assets: [candidate('one', 2)], watermarks: [], warnings: [] });
  calls.segment.mockImplementation(async (input: Buffer) => {
    const image = await decodeRgba(input);
    return [{ mask: await encodeMask(fullMask(image)), score: 0.95 }];
  });
  calls.repair.mockImplementation(async (input: Buffer) => {
    const original = await decodeRgba(input);
    return encodeRgba(solid(original.width, original.height, [220, 30, 10, 255]));
  });
});

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => {
      const resolved = path.resolve(directory);
      const parent = path.resolve(os.tmpdir());
      if (
        path.dirname(resolved) !== parent ||
        !path.basename(resolved).startsWith('factory-processor-')
      ) {
        throw new Error('Refusing cleanup outside this test’s generated temporary directory.');
      }
      return rm(resolved, { recursive: true, force: true });
    }),
  );
});

describe('actual image processor orchestration with mocked paid services', () => {
  it('creates original-resolution PNGs with review status and opaque local filenames', async () => {
    const ctx = await context();
    calls.analyze.mockResolvedValue({
      assets: [candidate('../../provider/path', 2, 'rectangle')],
      watermarks: [],
      warnings: ['分析提示'],
    });
    await processJob(ctx);
    const result = ctx.job.assets[0];
    expect(result.status).toBe('review');
    expect(result.width).toBe(10);
    expect(result.height).toBe(10);
    expect(path.dirname(result.pngPath!)).toBe(path.dirname(ctx.job.sourcePath));
    expect(path.basename(result.pngPath!)).not.toContain('provider');
    expect(calls.segment).not.toHaveBeenCalled();
    expect(calls.repair).not.toHaveBeenCalled();
    expect(ctx.job.status).toBe('review');
    const png = await decodeRgba(await readFile(result.pngPath!));
    expect(png.data).toEqual(solid(10, 10).data);
  });

  it('does not use a rectangle as a watermark mask or claim that watermark repair succeeded', async () => {
    const ctx = await context([asset(candidate('one', 2, 'rectangle'))]);
    ctx.job.analysis!.watermarks = [
      {
        bounds: { x: 3, y: 3, width: 6, height: 6 },
        confidence: 'high',
        description: '重复署名水印',
      },
    ];
    await processJob(ctx);
    expect(calls.repair).not.toHaveBeenCalled();
    expect(ctx.job.assets[0].status).toBe('review');
    expect(ctx.job.assets[0].warnings.join(' ')).toContain('未取得可信的细水印蒙版');
    const mask = await decodeMask(await readFile(ctx.job.assets[0].watermarkPath!), {
      width: 10,
      height: 10,
    });
    expect(mask.data.every((value) => value === 0)).toBe(true);
  });

  it('applies a fine repair mask and preserves every other original RGB pixel', async () => {
    const ctx = await context([asset(candidate('one', 2, 'rectangle'))]);
    ctx.job.analysis!.watermarks = [
      {
        bounds: { x: 3, y: 3, width: 6, height: 6 },
        confidence: 'high',
        description: '细文字水印',
      },
    ];
    calls.segment.mockImplementation(async (input: Buffer) => {
      const mask = emptyMask(await decodeRgba(input));
      mask.data[1 * mask.width + 1] = 255;
      mask.data[3 * mask.width + 4] = 255;
      return [{ mask: await encodeMask(mask), score: 0.95 }];
    });
    await processJob(ctx);
    expect(calls.repair).toHaveBeenCalledOnce();
    const result = ctx.job.assets[0];
    const output = await decodeRgba(await readFile(result.pngPath!));
    const mask = await decodeMask(await readFile(result.watermarkPath!), output);
    for (let index = 0; index < mask.data.length; index++) {
      expect([...output.data.subarray(index * 4, index * 4 + 3)]).toEqual(
        mask.data[index] ? [220, 30, 10] : [20, 80, 140],
      );
    }
    expect(result.warnings.join(' ')).toContain('推断恢复');
    expect(result.status).toBe('review');
  });

  it('refuses a repair mask that covers more than 25% of the foreground', async () => {
    const ctx = await context([asset(candidate('one', 2, 'rectangle'))]);
    ctx.job.analysis!.watermarks = [
      { bounds: ctx.job.assets[0].bounds, confidence: 'high', description: '水印' },
    ];
    calls.segment.mockImplementation(async (input: Buffer) => {
      const mask = emptyMask(await decodeRgba(input));
      for (let index = 0; index < mask.data.length; index += 2) mask.data[index] = 255;
      return [{ mask: await encodeMask(mask), score: 0.95 }];
    });
    await processJob(ctx);
    expect(calls.repair).not.toHaveBeenCalled();
    expect(ctx.job.assets[0].warnings.join(' ')).toContain('超过 25%');
  });

  it('continues other designs after one segmentation failure', async () => {
    const ctx = await context([
      asset(candidate('bad', 2)),
      asset(candidate('good', 20, 'rectangle')),
    ]);
    calls.segment.mockRejectedValue(new Error('分割失败'));
    await processJob(ctx);
    expect(ctx.job.assets.map((item) => item.status)).toEqual(['failed', 'review']);
    expect(ctx.job.assets[1].pngPath).toBeTruthy();
    expect(ctx.job.status).toBe('partial');
  });

  it('does not segment or repair a watermark that lies only on source-transparent pixels', async () => {
    const ctx = await context([asset(candidate('one', 2, 'rectangle'))]);
    const original = solid(40, 20);
    for (let y = 3; y < 9; y++) {
      for (let x = 3; x < 9; x++) original.data[(y * 40 + x) * 4 + 3] = 0;
    }
    await writeFile(ctx.job.sourcePath, await encodeRgba(original));
    ctx.job.analysis!.watermarks = [
      {
        bounds: { x: 3, y: 3, width: 6, height: 6 },
        confidence: 'high',
        description: '透明区水印',
      },
    ];
    await processJob(ctx);
    expect(calls.segment).not.toHaveBeenCalled();
    expect(calls.repair).not.toHaveBeenCalled();
    const output = await decodeRgba(await readFile(ctx.job.assets[0].pngPath!));
    expect(output.data[(1 * 10 + 1) * 4 + 3]).toBe(0);
    expect(output.data[3]).toBe(255);
  });

  it('keeps completed assets when the budget fails and propagates the budget error', async () => {
    const ctx = await context([
      asset(candidate('first', 2, 'rectangle')),
      asset(candidate('second', 20)),
    ]);
    const budget = new Error('预算超出');
    budget.name = 'BudgetExceededError';
    calls.segment.mockRejectedValue(budget);
    await expect(processJob(ctx)).rejects.toBe(budget);
    expect(ctx.job.assets.map((item) => item.status)).toEqual(['review', 'pending']);
    expect(await readFile(ctx.job.assets[0].pngPath!)).toBeInstanceOf(Buffer);
  });

  it('propagates cancellation without losing previously completed PNGs', async () => {
    const ctx = await context([
      asset(candidate('first', 2, 'rectangle')),
      asset(candidate('second', 20)),
    ]);
    const controller = new AbortController();
    ctx.signal = controller.signal;
    calls.segment.mockImplementation(async () => {
      controller.abort();
      throw new DOMException('取消', 'AbortError');
    });
    await expect(processJob(ctx)).rejects.toHaveProperty('name', 'AbortError');
    expect(ctx.job.assets.map((item) => item.status)).toEqual(['review', 'pending']);
  });

  it('reprocesses only the selected asset using original-coordinate brush corrections', async () => {
    const ctx = await context([
      asset(candidate('selected', 2, 'rectangle')),
      asset(candidate('untouched', 20, 'rectangle')),
    ]);
    await processJob(ctx);
    const beforeOther = structuredClone(ctx.job.assets[1]);
    const beforePng = await readFile(beforeOther.pngPath!);
    ctx.job.assets[0].correction = {
      strokes: [{ mode: 'add', radius: 1, points: [{ x: 6, y: 6 }] }],
    };
    calls.segment.mockClear();
    await processJob(ctx, 'selected');
    expect(calls.segment).not.toHaveBeenCalled();
    expect(calls.repair).toHaveBeenCalledOnce();
    expect(ctx.job.assets[1]).toEqual(beforeOther);
    expect(await readFile(beforeOther.pngPath!)).toEqual(beforePng);
    const mask = await decodeMask(await readFile(ctx.job.assets[0].watermarkPath!), {
      width: 10,
      height: 10,
    });
    expect(mask.data[4 * 10 + 4]).toBe(255);
    expect(mask.data[0]).toBe(0);
  });

  it('unions separate candidates without splitting disconnected design elements', async () => {
    const ctx = await context([asset(candidate('design', 2)), asset(candidate('lettering', 20))]);
    ctx.job.assets[0].correction = { mergeIds: ['lettering'] };
    await processJob(ctx, 'design');
    const merged = ctx.job.assets[0];
    expect(merged.bounds).toEqual({ x: 2, y: 2, width: 28, height: 10 });
    expect(ctx.job.assets[1].status).toBe('deleted');
    const mask = await decodeMask(await readFile(merged.alphaPath!), merged.bounds);
    expect(mask.data[15]).toBe(0);
    expect(mask.data[0]).toBe(255);
    expect(mask.data[27]).toBe(255);
  });

  it('keeps old dimensions, bounds and files together when a corrected retry fails', async () => {
    const ctx = await context([asset(candidate('one', 2, 'rectangle'))]);
    await processJob(ctx);
    const previous = structuredClone(ctx.job.assets[0]);
    const previousPng = await readFile(previous.pngPath!);
    ctx.job.assets[0].correction = {
      bounds: { x: 15, y: 0, width: 20, height: 18 },
      kind: 'cutout',
    };
    calls.segment.mockRejectedValue(new Error('修正分割失败'));
    await processJob(ctx, 'one');
    const current = ctx.job.assets[0];
    expect(current.bounds).toEqual(previous.bounds);
    expect(current.width).toBe(previous.width);
    expect(current.height).toBe(previous.height);
    expect(current.pngPath).toBe(previous.pngPath);
    expect(current.alphaPath).toBe(previous.alphaPath);
    expect(current.watermarkPath).toBe(previous.watermarkPath);
    expect(await readFile(current.pngPath!)).toEqual(previousPng);
    expect(current.error).toBe('修正分割失败');
    expect(current.status).toBe('review');
    expect(current.warnings.join(' ')).toContain('保留上一次结果');
  });

  it('includes review assets with errors in a whole-job retry and leaves normal review assets alone', async () => {
    const ctx = await context([
      asset(candidate('retry', 2, 'rectangle')),
      asset(candidate('keep', 20, 'rectangle')),
    ]);
    await processJob(ctx);
    const untouched = structuredClone(ctx.job.assets[1]);
    ctx.job.assets[0].correction = { kind: 'cutout' };
    calls.segment.mockRejectedValueOnce(new Error('首次重做失败'));
    await processJob(ctx, 'retry');
    expect(ctx.job.assets[0].status).toBe('review');
    expect(ctx.job.assets[0].error).toBe('首次重做失败');
    calls.segment.mockClear();
    await processJob(ctx);
    expect(calls.segment).toHaveBeenCalledOnce();
    expect(calls.analyze).not.toHaveBeenCalled();
    expect(ctx.job.assets[0].error).toBeUndefined();
    expect(ctx.job.assets[1]).toEqual(untouched);
  });

  it('keeps a failed review eligible for whole-job retry after budget interruption', async () => {
    const ctx = await context([asset(candidate('retry', 2, 'rectangle'))]);
    await processJob(ctx);
    ctx.job.assets[0].correction = { kind: 'cutout' };
    ctx.job.assets[0].error = '上次重做失败';
    const budget = new Error('预算不足');
    budget.name = 'BudgetExceededError';
    calls.segment.mockRejectedValueOnce(budget);
    await expect(processJob(ctx)).rejects.toBe(budget);
    expect(ctx.job.assets[0].error).toBe('上次重做失败');
    await processJob(ctx);
    expect(calls.segment).toHaveBeenCalledTimes(2);
    expect(ctx.job.assets[0].error).toBeUndefined();
  });

  it('segments a repaired contour exactly once and keeps unrelated alpha and unmasked RGB', async () => {
    const ctx = await context([edgeWatermark(asset(candidate('one', 2)))]);
    const initial = designMask();
    const refreshed = designMask();
    refreshed.data[5 * 10 + 2] = 0;
    refreshed.data[5 * 10 + 1] = 255;
    refreshed.data[7 * 10 + 7] = 0; // Unrelated model change must not be applied.
    calls.segment
      .mockResolvedValueOnce([{ mask: await encodeMask(initial), score: 0.95 }])
      .mockResolvedValueOnce([{ mask: await encodeMask(refreshed), score: 0.95 }]);
    await processJob(ctx, 'one');
    expect(calls.segment).toHaveBeenCalledTimes(2);
    expect(calls.repair).toHaveBeenCalledOnce();
    const output = await decodeRgba(await readFile(ctx.job.assets[0].pngPath!));
    const mask = await decodeMask(await readFile(ctx.job.assets[0].watermarkPath!), output);
    const contourInput = await decodeRgba(calls.segment.mock.calls[1][0]);
    for (let index = 0; index < mask.data.length; index++) {
      const expected = mask.data[index] ? [220, 30, 10] : [20, 80, 140];
      expect([...output.data.subarray(index * 4, index * 4 + 3)]).toEqual(expected);
      expect([...contourInput.data.subarray(index * 4, index * 4 + 3)]).toEqual(expected);
    }
    expect(output.data[(5 * 10 + 2) * 4 + 3]).toBe(0);
    expect(output.data[(5 * 10 + 1) * 4 + 3]).toBe(255);
    expect(output.data[(7 * 10 + 7) * 4 + 3]).toBe(255);
    expect(ctx.job.assets[0].warnings.join(' ')).toContain('额外分割一次');
    expect(ctx.job.assets[0].status).toBe('review');
  });

  it('follows automatic fine-watermark segmentation with one contour pass after successful repair', async () => {
    const ctx = await context([asset(candidate('one', 2))]);
    ctx.job.analysis!.watermarks = [
      {
        bounds: { x: 3, y: 3, width: 6, height: 6 },
        confidence: 'high',
        description: '贴着人物边缘的细水印',
      },
    ];
    const watermark = emptyMask({ width: 6, height: 6 });
    watermark.data[4 * 6 + 1] = 255; // Original (4, 7), crop contour (2, 5).
    const silhouette = await encodeMask(designMask());
    calls.segment
      .mockResolvedValueOnce([{ mask: silhouette, score: 0.95 }])
      .mockResolvedValueOnce([{ mask: await encodeMask(watermark), score: 0.95 }])
      .mockResolvedValueOnce([{ mask: silhouette, score: 0.95 }]);
    await processJob(ctx);
    expect(calls.segment).toHaveBeenCalledTimes(3);
    expect(calls.repair).toHaveBeenCalledOnce();
    expect(calls.segment.mock.calls[1][1].prompt).toContain('Only the translucent');
    expect(calls.segment.mock.calls[2][1].prompt).toBe(calls.segment.mock.calls[0][1].prompt);
    expect(ctx.job.assets[0].warnings.join(' ')).toContain('额外分割一次');
  });

  it('does not make a follow-up segmentation for an interior watermark', async () => {
    const item = asset(candidate('one', 2));
    item.correction = { strokes: [{ mode: 'add', radius: 0.1, points: [{ x: 7, y: 7 }] }] };
    const ctx = await context([item]);
    calls.segment.mockResolvedValue([{ mask: await encodeMask(designMask()), score: 0.95 }]);
    await processJob(ctx, 'one');
    expect(calls.repair).toHaveBeenCalledOnce();
    expect(calls.segment).toHaveBeenCalledOnce();
  });

  it('does not resegment a touched contour when repair itself failed', async () => {
    const ctx = await context([edgeWatermark(asset(candidate('one', 2)))]);
    calls.segment.mockResolvedValue([{ mask: await encodeMask(designMask()), score: 0.95 }]);
    calls.repair.mockRejectedValue(new Error('修复请求失败'));
    await processJob(ctx, 'one');
    expect(calls.segment).toHaveBeenCalledOnce();
    expect(ctx.job.assets[0].warnings.join(' ')).toContain('水印修复未完成');
  });

  it.each(['request', 'misaligned', 'low-score', 'different-object'] as const)(
    'keeps the original contour in review after a %s follow-up failure without retrying',
    async (failure) => {
      const ctx = await context([edgeWatermark(asset(candidate('one', 2)))]);
      const initial = designMask();
      calls.segment.mockResolvedValueOnce([{ mask: await encodeMask(initial), score: 0.95 }]);
      if (failure === 'request') calls.segment.mockRejectedValueOnce(new Error('队列响应未知'));
      else
        calls.segment.mockResolvedValueOnce([
          {
            mask: await encodeMask(
              failure === 'misaligned'
                ? fullMask({ width: 20, height: 5 })
                : failure === 'different-object'
                  ? fullMask(initial)
                  : initial,
            ),
            score: failure === 'low-score' ? 0.2 : 0.95,
          },
        ]);
      await processJob(ctx, 'one');
      expect(calls.segment).toHaveBeenCalledTimes(2);
      const result = ctx.job.assets[0];
      expect(await decodeMask(await readFile(result.alphaPath!), initial)).toEqual(initial);
      expect(result.status).toBe('review');
      expect(result.warnings.join(' ')).toContain('轮廓重分割未通过');
    },
  );

  it.each(['BudgetExceededError', 'AbortError'])(
    'propagates %s from contour follow-up and keeps previous completed assets',
    async (name) => {
      const ctx = await context([
        asset(candidate('completed', 20, 'rectangle')),
        edgeWatermark(asset(candidate('one', 2))),
      ]);
      calls.segment.mockResolvedValueOnce([{ mask: await encodeMask(designMask()), score: 0.95 }]);
      const error = new Error('额外分割中断');
      error.name = name;
      calls.segment.mockRejectedValueOnce(error);
      await expect(processJob(ctx)).rejects.toBe(error);
      expect(calls.segment).toHaveBeenCalledTimes(2);
      expect(ctx.job.assets[0].status).toBe('review');
      expect(await readFile(ctx.job.assets[0].pngPath!)).toBeInstanceOf(Buffer);
      expect(ctx.job.assets[1].status).toBe('pending');
    },
  );

  it('preserves a reviewable original cutout when a repair call fails', async () => {
    const ctx = await context([asset(candidate('one', 2, 'rectangle'))]);
    ctx.job.assets[0].correction = {
      strokes: [{ mode: 'add', radius: 1, points: [{ x: 6, y: 6 }] }],
    };
    calls.repair.mockRejectedValue(new Error('服务暂时不可用'));
    await processJob(ctx, 'one');
    expect(ctx.job.assets[0].status).toBe('review');
    expect(ctx.job.assets[0].warnings.join(' ')).toContain('水印修复未完成');
    expect((await decodeRgba(await readFile(ctx.job.assets[0].pngPath!))).data).toEqual(
      solid(10, 10).data,
    );
  });
});
