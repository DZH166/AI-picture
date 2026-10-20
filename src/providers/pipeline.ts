import type { Bounds, PixelMask, Raster } from '../types';

/** All masks must match the source raster dimensions; 0 = outside, 255 = inside. */
export interface WatermarkRepairProvider {
  readonly id: string;
  readonly sendsImagesExternally: boolean;
  repair(source: Raster, watermarkMask: PixelMask, signal?: AbortSignal): Promise<Raster>;
}

export interface CharacterInstance {
  id: string;
  bounds: Bounds;
  /** Actual per-pixel alpha mask, never a bounding box substituted for a mask. */
  mask: PixelMask;
  confidence?: number;
}

export interface CharacterSegmentationProvider {
  readonly id: string;
  readonly sendsImagesExternally: boolean;
  segment(source: Raster, signal?: AbortSignal): Promise<CharacterInstance[]>;
}

export class UnconfiguredWatermarkRepairProvider implements WatermarkRepairProvider {
  readonly id = 'unconfigured-watermark-repair';
  readonly sendsImagesExternally = false;

  async repair(_source: Raster, _watermarkMask: PixelMask, _signal?: AbortSignal): Promise<Raster> {
    void _source;
    void _watermarkMask;
    void _signal;
    throw new Error('水印修复模型尚未接入，当前操作没有修改图片。');
  }
}

export class UnconfiguredCharacterSegmentationProvider implements CharacterSegmentationProvider {
  readonly id = 'unconfigured-character-segmentation';
  readonly sendsImagesExternally = false;

  async segment(_source: Raster, _signal?: AbortSignal): Promise<CharacterInstance[]> {
    void _source;
    void _signal;
    throw new Error('AI 逐角色像素分割模型尚未接入；可使用本地纯色背景试提取。');
  }
}
