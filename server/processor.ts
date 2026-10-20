import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Bounds, RuntimeConfig, StoredAsset, StoredJob } from '../shared/contracts';
import { DeepSeekService, FalService } from './providers/index';
import {
  affectedContour,
  applyAlpha,
  applyMaskStrokes,
  clipBounds,
  compositeRepair,
  cropRgba,
  decodeMask,
  decodeRgba,
  emptyMask,
  encodeMask,
  encodeRgba,
  fullMask,
  intersectBounds,
  intersectMasks,
  maskSummary,
  replaceMaskRegion,
  unionBounds,
  unionMasks,
  visibleForeground,
  type ImageMask,
  type RgbaImage,
} from './imaging';

export interface ProcessContext {
  job: StoredJob;
  config: RuntimeConfig;
  signal: AbortSignal;
  save: (job: StoredJob) => void;
  reserve: (amountCny: number, label: string) => void | Promise<void>;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('任务已取消，已完成结果保留。', 'AbortError');
}

function isFatal(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'BudgetExceededError'))
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '图像处理服务返回未知错误。';
}

function resolvedBounds(asset: StoredAsset, image: RgbaImage): Bounds {
  const bounds = clipBounds(
    asset.correction?.bounds ?? asset.bounds ?? asset.candidate.bounds,
    image,
  );
  if (!bounds) throw new Error('该素材的识别框为空或超出原图，请补框后重试。');
  return bounds;
}

function sameBounds(a: Bounds, b: Bounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function chooseMask(masks: { mask: ImageMask; score?: number }[]): {
  mask: ImageMask;
  score?: number;
} {
  const nonempty = masks.filter((item) => maskSummary(item.mask).pixels > 0);
  if (!nonempty.length) throw new Error('分割模型没有返回有效像素蒙版，请修正框或合并后重试。');
  return nonempty.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
}

async function segmentPart(
  asset: StoredAsset,
  original: RgbaImage,
  bounds: Bounds,
  fal: FalService,
  signal: AbortSignal,
  reuse: boolean,
  warnings: string[],
): Promise<ImageMask> {
  const kind = asset.correction?.kind ?? asset.kind;
  if (kind === 'rectangle') return fullMask(bounds);
  if (reuse && asset.alphaPath && sameBounds(bounds, asset.bounds)) {
    try {
      return await decodeMask(await readFile(asset.alphaPath), bounds);
    } catch (error) {
      warnings.push(`旧人物蒙版无法复用，将重新分割：${errorText(error)}`);
    }
  }
  const crop = cropRgba(original, bounds);
  const outputs = await fal.segment(
    await encodeRgba(crop),
    {
      prompt:
        asset.candidate.prompt ||
        `the complete ${asset.correction?.label ?? asset.label}, including its detached accessories and lettering`,
      box: { x: 0, y: 0, width: bounds.width, height: bounds.height },
      maxMasks: 1,
    },
    signal,
  );
  checkAbort(signal);
  const masks = await Promise.all(
    outputs.map(async (item) => ({
      mask: await decodeMask(item.mask, bounds),
      score: item.score,
    })),
  );
  const selected = chooseMask(masks);
  if (selected.score !== undefined && selected.score < 0.8) {
    warnings.push('人物分割置信度偏低，请检查耳朵、手脚、文字及离散配件是否完整。');
  }
  if (maskSummary(selected.mask).pixels / (bounds.width * bounds.height) > 0.98) {
    warnings.push('人物蒙版几乎覆盖整个识别框，请检查是否仍保留了背景。');
  }
  return selected.mask;
}

async function findWatermarkMask(
  ctx: ProcessContext,
  original: RgbaImage,
  asset: StoredAsset,
  bounds: Bounds,
  foreground: ImageMask,
  fal: FalService,
  warnings: string[],
  reuse: boolean,
): Promise<ImageMask> {
  let result = emptyMask(bounds);
  if (reuse && asset.watermarkPath && sameBounds(bounds, asset.bounds)) {
    try {
      const previous = await decodeMask(await readFile(asset.watermarkPath), asset.bounds);
      result = unionMasks([{ mask: previous, bounds: asset.bounds }], bounds);
      return applyMaskStrokes(result, bounds, asset.correction?.strokes ?? []);
    } catch (error) {
      warnings.push(`旧水印蒙版无法复用，将重新定位：${errorText(error)}`);
    }
  }
  for (const region of ctx.job.analysis?.watermarks ?? []) {
    checkAbort(ctx.signal);
    const candidate = clipBounds(region.bounds, original);
    const overlap = candidate && intersectBounds(candidate, bounds);
    if (!overlap) continue;
    const regionSupport = unionMasks([{ mask: fullMask(overlap), bounds: overlap }], bounds);
    if (!maskSummary(intersectMasks(regionSupport, foreground)).pixels) continue;
    if (region.confidence === 'low') {
      warnings.push(
        `水印位置不确定，未自动修复：${region.description}。可在预览中涂抹水印后重试。`,
      );
      continue;
    }
    ctx.job.status = 'segmenting';
    ctx.job.stage = `精确定位「${asset.label}」中的水印笔画`;
    ctx.save(ctx.job);
    try {
      const encoded = await encodeRgba(cropRgba(original, overlap));
      const outputs = await fal.segment(
        encoded,
        {
          prompt: `Only the translucent overlaid watermark glyphs and strokes: ${region.description}. Exclude the background and original artwork.`,
          box: { x: 0, y: 0, width: overlap.width, height: overlap.height },
          maxMasks: 16,
        },
        ctx.signal,
      );
      checkAbort(ctx.signal);
      const accepted: { mask: ImageMask; bounds: Bounds }[] = [];
      for (const output of outputs) {
        const mask = await decodeMask(output.mask, overlap);
        const summary = maskSummary(mask);
        if (!summary.pixels) continue;
        const fraction = summary.pixels / (overlap.width * overlap.height);
        // These are conservative refusal rules, not a claimed quality score.
        if (
          (output.score !== undefined && output.score < 0.75) ||
          fraction > 0.65 ||
          (summary.density > 0.94 && fraction > 0.1)
        )
          continue;
        accepted.push({ mask, bounds: overlap });
      }
      if (!accepted.length) {
        warnings.push(
          `未取得可信的细水印蒙版，已保留原像素：${region.description}。请涂抹水印后单独重试。`,
        );
        continue;
      }
      result = unionMasks([{ mask: result, bounds }, ...accepted], bounds);
    } catch (error) {
      if (isFatal(error, ctx.signal)) throw error;
      warnings.push(`水印精确定位失败，未用矩形代替水印蒙版：${errorText(error)}`);
    }
  }
  if (!ctx.job.analysis?.watermarks.length) {
    warnings.push('视觉分析未定位到明确水印区域；这不代表已经确认无水印，请检查原图对应位置。');
  }
  return applyMaskStrokes(result, bounds, asset.correction?.strokes ?? []);
}

async function refineRepairedContour(
  ctx: ProcessContext,
  crop: RgbaImage,
  foreground: ImageMask,
  affected: ImageMask,
  parts: StoredAsset[],
  fal: FalService,
  warnings: string[],
): Promise<ImageMask> {
  checkAbort(ctx.signal);
  ctx.job.status = 'segmenting';
  ctx.job.stage = `水印修复后重新检查「${parts[0].label}」的受影响轮廓（最多一次）`;
  ctx.save(ctx.job);
  try {
    // This is one deliberate follow-up on changed pixels, never a loop or a
    // resubmission after a failed/unknown paid request.
    const outputs = await fal.segment(
      await encodeRgba(crop),
      {
        prompt: parts
          .map((part) => part.candidate.prompt || `the complete ${part.label}`)
          .join('; ')
          .slice(0, 1000),
        box: { x: 0, y: 0, width: crop.width, height: crop.height },
        maxMasks: 1,
      },
      ctx.signal,
    );
    checkAbort(ctx.signal);
    const selected = chooseMask(
      await Promise.all(
        outputs.map(async (item) => ({
          mask: await decodeMask(item.mask, crop),
          score: item.score,
        })),
      ),
    );
    if (selected.score !== undefined && selected.score < 0.8) {
      throw new Error('修复后分割置信度不足。');
    }
    let overlap = 0;
    let union = 0;
    for (let index = 0; index < foreground.data.length; index++) {
      const before = foreground.data[index] > 0;
      const after = selected.mask.data[index] > 0;
      if (before || after) union++;
      if (before && after) overlap++;
    }
    if (!union || overlap / union < 0.7) throw new Error('修复后分割与原设计差异过大。');
    const refined = replaceMaskRegion(foreground, selected.mask, affected);
    if (!maskSummary(visibleForeground(refined, crop)).pixels)
      throw new Error('修复后轮廓没有可见像素。');
    warnings.push(
      '水印曾触及人物轮廓；修复成功后已额外分割一次，仅更新受影响轮廓附近的 alpha，仍需人工核对。',
    );
    return refined;
  } catch (error) {
    if (isFatal(error, ctx.signal)) throw error;
    warnings.push(
      `修复后的轮廓重分割未通过，保留原人物蒙版并转人工复核；未再次提交计费请求：${errorText(error)}`,
    );
    return foreground;
  }
}

async function processAsset(
  ctx: ProcessContext,
  original: RgbaImage,
  asset: StoredAsset,
  fal: FalService,
  isReprocess: boolean,
): Promise<void> {
  const warnings = [
    '这是模型生成的待复核结果，尚未人工验收；请对照原图检查完整设计、透明边缘及水印残留。',
  ];
  const mergeIds = [...new Set(asset.correction?.mergeIds ?? [])].filter((id) => id !== asset.id);
  const parts = [
    asset,
    ...mergeIds.map((id) => {
      const other = ctx.job.assets.find((item) => item.id === id);
      if (!other) throw new Error('要合并的素材不存在，请刷新后重新选择。');
      return other;
    }),
  ];
  const partBounds = parts.map((part) => resolvedBounds(part, original));
  const bounds = unionBounds(partBounds);
  const manualWatermark = Boolean(isReprocess && asset.correction?.strokes?.length);
  const masks: { mask: ImageMask; bounds: Bounds }[] = [];
  for (let index = 0; index < parts.length; index++) {
    checkAbort(ctx.signal);
    ctx.job.status = 'segmenting';
    ctx.job.stage = `提取完整设计「${parts[index].label}」`;
    ctx.save(ctx.job);
    const mask = await segmentPart(
      parts[index],
      original,
      partBounds[index],
      fal,
      ctx.signal,
      index > 0 || manualWatermark,
      warnings,
    );
    masks.push({ mask, bounds: partBounds[index] });
  }
  let foreground = unionMasks(masks, bounds);
  let crop = cropRgba(original, bounds);
  const visible = visibleForeground(foreground, crop);
  const foregroundPixels = maskSummary(visible).pixels;
  if (!foregroundPixels)
    throw new Error('该识别框没有提取到可见的前景像素，请检查原图透明度并重新补框。');
  let watermark = await findWatermarkMask(
    ctx,
    original,
    asset,
    bounds,
    visible,
    fal,
    warnings,
    manualWatermark,
  );
  // A watermark outside the retained foreground is removed by transparency.
  watermark = intersectMasks(watermark, visible);
  const watermarkPixels = maskSummary(watermark).pixels;
  if (watermarkPixels > foregroundPixels * 0.25) {
    warnings.push(
      '水印蒙版覆盖了超过 25% 的素材前景，已拒绝自动修复以免重画人物。请擦除多余蒙版后重试。',
    );
  } else if (watermarkPixels > 0) {
    ctx.job.status = 'repairing';
    ctx.job.stage = `局部修复「${asset.label}」中的水印`;
    ctx.save(ctx.job);
    let repairedSuccessfully = false;
    try {
      const repaired = await fal.repair(
        await encodeRgba(crop),
        await encodeMask(watermark),
        ctx.signal,
      );
      checkAbort(ctx.signal);
      crop = compositeRepair(crop, await decodeRgba(repaired), watermark);
      repairedSuccessfully = true;
      warnings.push(
        '已仅在细水印蒙版内应用模型修复；覆盖五官或线条的内容属于推断恢复，需人工检查。',
      );
    } catch (error) {
      if (isFatal(error, ctx.signal)) throw error;
      warnings.push(`水印修复未完成，已保留该素材原有像素：${errorText(error)}`);
    }
    if (repairedSuccessfully) {
      const cutoutParts = masks.filter(
        (_, index) => (parts[index].correction?.kind ?? parts[index].kind) === 'cutout',
      );
      const rectangleParts = masks.filter(
        (_, index) => (parts[index].correction?.kind ?? parts[index].kind) === 'rectangle',
      );
      const cutoutWatermark = intersectMasks(watermark, unionMasks(cutoutParts, bounds));
      const affected = affectedContour(visible, cutoutWatermark);
      if (maskSummary(affected).pixels) {
        foreground = await refineRepairedContour(
          ctx,
          crop,
          foreground,
          affected,
          parts,
          fal,
          warnings,
        );
        // Explicit rectangle assets retain their whole crop even in a merged design.
        foreground = unionMasks([{ mask: foreground, bounds }, ...rectangleParts], bounds);
      }
    }
  }
  checkAbort(ctx.signal);
  ctx.job.status = 'rendering';
  ctx.job.stage = `生成「${asset.label}」的原尺寸 PNG`;
  ctx.save(ctx.job);
  const [png, alpha, watermarkPng] = await Promise.all([
    encodeRgba(applyAlpha(crop, foreground)),
    encodeMask(foreground),
    encodeMask(watermark),
  ]);
  checkAbort(ctx.signal);
  // All destinations derive from our job directory and opaque local identifiers.
  // Provider URLs, filenames, labels and candidate IDs never become file paths.
  const stem = `${createHash('sha256').update(asset.id).digest('hex').slice(0, 24)}-${randomUUID()}`;
  const directory = path.dirname(ctx.job.sourcePath);
  const pngPath = path.join(directory, `${stem}.png`);
  const alphaPath = path.join(directory, `${stem}-alpha.png`);
  const watermarkPath = path.join(directory, `${stem}-watermark.png`);
  await Promise.all([
    writeFile(pngPath, png),
    writeFile(alphaPath, alpha),
    writeFile(watermarkPath, watermarkPng),
  ]);
  checkAbort(ctx.signal);
  Object.assign(asset, {
    label: asset.correction?.label ?? asset.label,
    kind: asset.correction?.kind ?? asset.kind,
    bounds,
    width: bounds.width,
    height: bounds.height,
    pngPath,
    alphaPath,
    watermarkPath,
    warnings,
    error: undefined,
    status: 'review',
  });
  for (const merged of parts.slice(1)) {
    merged.status = 'deleted';
    merged.warnings = [...merged.warnings, `已合并到「${asset.label}」，原文件保留至任务清理。`];
  }
  ctx.save(ctx.job);
}

export async function processJob(ctx: ProcessContext, onlyAssetId?: string): Promise<void> {
  checkAbort(ctx.signal);
  if (
    !ctx.config.deepseekEnabled ||
    !ctx.config.deepseekKey ||
    !ctx.config.falEnabled ||
    !ctx.config.falKey
  ) {
    throw new Error('管理员尚未启用并配置 DeepSeek 与图像处理服务。');
  }
  const source = await readFile(ctx.job.sourcePath);
  const original = await decodeRgba(source);
  if (original.width !== ctx.job.width || original.height !== ctx.job.height) {
    throw new Error('原图尺寸记录不一致，已停止以免坐标错位。');
  }
  const deepseek = new DeepSeekService(ctx.config.deepseekKey, ctx.reserve);
  const fal = new FalService(ctx.config.falKey, ctx.reserve);
  if (!ctx.job.analysis && !onlyAssetId) {
    ctx.job.status = 'analyzing';
    ctx.job.stage = '理解整张拼图，定位完整设计与水印';
    ctx.save(ctx.job);
    const analysis = await deepseek.analyze(
      source,
      { width: original.width, height: original.height },
      ctx.signal,
    );
    checkAbort(ctx.signal);
    ctx.job.analysis = analysis;
    ctx.job.warnings = [...ctx.job.warnings, ...analysis.warnings];
    ctx.job.assets = analysis.assets.map((candidate) => ({
      ...candidate,
      candidate,
      status: 'pending',
      warnings: [],
    }));
    ctx.save(ctx.job);
  }
  const targets = onlyAssetId
    ? ctx.job.assets.filter((asset) => asset.id === onlyAssetId && asset.status !== 'deleted')
    : ctx.job.assets.filter(
        (asset) =>
          asset.status !== 'deleted' &&
          (Boolean(asset.error) || !['ready', 'review'].includes(asset.status)),
      );
  if (!targets.length)
    throw new Error(
      onlyAssetId ? '未找到要重试的素材。' : '未识别到可提取的完整设计，请手动补框。',
    );
  for (const asset of targets) {
    if (asset.status === 'deleted') continue; // An earlier corrected asset may have merged it.
    checkAbort(ctx.signal);
    const previousStatus = asset.status;
    const previousError = asset.error;
    asset.status = 'processing';
    asset.error = undefined;
    ctx.save(ctx.job);
    try {
      await processAsset(ctx, original, asset, fal, Boolean(onlyAssetId));
    } catch (error) {
      if (isFatal(error, ctx.signal)) {
        asset.status = asset.pngPath
          ? previousStatus === 'ready'
            ? 'ready'
            : 'review'
          : 'pending';
        asset.error = previousError ?? errorText(error);
        ctx.save(ctx.job);
        throw error;
      }
      asset.status = asset.pngPath ? 'review' : 'failed';
      asset.error = errorText(error);
      if (asset.pngPath)
        asset.warnings = [...asset.warnings, `本次重试失败，保留上一次结果：${asset.error}`];
      ctx.save(ctx.job);
    }
  }
  const active = ctx.job.assets.filter((asset) => asset.status !== 'deleted');
  const successful = active.filter((asset) => asset.pngPath).length;
  const failed = active.filter((asset) => asset.status === 'failed' || asset.error).length;
  ctx.job.status = failed ? (successful ? 'partial' : 'failed') : 'review';
  ctx.job.stage = failed
    ? `${successful} 个结果已保留，${failed} 个素材需单独重试`
    : `${successful} 个素材等待人工复核`;
  ctx.job.error = successful ? undefined : '没有生成可用结果，请修正识别框后重试。';
  ctx.save(ctx.job);
}
