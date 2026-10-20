import sharp from 'sharp';
import type { Bounds, MaskStroke } from '../shared/contracts';

export interface RgbaImage {
  width: number;
  height: number;
  data: Buffer;
}
export interface ImageMask {
  width: number;
  height: number;
  data: Uint8Array;
}
type Size = Pick<RgbaImage, 'width' | 'height'>;
const MAX_PIXELS = 40_000_000;

function checkSize(size: Size): number {
  const pixels = size.width * size.height;
  if (
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width < 1 ||
    size.height < 1 ||
    pixels > MAX_PIXELS
  ) {
    throw new Error('图像尺寸无效或超过 4000 万像素。');
  }
  return pixels;
}

function checkImage(image: RgbaImage): void {
  if (image.data.length !== checkSize(image) * 4) throw new Error('RGBA 数据与图片尺寸不一致。');
}

function checkMask(mask: ImageMask): void {
  if (mask.data.length !== checkSize(mask)) throw new Error('蒙版数据与图片尺寸不一致。');
}

function checkSameSize(a: Size, b: Size): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error('模型返回尺寸与裁图不一致，无法安全映射像素。');
  }
}

/** Enclosing integer bounds clipped to the original image, without rescaling. */
export function clipBounds(bounds: Bounds, size: Size): Bounds | null {
  checkSize(size);
  if (
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  )
    return null;
  const x = Math.max(0, Math.floor(bounds.x));
  const y = Math.max(0, Math.floor(bounds.y));
  const endX = Math.min(size.width, Math.ceil(bounds.x + bounds.width));
  const endY = Math.min(size.height, Math.ceil(bounds.y + bounds.height));
  return endX > x && endY > y ? { x, y, width: endX - x, height: endY - y } : null;
}

export function intersectBounds(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const endX = Math.min(a.x + a.width, b.x + b.width);
  const endY = Math.min(a.y + a.height, b.y + b.height);
  return endX > x && endY > y ? { x, y, width: endX - x, height: endY - y } : null;
}

export function unionBounds(bounds: Bounds[]): Bounds {
  if (!bounds.length) throw new Error('合并至少需要一个有效区域。');
  const x = Math.min(...bounds.map((box) => box.x));
  const y = Math.min(...bounds.map((box) => box.y));
  return {
    x,
    y,
    width: Math.max(...bounds.map((box) => box.x + box.width)) - x,
    height: Math.max(...bounds.map((box) => box.y + box.height)) - y,
  };
}

export function toLocalBounds(bounds: Bounds, crop: Bounds): Bounds {
  const intersection = intersectBounds(bounds, crop);
  if (!intersection) throw new Error('区域不在当前裁图内。');
  return { ...intersection, x: intersection.x - crop.x, y: intersection.y - crop.y };
}

export async function decodeRgba(input: Buffer): Promise<RgbaImage> {
  const { data, info } = await sharp(input, { limitInputPixels: MAX_PIXELS })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const image = { width: info.width, height: info.height, data };
  checkImage(image);
  return image;
}

export async function encodeRgba(image: RgbaImage): Promise<Buffer> {
  checkImage(image);
  return sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
    .png({ palette: false })
    .toBuffer();
}

export function cropRgba(image: RgbaImage, bounds: Bounds): RgbaImage {
  checkImage(image);
  const clipped = clipBounds(bounds, image);
  if (
    !clipped ||
    clipped.x !== bounds.x ||
    clipped.y !== bounds.y ||
    clipped.width !== bounds.width ||
    clipped.height !== bounds.height
  ) {
    throw new Error('裁图区域越界或不是整数像素。');
  }
  const data = Buffer.alloc(bounds.width * bounds.height * 4);
  for (let y = 0; y < bounds.height; y++) {
    const source = ((bounds.y + y) * image.width + bounds.x) * 4;
    image.data.copy(data, y * bounds.width * 4, source, source + bounds.width * 4);
  }
  return { width: bounds.width, height: bounds.height, data };
}

export function emptyMask(size: Size): ImageMask {
  return { width: size.width, height: size.height, data: new Uint8Array(checkSize(size)) };
}

export function fullMask(size: Size): ImageMask {
  const mask = emptyMask(size);
  mask.data.fill(255);
  return mask;
}

/** Accept only a pixel-aligned grayscale/alpha mask, never a colored preview. */
export async function decodeMask(input: Buffer, expected: Size): Promise<ImageMask> {
  const image = await decodeRgba(input);
  checkSameSize(image, expected);
  const mask = emptyMask(expected);
  for (let index = 0; index < mask.data.length; index++) {
    const offset = index * 4;
    const [r, g, b, alpha] = image.data.subarray(offset, offset + 4);
    if (alpha && Math.max(r, g, b) - Math.min(r, g, b) > 3) {
      throw new Error('模型返回了彩色预览而不是灰度蒙版，已拒绝用于抠图或修复。');
    }
    mask.data[index] = Math.round((r * alpha) / 255);
  }
  return mask;
}

export async function encodeMask(mask: ImageMask): Promise<Buffer> {
  checkMask(mask);
  return sharp(Buffer.from(mask.data), {
    raw: { width: mask.width, height: mask.height, channels: 1 },
  })
    .png()
    .toBuffer();
}

/** Union masks in original-image coordinates; disconnected details stay together. */
export function unionMasks(
  parts: { mask: ImageMask; bounds: Bounds }[],
  targetBounds: Bounds,
): ImageMask {
  const result = emptyMask(targetBounds);
  for (const { mask, bounds } of parts) {
    checkMask(mask);
    checkSameSize(mask, bounds);
    const overlap = intersectBounds(bounds, targetBounds);
    if (!overlap) continue;
    for (let y = overlap.y; y < overlap.y + overlap.height; y++) {
      for (let x = overlap.x; x < overlap.x + overlap.width; x++) {
        const destination = (y - targetBounds.y) * result.width + x - targetBounds.x;
        const source = (y - bounds.y) * mask.width + x - bounds.x;
        result.data[destination] = Math.max(result.data[destination], mask.data[source]);
      }
    }
  }
  return result;
}

export function maskSummary(mask: ImageMask): {
  pixels: number;
  bounds: Bounds | null;
  density: number;
} {
  checkMask(mask);
  let pixels = 0;
  let minX = mask.width;
  let minY = mask.height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0; index < mask.data.length; index++) {
    if (!mask.data[index]) continue;
    pixels++;
    const x = index % mask.width;
    const y = Math.floor(index / mask.width);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const bounds = pixels
    ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
    : null;
  return { pixels, bounds, density: bounds ? pixels / (bounds.width * bounds.height) : 0 };
}

export function intersectMasks(a: ImageMask, b: ImageMask): ImageMask {
  checkMask(a);
  checkMask(b);
  checkSameSize(a, b);
  const result = emptyMask(a);
  for (let index = 0; index < a.data.length; index++) {
    // The foreground is a support constraint. Preserve the repair-mask strength
    // at antialiased foreground pixels instead of eroding that boundary again.
    result.data[index] = b.data[index] > 0 ? a.data[index] : 0;
  }
  return result;
}

/** Keep only pixels that will remain visible after the source alpha is applied. */
export function visibleForeground(mask: ImageMask, image: RgbaImage): ImageMask {
  checkMask(mask);
  checkImage(image);
  checkSameSize(mask, image);
  const result = emptyMask(mask);
  for (let index = 0; index < mask.data.length; index++) {
    result.data[index] =
      Math.round((mask.data[index] * image.data[index * 4 + 3]) / 255) > 0 ? mask.data[index] : 0;
  }
  return result;
}

/** Only watermark pixels on the existing contour justify another segmentation. */
export function affectedContour(foreground: ImageMask, watermark: ImageMask): ImageMask {
  checkMask(foreground);
  checkMask(watermark);
  checkSameSize(foreground, watermark);
  const affected = emptyMask(foreground);
  for (let y = 0; y < foreground.height; y++) {
    for (let x = 0; x < foreground.width; x++) {
      const index = y * foreground.width + x;
      if (!watermark.data[index] || !foreground.data[index]) continue;
      const edge =
        foreground.data[index] < 255 ||
        x === 0 ||
        y === 0 ||
        x === foreground.width - 1 ||
        y === foreground.height - 1 ||
        !foreground.data[index - 1] ||
        !foreground.data[index + 1] ||
        !foreground.data[index - foreground.width] ||
        !foreground.data[index + foreground.width];
      if (!edge) continue;
      // A small local margin lets the repaired silhouette move without allowing
      // another model call to replace unrelated edges or detached accessories.
      for (
        let nearY = Math.max(0, y - 2);
        nearY <= Math.min(foreground.height - 1, y + 2);
        nearY++
      ) {
        for (
          let nearX = Math.max(0, x - 2);
          nearX <= Math.min(foreground.width - 1, x + 2);
          nearX++
        ) {
          affected.data[nearY * foreground.width + nearX] = 255;
        }
      }
    }
  }
  return affected;
}

/** Preserve every alpha value outside the specifically affected contour. */
export function replaceMaskRegion(
  original: ImageMask,
  replacement: ImageMask,
  region: ImageMask,
): ImageMask {
  checkMask(original);
  checkMask(replacement);
  checkMask(region);
  checkSameSize(original, replacement);
  checkSameSize(original, region);
  const result = { ...original, data: new Uint8Array(original.data) };
  for (let index = 0; index < original.data.length; index++) {
    if (region.data[index]) result.data[index] = replacement.data[index];
  }
  return result;
}

/** Brush points and radius are absolute original-image pixel units. */
export function applyMaskStrokes(mask: ImageMask, crop: Bounds, strokes: MaskStroke[]): ImageMask {
  checkMask(mask);
  checkSameSize(mask, crop);
  const result = { ...mask, data: new Uint8Array(mask.data) };
  if (strokes.length > 1000) throw new Error('画笔操作过多，请分次修正。');
  for (const stroke of strokes) {
    if (
      !Number.isFinite(stroke.radius) ||
      stroke.radius <= 0 ||
      stroke.radius > 4096 ||
      !['add', 'erase'].includes(stroke.mode) ||
      stroke.points.length > 20000
    ) {
      throw new Error('画笔半径或操作参数无效。');
    }
    const points = stroke.points.map((point) => {
      if (
        ![point.x, point.y].every(Number.isFinite) ||
        Math.abs(point.x) > 100000 ||
        Math.abs(point.y) > 100000
      )
        throw new Error('画笔坐标无效。');
      return { x: point.x - crop.x, y: point.y - crop.y };
    });
    for (let index = 0; index < points.length; index++) {
      const a = points[index ? index - 1 : 0];
      const b = points[index];
      const radius = stroke.radius;
      const minX = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius));
      const maxX = Math.min(mask.width - 1, Math.ceil(Math.max(a.x, b.x) + radius));
      const minY = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius));
      const maxY = Math.min(mask.height - 1, Math.ceil(Math.max(a.y, b.y) + radius));
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSquared = dx * dx + dy * dy;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const t = lengthSquared
            ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared))
            : 0;
          if ((x - a.x - t * dx) ** 2 + (y - a.y - t * dy) ** 2 <= radius * radius) {
            result.data[y * mask.width + x] = stroke.mode === 'add' ? 255 : 0;
          }
        }
      }
    }
  }
  return result;
}

/** This local composite, not a model promise, preserves every unmasked RGB byte. */
export function compositeRepair(
  original: RgbaImage,
  repaired: RgbaImage,
  mask: ImageMask,
): RgbaImage {
  checkImage(original);
  checkImage(repaired);
  checkMask(mask);
  checkSameSize(original, repaired);
  checkSameSize(original, mask);
  const data = Buffer.from(original.data);
  for (let index = 0; index < mask.data.length; index++) {
    if (!mask.data[index]) continue;
    const strength = mask.data[index] / 255;
    for (let channel = 0; channel < 3; channel++) {
      const offset = index * 4 + channel;
      data[offset] = Math.round(
        original.data[offset] * (1 - strength) + repaired.data[offset] * strength,
      );
    }
  }
  return { ...original, data };
}

export function applyAlpha(image: RgbaImage, mask: ImageMask): RgbaImage {
  checkImage(image);
  checkMask(mask);
  checkSameSize(image, mask);
  const data = Buffer.from(image.data);
  for (let index = 0; index < mask.data.length; index++) {
    data[index * 4 + 3] = Math.round((image.data[index * 4 + 3] * mask.data[index]) / 255);
  }
  return { ...image, data };
}
