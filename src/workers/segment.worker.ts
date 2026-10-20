import { segmentSolidBackground } from '../lib/image-core';
import type { Raster, SegmentationOptions } from '../types';

interface SegmentMessage {
  id: string;
  image: Raster;
  options: SegmentationOptions;
}

// Keep the worker independently type-checkable without adding WebWorker globals
// to the browser application's TypeScript compilation.
const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<SegmentMessage>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

worker.onmessage = (event) => {
  const { id, image, options } = event.data;
  try {
    const result = segmentSolidBackground(image, options);
    worker.postMessage(
      { id, ok: true, result },
      result.cutouts.map((cutout) => cutout.data.buffer as ArrayBuffer),
    );
  } catch (error) {
    worker.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : '本地提取失败，请重试。',
    });
  }
};
