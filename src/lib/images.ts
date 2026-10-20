import type { Cutout, LocalSegmentationResult, Raster, SegmentationOptions } from '../types';
import { preflightImage, validateImportDimensions } from './image-header';

export async function validateImage(file: File) {
  await preflightImage(file);
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  bitmap.close();
  validateImportDimensions({ width, height });
  return { width, height };
}

export async function readRaster(file: Blob): Promise<Raster> {
  await preflightImage(file);
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('浏览器无法创建图像画布。');
    context.drawImage(bitmap, 0, 0, width, height);
    return { width, height, data: context.getImageData(0, 0, width, height).data };
  } finally {
    bitmap.close();
  }
}

export async function cutoutToPng(cutout: Cutout): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = cutout.width;
  canvas.height = cutout.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法合成透明 PNG。');
  context.putImageData(
    new ImageData(new Uint8ClampedArray(cutout.data), cutout.width, cutout.height),
    0,
    0,
  );
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG 编码失败。'))),
      'image/png',
    );
  });
}

export async function loadSampleFile(): Promise<File> {
  const response = await fetch('/sample-sheet.svg');
  if (!response.ok) throw new Error('示例图片读取失败，请稍后重试。');
  const blob = await response.blob();
  const image = new Image();
  const url = URL.createObjectURL(blob);
  try {
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建示例图片。');
    context.drawImage(image, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('示例转换失败。'))),
        'image/png',
      ),
    );
    return new File([png], '森林伙伴_示例拼图.png', { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function segmentInWorker(
  image: Raster,
  options: SegmentationOptions,
  signal: AbortSignal,
): Promise<LocalSegmentationResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('已停止处理', 'AbortError'));
      return;
    }
    const worker = new Worker(new URL('../workers/segment.worker.ts', import.meta.url), {
      type: 'module',
    });
    const id = crypto.randomUUID();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => {
      finish();
      reject(new DOMException('已停止处理', 'AbortError'));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error('本地处理超过 60 秒，请缩小图片后重试。'));
    }, 60_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => {
      finish();
      reject(new Error('图像处理线程出错，请重新尝试。'));
    };
    worker.onmessage = (
      event: MessageEvent<{
        id: string;
        ok: boolean;
        result?: LocalSegmentationResult;
        error?: string;
      }>,
    ) => {
      if (event.data.id !== id) return;
      finish();
      if (event.data.ok && event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error || '人物提取失败。'));
    };
    worker.postMessage({ id, image, options }, [image.data.buffer]);
  });
}
