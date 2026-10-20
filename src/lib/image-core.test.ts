import { describe, expect, it } from 'vitest';
import {
  applyMaskToRaster,
  mapBoundsBetweenSizes,
  MAX_CUTOUTS,
  MAX_IMAGE_PIXELS,
  segmentSolidBackground,
} from './image-core';
import type { Raster } from '../types';

const options = { tolerance: 12, minArea: 1 };

function solid(width: number, height: number, color = [255, 255, 255, 255]): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(color, offset);
  return { width, height, data };
}

function paint(image: Raster, x: number, y: number, color = [200, 10, 20, 255]): void {
  image.data.set(color, (y * image.width + x) * 4);
}

describe('segmentSolidBackground', () => {
  it('extracts separate pixel components with transparent corners and tight original bounds', () => {
    const image = solid(12, 8);
    paint(image, 2, 2);
    paint(image, 1, 3);
    paint(image, 2, 3);
    paint(image, 3, 3);
    paint(image, 2, 4);
    paint(image, 8, 3, [0, 20, 180, 255]);
    paint(image, 8, 4, [0, 20, 180, 255]);
    const before = new Uint8ClampedArray(image.data);
    const result = segmentSolidBackground(image, options);
    expect(result.background).toEqual([255, 255, 255]);
    expect(result.cutouts).toHaveLength(2);
    expect(result.cutouts[0].bounds).toEqual({ x: 1, y: 2, width: 3, height: 3 });
    expect(result.cutouts[0].data[3]).toBe(0);
    expect(result.cutouts[0].data[7]).toBe(255);
    expect(result.cutouts[1].bounds).toEqual({ x: 8, y: 3, width: 1, height: 2 });
    expect(image.data).toEqual(before);
  });

  it('estimates the dominant border color despite an object touching an edge', () => {
    const image = solid(10, 10, [22, 130, 75, 255]);
    for (let y = 0; y < 3; y++) {
      for (let x = 4; x < 7; x++) paint(image, x, y);
    }
    const result = segmentSolidBackground(image, options);
    expect(result.background).toEqual([22, 130, 75]);
    expect(result.cutouts).toHaveLength(1);
    expect(result.cutouts[0].bounds).toEqual({ x: 4, y: 0, width: 3, height: 3 });
  });

  it('preserves enclosed white interiors instead of punching holes through white clothes', () => {
    const image = solid(7, 7);
    for (let y = 2; y <= 4; y++) {
      for (let x = 2; x <= 4; x++) {
        if (x === 2 || x === 4 || y === 2 || y === 4) paint(image, x, y);
      }
    }
    const result = segmentSolidBackground(image, options);
    expect(result.cutouts).toHaveLength(1);
    expect(Array.from(result.cutouts[0].data.slice(16, 20))).toEqual([255, 255, 255, 255]);
  });

  it('uses actual component pixel area, not bounding rectangle area, for filtering', () => {
    const image = solid(8, 8);
    paint(image, 2, 2);
    paint(image, 3, 3);
    paint(image, 4, 4);
    expect(segmentSolidBackground(image, { ...options, minArea: 4 }).cutouts).toHaveLength(0);
    expect(segmentSolidBackground(image, { ...options, minArea: 3 }).cutouts).toHaveLength(1);
  });

  it('preserves existing alpha and opaque white when extracting transparent artwork', () => {
    const image = solid(6, 6, [0, 0, 0, 0]);
    paint(image, 2, 2, [255, 255, 255, 255]);
    paint(image, 3, 2, [255, 255, 255, 128]);
    paint(image, 2, 3, [20, 20, 20, 1]);
    const result = segmentSolidBackground(image, { tolerance: 255, minArea: 1 });
    expect(result.cutouts).toHaveLength(1);
    expect(Array.from(result.cutouts[0].data)).toEqual([
      255, 255, 255, 255, 255, 255, 255, 128, 20, 20, 20, 1, 0, 0, 0, 0,
    ]);
    expect(result.warnings.some((warning) => warning.includes('原有透明通道'))).toBe(true);
  });

  it('returns useful empty results for blank and fully transparent images', () => {
    for (const image of [solid(3, 3), solid(3, 3, [12, 20, 30, 0])]) {
      const result = segmentSolidBackground(image, options);
      expect(result.cutouts).toEqual([]);
      expect(result.warnings.some((warning) => warning.includes('没有找到'))).toBe(true);
    }
  });

  it('handles single-row and single-column images', () => {
    for (const image of [solid(7, 1), solid(1, 7)]) {
      paint(image, image.width === 1 ? 0 : 3, image.width === 1 ? 3 : 0);
      const result = segmentSolidBackground(image, options);
      expect(result.cutouts).toHaveLength(1);
      expect(result.cutouts[0].width).toBe(1);
      expect(result.cutouts[0].height).toBe(1);
    }
  });

  it('defines tolerance on a 0–255 RGB scale and accepts the boundary values', () => {
    const image = solid(3, 3);
    paint(image, 1, 1, [0, 0, 0, 255]);
    expect(segmentSolidBackground(image, { tolerance: 0, minArea: 1 }).cutouts).toHaveLength(1);
    expect(segmentSolidBackground(image, { tolerance: 255, minArea: 1 }).cutouts).toHaveLength(0);
  });

  it('limits candidate count before allocating a large output collection', () => {
    const image = solid(70, 70, [0, 0, 0, 0]);
    for (let y = 1; y < 69; y += 3) {
      for (let x = 1; x < 69; x += 3) paint(image, x, y);
    }
    const result = segmentSolidBackground(image, options);
    expect(result.cutouts).toHaveLength(MAX_CUTOUTS);
    expect(result.warnings.some((warning) => warning.includes('内存限制'))).toBe(true);
  });

  it('rejects invalid options and malformed or oversized images before processing', () => {
    const image = solid(2, 2);
    for (const tolerance of [-1, 256, NaN, Infinity]) {
      expect(() => segmentSolidBackground(image, { tolerance, minArea: 1 })).toThrow('容差');
    }
    for (const minArea of [0, -1, 1.5, NaN, MAX_IMAGE_PIXELS + 1]) {
      expect(() => segmentSolidBackground(image, { tolerance: 12, minArea })).toThrow('最小面积');
    }
    expect(() => segmentSolidBackground({ ...image, width: 0 }, options)).toThrow('宽高');
    expect(() => segmentSolidBackground({ ...image, width: 3 }, options)).toThrow('RGBA');
    expect(() =>
      segmentSolidBackground(
        {
          width: MAX_IMAGE_PIXELS + 1,
          height: 1,
          data: new Uint8ClampedArray(),
        },
        options,
      ),
    ).toThrow('1600 万');
  });
});

describe('mask compositing', () => {
  it('multiplies mask with original alpha without changing the source', () => {
    const image = solid(3, 1, [10, 20, 30, 128]);
    const result = applyMaskToRaster(image, {
      width: 3,
      height: 1,
      data: new Uint8Array([0, 128, 255]),
    });
    expect(Array.from(result.data)).toEqual([0, 0, 0, 0, 10, 20, 30, 64, 10, 20, 30, 128]);
    expect(image.data[3]).toBe(128);
  });

  it('supports an all-zero mask and rejects empty or mismatched mask data', () => {
    const image = solid(2, 2);
    expect(
      applyMaskToRaster(image, {
        width: 2,
        height: 2,
        data: new Uint8Array(4),
      }).data.every((value) => value === 0),
    ).toBe(true);
    for (const mask of [
      { width: 2, height: 2, data: new Uint8Array(0) },
      { width: 1, height: 4, data: new Uint8Array(4) },
      { width: 2, height: 2, data: new Uint8Array(5) },
    ]) {
      expect(() => applyMaskToRaster(image, mask)).toThrow('蒙版尺寸');
    }
  });
});

describe('coordinate mapping', () => {
  const source = { width: 100, height: 50 };
  const target = { width: 300, height: 150 };

  it('clips a preview selection to the image and maps to original pixel coordinates', () => {
    expect(mapBoundsBetweenSizes({ x: -10, y: 10, width: 30, height: 60 }, source, target)).toEqual(
      { x: 0, y: 30, width: 60, height: 120 },
    );
  });

  it('rounds outward so partially selected pixels are not lost', () => {
    expect(
      mapBoundsBetweenSizes({ x: 1.1, y: 2.2, width: 0.5, height: 0.5 }, source, target),
    ).toEqual({ x: 3, y: 6, width: 2, height: 3 });
  });

  it('returns null for empty or outside selections and rejects nonfinite coordinates', () => {
    expect(
      mapBoundsBetweenSizes({ x: 101, y: 0, width: 10, height: 10 }, source, target),
    ).toBeNull();
    expect(mapBoundsBetweenSizes({ x: 0, y: 0, width: 0, height: 10 }, source, target)).toBeNull();
    expect(() =>
      mapBoundsBetweenSizes({ x: NaN, y: 0, width: 1, height: 1 }, source, target),
    ).toThrow('有限数值');
  });
});
