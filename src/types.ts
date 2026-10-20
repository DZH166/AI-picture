export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelMask {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Cutout extends Raster {
  bounds: Bounds;
}

export interface SegmentationOptions {
  tolerance: number;
  minArea: number;
}

export interface LocalSegmentationResult {
  cutouts: Cutout[];
  background: [number, number, number];
  warnings: string[];
}

export interface ProviderSettings {
  apiBaseUrl: string;
  apiKey: string;
  modelId: string;
  timeoutMs: number;
  allowImageUpload: boolean;
}

export interface ExportItem {
  sourceId: string;
  sourceName: string;
  name: string;
  blob: Blob;
}

export interface ReportRow {
  sourceName: string;
  status: string;
  count: number;
  durationMs: number;
  note: string;
}

export type ExportMode = 'grouped' | 'flat';
