export interface ImageHeader {
  format: 'png' | 'jpeg' | 'webp';
  width: number;
  height: number;
}

export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_PIXELS = 40_000_000;

const damaged = () =>
  new Error('图片头损坏或格式不受支持，无法安全读取尺寸；请重新导出 PNG、JPG 或 WebP。');
type Size = Pick<ImageHeader, 'width' | 'height'>;

export function validateImportDimensions({ width, height }: Size): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw damaged();
  }
  if (width * height > MAX_IMPORT_PIXELS) {
    throw new Error('图片超过 4000 万像素，请先缩小后再导入。');
  }
  if (width < 8 || height < 8) throw new Error('图片尺寸过小，至少需要 8 × 8 像素。');
}

/**
 * Read encoded dimensions without invoking an image decoder. This is a bounded
 * header/container check, not a replacement for the browser's format decoder.
 * JPEG EXIF orientation may swap width and height; the pixel count is unchanged.
 */
export function parseImageHeader(bytes: Uint8Array): ImageHeader {
  if (bytes.length > MAX_IMPORT_BYTES) throw new Error('单张图片不能超过 25 MB。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const has = (offset: number, count: number) => offset >= 0 && offset + count <= bytes.length;
  const textAt = (offset: number, count: number) =>
    has(offset, count) ? String.fromCharCode(...bytes.subarray(offset, offset + count)) : '';
  const size = (width: number, height: number): Size => {
    if (!width || !height) throw damaged();
    return { width, height };
  };
  const uint24 = (offset: number) =>
    bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;

  if (
    has(0, 8) &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
  ) {
    if (!has(8, 25) || view.getUint32(8) !== 13 || textAt(12, 4) !== 'IHDR') throw damaged();
    return { format: 'png', ...size(view.getUint32(16), view.getUint32(20)) };
  }

  if (has(0, 2) && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (has(offset, 1)) {
      if (bytes[offset++] !== 255) throw damaged();
      while (has(offset, 1) && bytes[offset] === 255) offset++;
      if (!has(offset, 1)) throw damaged();
      const marker = bytes[offset++];
      // Frame dimensions must be known before scan data or the end marker.
      if (marker === 0 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) throw damaged();
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (!has(offset, 2)) throw damaged();
      const length = view.getUint16(offset);
      if (length < 2 || !has(offset, length)) throw damaged();
      const isStartOfFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        if (length < 8) throw damaged();
        const components = bytes[offset + 7];
        if (!components || length !== 8 + components * 3) throw damaged();
        return { format: 'jpeg', ...size(view.getUint16(offset + 5), view.getUint16(offset + 3)) };
      }
      offset += length;
    }
    throw damaged();
  }

  if (textAt(0, 4) !== 'RIFF' || textAt(8, 4) !== 'WEBP' || !has(0, 12)) {
    throw damaged();
  }
  const end = view.getUint32(4, true) + 8;
  if (end < 20 || end > bytes.length || end % 2 !== 0) throw damaged();

  const bitstreamSize = (type: string, start: number, length: number): Size => {
    if (type === 'VP8 ') {
      if (
        length < 10 ||
        (bytes[start] & 1) !== 0 ||
        bytes[start + 3] !== 0x9d ||
        bytes[start + 4] !== 0x01 ||
        bytes[start + 5] !== 0x2a
      )
        throw damaged();
      return size(
        view.getUint16(start + 6, true) & 0x3fff,
        view.getUint16(start + 8, true) & 0x3fff,
      );
    }
    if (length < 5 || bytes[start] !== 0x2f) throw damaged();
    const packed = view.getUint32(start + 1, true);
    if (packed >>> 29 !== 0) throw damaged();
    return size((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
  };

  const chunks = (
    start: number,
    limit: number,
    visit: (type: string, payload: number, length: number) => void,
  ) => {
    let offset = start;
    while (offset < limit) {
      if (offset + 8 > limit) throw damaged();
      const type = textAt(offset, 4);
      const length = view.getUint32(offset + 4, true);
      const payload = offset + 8;
      const next = payload + length + (length % 2);
      if (next > limit) throw damaged();
      visit(type, payload, length);
      offset = next;
    }
  };
  const sameSize = (a: Size, b: Size) => a.width === b.width && a.height === b.height;
  let canvas: Size | undefined;
  let still: Size | undefined;
  let animated = false;
  let animationControl = false;
  let frameCount = 0;

  chunks(12, end, (type, payload, length) => {
    if (type === 'VP8X') {
      if (payload !== 20 || canvas || length < 10) throw damaged();
      canvas = size(uint24(payload + 4) + 1, uint24(payload + 7) + 1);
      // Reject an enormous declared canvas before examining frame payloads.
      validateImportDimensions(canvas);
      animated = (bytes[payload] & 2) !== 0;
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (still || animated) throw damaged();
      still = bitstreamSize(type, payload, length);
      if (canvas && !sameSize(canvas, still)) throw damaged();
    } else if (type === 'ANIM') {
      if (!animated || animationControl || length !== 6) throw damaged();
      animationControl = true;
    } else if (type === 'ANMF') {
      if (!animated || !canvas || !animationControl || length < 16) throw damaged();
      const frame = size(uint24(payload + 6) + 1, uint24(payload + 9) + 1);
      const right = uint24(payload) * 2 + frame.width;
      const bottom = uint24(payload + 3) * 2 + frame.height;
      if (right > canvas.width || bottom > canvas.height) throw damaged();
      let encodedFrame: Size | undefined;
      chunks(payload + 16, payload + length, (frameType, framePayload, frameLength) => {
        if (frameType === 'VP8 ' || frameType === 'VP8L') {
          if (encodedFrame) throw damaged();
          encodedFrame = bitstreamSize(frameType, framePayload, frameLength);
          if (!sameSize(encodedFrame, frame)) throw damaged();
        } else if (frameType === 'ANMF' || frameType === 'VP8X') throw damaged();
      });
      if (!encodedFrame) throw damaged();
      frameCount++;
    }
  });
  const dimensions = canvas || still;
  if (!dimensions || (animated ? frameCount === 0 : !still)) throw damaged();
  return { format: 'webp', ...dimensions };
}

export async function preflightImage(file: Blob): Promise<ImageHeader> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('单张图片不能超过 25 MB。');
  const header = parseImageHeader(new Uint8Array(await file.arrayBuffer()));
  validateImportDimensions(header);
  return header;
}
