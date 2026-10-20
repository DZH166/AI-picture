import type {
  Bounds,
  Cutout,
  LocalSegmentationResult,
  PixelMask,
  Raster,
  SegmentationOptions,
} from '../types';

/** Limits apply before allocating the segmentation work buffers. */
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_CUTOUTS = 256;
const MAX_OUTPUT_PIXELS = MAX_IMAGE_PIXELS;
const MAX_EDGE_SAMPLES = 8192;

type Dimensions = Pick<Raster, 'width' | 'height'>;
type Color = [number, number, number];
type Component = Bounds & { label: number };

function validateDimensions(size: Dimensions, name: string): number {
  if (
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new Error(`${name}的宽高必须是正整数。`);
  }
  const pixels = size.width * size.height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_IMAGE_PIXELS) {
    throw new Error(`${name}超过 1600 万像素，请先缩小图片。`);
  }
  return pixels;
}

function validateRaster(image: Raster): number {
  const pixels = validateDimensions(image, '图片');
  if (!(image.data instanceof Uint8ClampedArray) || image.data.length !== pixels * 4) {
    throw new Error('图片数据必须是与宽高匹配的 RGBA 像素数组。');
  }
  return pixels;
}

function validateOptions(options: SegmentationOptions): void {
  if (!Number.isFinite(options.tolerance) || options.tolerance < 0 || options.tolerance > 255) {
    throw new Error('背景容差必须在 0–255 之间。');
  }
  if (
    !Number.isSafeInteger(options.minArea) ||
    options.minArea < 1 ||
    options.minArea > MAX_IMAGE_PIXELS
  ) {
    throw new Error('最小面积必须是 1–16000000 之间的整数像素数。');
  }
}

function borderSamples(image: Raster): Color[] {
  const { width, height, data } = image;
  const perimeter = height === 1 ? width : width === 1 ? height : 2 * width + 2 * height - 4;
  const step = Math.max(1, Math.ceil(perimeter / MAX_EDGE_SAMPLES));
  const samples: Color[] = [];
  for (let edge = 0; edge < perimeter; edge += step) {
    let pixel: number;
    if (height === 1) pixel = edge;
    else if (width === 1) pixel = edge * width;
    else if (edge < width) pixel = edge;
    else if (edge < 2 * width) {
      pixel = (height - 1) * width + edge - width;
    } else {
      const side = edge - 2 * width;
      pixel = (1 + Math.floor(side / 2)) * width + (side % 2 === 0 ? 0 : width - 1);
    }
    const offset = pixel * 4;
    // Nearly transparent edge colors are not a reliable background sample.
    if (data[offset + 3] >= 128) {
      samples.push([data[offset], data[offset + 1], data[offset + 2]]);
    }
  }
  return samples;
}

/** RMS RGB distance keeps the public tolerance in the promised 0–255 range. */
function distanceSquared(r: number, g: number, b: number, color: Color): number {
  return ((r - color[0]) ** 2 + (g - color[1]) ** 2 + (b - color[2]) ** 2) / 3;
}

function estimateBackground(samples: Color[]): Color {
  if (samples.length === 0) return [255, 255, 255];
  const bins = new Map<number, Color[]>();
  let largest: Color[] = [];
  for (const color of samples) {
    const key =
      (Math.floor(color[0] / 16) << 8) |
      (Math.floor(color[1] / 16) << 4) |
      Math.floor(color[2] / 16);
    let bin = bins.get(key);
    if (!bin) {
      bin = [];
      bins.set(key, bin);
    }
    bin.push(color);
    if (bin.length > largest.length) largest = bin;
  }
  // A majority border color is more robust than an average, which mixes in
  // foreground objects touching the edge and can invent a nonexistent color.
  return [0, 1, 2].map((channel) => {
    const values = largest.map((color) => color[channel]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  }) as Color;
}

/**
 * Local, non-AI segmentation for a solid background.
 *
 * Existing fully transparent pixels mean the input alpha is authoritative:
 * only alpha-connected regions are extracted, without erasing opaque colors.
 * Otherwise, only color-matching background connected to an image edge is
 * erased. This preserves white interiors surrounded by a character outline.
 * Foreground uses 8-neighbor connectivity; background uses 4-neighbor
 * connectivity to avoid leaking through diagonally connected outlines.
 */
export function segmentSolidBackground(
  image: Raster,
  options: SegmentationOptions,
): LocalSegmentationResult {
  const pixels = validateRaster(image);
  validateOptions(options);
  const { width, height, data } = image;
  const samples = borderSamples(image);
  const background = estimateBackground(samples);
  const warnings = [
    '本地试提取按像素连通区域生成候选，并非 AI 人物识别；相连的人物可能合并，离散配件可能独立成图。',
  ];
  let usesExistingAlpha = false;
  for (let pixel = 0; pixel < pixels; pixel++) {
    if (data[pixel * 4 + 3] === 0) {
      usesExistingAlpha = true;
      break;
    }
  }

  const labels = new Int32Array(pixels);
  const queue = new Uint32Array(pixels);
  if (usesExistingAlpha) {
    warnings.push('检测到透明像素，已优先保留原有透明通道；背景容差不参与此次提取。');
    for (let pixel = 0; pixel < pixels; pixel++) {
      if (data[pixel * 4 + 3] === 0) labels[pixel] = -1;
    }
  } else {
    const threshold = options.tolerance ** 2;
    let matchingSamples = 0;
    for (const color of samples) {
      if (distanceSquared(...color, background) <= threshold) matchingSamples++;
    }
    if (samples.length === 0 || matchingSamples / samples.length < 0.7) {
      warnings.push(
        '图像边缘颜色不够一致，可能不是纯色背景；请逐个检查候选，复杂背景可能提取不完整。',
      );
    }
    warnings.push('仅移除与边缘连通的近似背景色；人物包围的背景孔洞与抗锯齿边缘需要检查。');
    for (let pixel = 0; pixel < pixels; pixel++) {
      const offset = pixel * 4;
      if (
        distanceSquared(data[offset], data[offset + 1], data[offset + 2], background) <= threshold
      ) {
        labels[pixel] = -2;
      }
    }

    let head = 0;
    let tail = 0;
    const enqueueBackground = (pixel: number) => {
      if (labels[pixel] === -2) {
        labels[pixel] = -1;
        queue[tail++] = pixel;
      }
    };
    for (let x = 0; x < width; x++) {
      enqueueBackground(x);
      enqueueBackground((height - 1) * width + x);
    }
    for (let y = 1; y < height - 1; y++) {
      enqueueBackground(y * width);
      enqueueBackground(y * width + width - 1);
    }
    while (head < tail) {
      const pixel = queue[head++];
      const x = pixel % width;
      if (x > 0) enqueueBackground(pixel - 1);
      if (x + 1 < width) enqueueBackground(pixel + 1);
      if (pixel >= width) enqueueBackground(pixel - width);
      if (pixel + width < pixels) enqueueBackground(pixel + width);
    }
    if (tail / pixels < 0.02) {
      warnings.push('可移除的背景不足图片面积的 2%；请确认图片边缘有足够的纯色背景。');
    }
    // Keep enclosed matching colors, such as white eyes or clothes.
    for (let pixel = 0; pixel < pixels; pixel++) {
      if (labels[pixel] === -2) labels[pixel] = 0;
    }
  }

  const components: Component[] = [];
  let nextLabel = 0;
  let filteredCount = 0;
  let limitedCount = 0;
  for (let start = 0; start < pixels; start++) {
    if (labels[start] !== 0) continue;
    const label = ++nextLabel;
    labels[start] = label;
    queue[0] = start;
    let head = 0;
    let tail = 1;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    while (head < tail) {
      const pixel = queue[head++];
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (
        let neighborY = Math.max(0, y - 1);
        neighborY <= Math.min(height - 1, y + 1);
        neighborY++
      ) {
        for (
          let neighborX = Math.max(0, x - 1);
          neighborX <= Math.min(width - 1, x + 1);
          neighborX++
        ) {
          const neighbor = neighborY * width + neighborX;
          if (labels[neighbor] === 0) {
            labels[neighbor] = label;
            queue[tail++] = neighbor;
          }
        }
      }
    }
    if (tail < options.minArea) {
      filteredCount++;
    } else if (components.length >= MAX_CUTOUTS) {
      limitedCount++;
    } else {
      components.push({
        label,
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      });
    }
  }
  components.sort((a, b) => a.y - b.y || a.x - b.x);
  const cutouts: Cutout[] = [];
  let outputPixels = 0;
  for (const component of components) {
    const croppedPixels = component.width * component.height;
    if (outputPixels + croppedPixels > MAX_OUTPUT_PIXELS) {
      limitedCount++;
      continue;
    }
    const cropped = new Uint8ClampedArray(croppedPixels * 4);
    for (let y = 0; y < component.height; y++) {
      for (let x = 0; x < component.width; x++) {
        const source = (component.y + y) * width + component.x + x;
        if (labels[source] !== component.label) continue;
        const destination = (y * component.width + x) * 4;
        cropped[destination] = data[source * 4];
        cropped[destination + 1] = data[source * 4 + 1];
        cropped[destination + 2] = data[source * 4 + 2];
        cropped[destination + 3] = data[source * 4 + 3];
      }
    }
    outputPixels += croppedPixels;
    cutouts.push({
      width: component.width,
      height: component.height,
      data: cropped,
      bounds: {
        x: component.x,
        y: component.y,
        width: component.width,
        height: component.height,
      },
    });
  }
  if (filteredCount > 0) {
    warnings.push(`已忽略 ${filteredCount} 个小于最小面积的区域；可降低最小面积后重新提取。`);
  }
  if (limitedCount > 0) {
    warnings.push(
      `受 256 个候选及 1600 万输出像素的内存限制，已跳过 ${limitedCount} 个区域；请分图处理。`,
    );
  }
  if (cutouts.length === 0) {
    warnings.push('没有找到符合条件的候选；图片可能为空白、全透明，或最小面积 / 容差过大。');
  }
  return { cutouts, background, warnings };
}

/** Composite an 8-bit mask with, rather than replace, the original alpha. */
export function applyMaskToRaster(image: Raster, mask: PixelMask): Raster {
  const pixels = validateRaster(image);
  if (
    mask.width !== image.width ||
    mask.height !== image.height ||
    !(mask.data instanceof Uint8Array) ||
    mask.data.length !== pixels
  ) {
    throw new Error('蒙版尺寸和像素数量必须与原图一致。');
  }
  const output = new Uint8ClampedArray(image.data);
  for (let pixel = 0; pixel < pixels; pixel++) {
    const offset = pixel * 4;
    output[offset + 3] = Math.round((image.data[offset + 3] * mask.data[pixel]) / 255);
    if (output[offset + 3] === 0) {
      output[offset] = 0;
      output[offset + 1] = 0;
      output[offset + 2] = 0;
    }
  }
  return { width: image.width, height: image.height, data: output };
}

/** Clip a source-space box, scale it outward, and return target pixel bounds. */
export function mapBoundsBetweenSizes(
  bounds: Bounds,
  source: Dimensions,
  target: Dimensions,
): Bounds | null {
  validateDimensions(source, '预览图');
  validateDimensions(target, '原图');
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
    throw new Error('选择区域坐标必须是有限数值。');
  }
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const left = Math.max(0, bounds.x);
  const top = Math.max(0, bounds.y);
  const right = Math.min(source.width, bounds.x + bounds.width);
  const bottom = Math.min(source.height, bounds.y + bounds.height);
  if (right <= left || bottom <= top) return null;
  const x = Math.floor((left / source.width) * target.width);
  const y = Math.floor((top / source.height) * target.height);
  const endX = Math.min(target.width, Math.ceil((right / source.width) * target.width));
  const endY = Math.min(target.height, Math.ceil((bottom / source.height) * target.height));
  return { x, y, width: endX - x, height: endY - y };
}
