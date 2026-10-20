import { describe, expect, it } from 'vitest';
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
  intersectMasks,
  maskSummary,
  replaceMaskRegion,
  toLocalBounds,
  unionBounds,
  unionMasks,
  visibleForeground,
  type RgbaImage,
} from './imaging';

function image(width: number, height: number, color = [80, 100, 120, 255]): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(color, offset);
  return { width, height, data };
}

describe('pixel-preserving image composition', () => {
  it('preserves every RGB and alpha byte outside a repair mask, including PNG roundtrip', async () => {
    const original = image(5, 4, [27, 83, 149, 210]);
    const repaired = image(5, 4, [201, 6, 37, 1]);
    const mask = emptyMask(original);
    mask.data[3] = 255;
    mask.data[8] = 128;
    const result = await decodeRgba(await encodeRgba(compositeRepair(original, repaired, mask)));
    for (let pixel = 0; pixel < mask.data.length; pixel++) {
      const offset = pixel * 4;
      if (!mask.data[pixel])
        expect(result.data.subarray(offset, offset + 4)).toEqual(
          original.data.subarray(offset, offset + 4),
        );
      expect(result.data[offset + 3]).toBe(210);
    }
    expect([...result.data.subarray(12, 15)]).toEqual([201, 6, 37]);
    expect([...original.data.subarray(12, 15)]).toEqual([27, 83, 149]);
  });

  it('multiplies original alpha and preserves RGB instead of replacing the source with provider pixels', () => {
    const original = image(3, 1, [20, 40, 90, 128]);
    const mask = { width: 3, height: 1, data: new Uint8Array([255, 128, 0]) };
    expect([...applyAlpha(original, mask).data]).toEqual([
      20, 40, 90, 128, 20, 40, 90, 64, 20, 40, 90, 0,
    ]);
  });

  it('refuses all mismatched image and mask sizes', () => {
    const original = image(4, 3);
    expect(() => compositeRepair(original, image(3, 4), fullMask(original))).toThrow('尺寸');
    expect(() => applyAlpha(original, fullMask({ width: 3, height: 4 }))).toThrow('尺寸');
    expect(() => applyAlpha(original, { width: 4, height: 3, data: new Uint8Array(11) })).toThrow(
      '尺寸',
    );
  });

  it('decodes real grayscale masks but refuses colored previews and nonmatching dimensions', async () => {
    const mask = { width: 2, height: 2, data: new Uint8Array([0, 127, 255, 42]) };
    expect(await decodeMask(await encodeMask(mask), mask)).toEqual(mask);
    await expect(decodeMask(await encodeRgba(image(2, 2, [255, 0, 0, 255])), mask)).rejects.toThrow(
      '彩色',
    );
    await expect(decodeMask(await encodeMask(mask), { width: 1, height: 4 })).rejects.toThrow(
      '尺寸',
    );
  });
});

describe('original-coordinate bounds and design unions', () => {
  it('clips outward once and crops at original resolution', () => {
    expect(clipBounds({ x: -2.5, y: 1.5, width: 8, height: 9 }, { width: 20, height: 8 })).toEqual({
      x: 0,
      y: 1,
      width: 6,
      height: 7,
    });
    expect(
      toLocalBounds({ x: 12, y: 24, width: 8, height: 6 }, { x: 10, y: 20, width: 20, height: 20 }),
    ).toEqual({ x: 2, y: 4, width: 8, height: 6 });
    const source = image(6, 4);
    source.data.set([1, 2, 3, 4], (2 * 6 + 3) * 4);
    const cropped = cropRgba(source, { x: 3, y: 2, width: 2, height: 2 });
    expect([...cropped.data.subarray(0, 4)]).toEqual([1, 2, 3, 4]);
    expect(cropped.width).toBe(2);
    expect(() => cropRgba(source, { x: 5, y: 2, width: 2, height: 2 })).toThrow('越界');
  });

  it('merges disconnected lettering and accessories into one asset without filling the gap', () => {
    const a = { x: 10, y: 20, width: 2, height: 2 };
    const b = { x: 15, y: 22, width: 2, height: 2 };
    const bounds = unionBounds([a, b]);
    const union = unionMasks(
      [
        { mask: fullMask(a), bounds: a },
        { mask: fullMask(b), bounds: b },
      ],
      bounds,
    );
    expect(bounds).toEqual({ x: 10, y: 20, width: 7, height: 4 });
    expect(maskSummary(union).pixels).toBe(8);
    expect(union.data[3]).toBe(0);
    expect(union.data[2 * 7 + 5]).toBe(255);
  });

  it('ignores watermarks in transparent regions while keeping a soft foreground edge', () => {
    const repair = fullMask({ width: 3, height: 1 });
    const foreground = { width: 3, height: 1, data: new Uint8Array([0, 1, 255]) };
    expect([...intersectMasks(repair, foreground).data]).toEqual([0, 255, 255]);
  });

  it('excludes source-transparent and rounded-to-transparent pixels from repair support', () => {
    const source = image(4, 1);
    source.data[3] = 0;
    source.data[7] = 1;
    source.data[11] = 128;
    const foreground = { width: 4, height: 1, data: new Uint8Array([255, 1, 1, 255]) };
    expect([...visibleForeground(foreground, source).data]).toEqual([0, 0, 1, 255]);
    expect([...foreground.data]).toEqual([255, 1, 1, 255]);
  });

  it('detects watermark contact with the silhouette but ignores interior and exterior pixels', () => {
    const foreground = emptyMask({ width: 12, height: 12 });
    for (let y = 2; y < 10; y++) {
      for (let x = 2; x < 10; x++) foreground.data[y * 12 + x] = 255;
    }
    const watermark = emptyMask(foreground);
    watermark.data[5 * 12 + 5] = 255;
    watermark.data[0] = 255;
    expect(maskSummary(affectedContour(foreground, watermark)).pixels).toBe(0);
    watermark.data[5 * 12 + 2] = 255;
    const affected = affectedContour(foreground, watermark);
    expect(maskSummary(affected).pixels).toBe(25);
    expect(affected.data[5 * 12 + 1]).toBe(255);
    expect(affected.data[9 * 12 + 9]).toBe(0);
  });

  it('replaces only the affected alpha values and rejects a mismatched follow-up mask', () => {
    const original = { width: 3, height: 1, data: new Uint8Array([0, 128, 255]) };
    const replacement = { width: 3, height: 1, data: new Uint8Array([255, 0, 0]) };
    const region = { width: 3, height: 1, data: new Uint8Array([255, 0, 0]) };
    expect([...replaceMaskRegion(original, replacement, region).data]).toEqual([255, 128, 255]);
    expect([...original.data]).toEqual([0, 128, 255]);
    expect(() => affectedContour(original, emptyMask({ width: 1, height: 3 }))).toThrow('尺寸');
    expect(() =>
      replaceMaskRegion(original, replacement, emptyMask({ width: 1, height: 3 })),
    ).toThrow('尺寸');
  });
});

describe('watermark mask brush', () => {
  it('uses original coordinates and radius, and draws a continuous stroke between points', () => {
    const crop = { x: 100, y: 200, width: 20, height: 10 };
    const result = applyMaskStrokes(emptyMask(crop), crop, [
      {
        mode: 'add',
        radius: 1,
        points: [
          { x: 102, y: 204 },
          { x: 116, y: 204 },
        ],
      },
    ]);
    for (let x = 2; x <= 16; x++) expect(result.data[4 * 20 + x]).toBe(255);
    expect(result.data[3 * 20 + 8]).toBe(255);
    expect(result.data[2 * 20 + 8]).toBe(0);
  });

  it('applies erase after add without modifying the input and safely clips outside strokes', () => {
    const crop = { x: 50, y: 50, width: 6, height: 6 };
    const original = emptyMask(crop);
    const result = applyMaskStrokes(original, crop, [
      { mode: 'add', radius: 3, points: [{ x: 52, y: 52 }] },
      { mode: 'erase', radius: 1, points: [{ x: 52, y: 52 }] },
      { mode: 'add', radius: 1, points: [{ x: 500, y: 500 }] },
    ]);
    expect(result.data[2 * 6 + 2]).toBe(0);
    expect(result.data[2 * 6 + 4]).toBe(255);
    expect(original.data.every((value) => value === 0)).toBe(true);
    expect(() =>
      applyMaskStrokes(original, crop, [{ mode: 'add', radius: NaN, points: [] }]),
    ).toThrow('参数');
  });
});
