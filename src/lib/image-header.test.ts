import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMPORT_BYTES, parseImageHeader, preflightImage } from './image-header';
import { readRaster, validateImage } from './images';

const ascii = (text: string) => Array.from(text, (character) => character.charCodeAt(0));

function png(width: number, height: number) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set(ascii('IHDR'), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function jpeg(width: number, height: number, marker = 0xc0) {
  return new Uint8Array([
    255,
    216,
    // APP1 and DQT segments must be skipped, not mistaken for image dimensions.
    255,
    225,
    0,
    6,
    9,
    8,
    7,
    6,
    255,
    219,
    0,
    4,
    5,
    6,
    255,
    marker,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    0x11,
    0,
  ]);
}

function chunk(type: string, payload: Uint8Array) {
  const bytes = new Uint8Array(8 + payload.length + (payload.length % 2));
  bytes.set(ascii(type));
  new DataView(bytes.buffer).setUint32(4, payload.length, true);
  bytes.set(payload, 8);
  return bytes;
}

function webp(...chunks: Uint8Array[]) {
  const bytes = new Uint8Array(12 + chunks.reduce((sum, item) => sum + item.length, 0));
  bytes.set(ascii('RIFF'));
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set(ascii('WEBP'), 8);
  let offset = 12;
  for (const item of chunks) {
    bytes.set(item, offset);
    offset += item.length;
  }
  return bytes;
}

function vp8(width: number, height: number) {
  const bytes = new Uint8Array(10);
  bytes.set([0, 0, 0, 0x9d, 0x01, 0x2a]);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return chunk('VP8 ', bytes);
}

function vp8l(width: number, height: number) {
  const bytes = new Uint8Array(5);
  bytes[0] = 0x2f;
  new DataView(bytes.buffer).setUint32(1, (width - 1) | ((height - 1) << 14), true);
  return chunk('VP8L', bytes);
}

function write24(bytes: Uint8Array, offset: number, value: number) {
  bytes.set([value & 255, (value >> 8) & 255, (value >> 16) & 255], offset);
}

function vp8x(width: number, height: number, animation = false) {
  const bytes = new Uint8Array(10);
  if (animation) bytes[0] = 2;
  write24(bytes, 4, width - 1);
  write24(bytes, 7, height - 1);
  return chunk('VP8X', bytes);
}

describe('encoded image dimensions', () => {
  it('reads PNG dimensions as unsigned big-endian values', () => {
    expect(parseImageHeader(png(9000, 5000))).toEqual({ format: 'png', width: 9000, height: 5000 });
    expect(parseImageHeader(png(0x80000000, 8)).width).toBe(0x80000000);
  });

  it('rejects incomplete signatures, truncated IHDR, and zero dimensions', () => {
    const corrupt = png(100, 100);
    corrupt[11] = 12;
    for (const bytes of [
      png(100, 100).slice(0, 24),
      png(0, 20),
      corrupt,
      new Uint8Array([137, 80, 78, 71]),
    ]) {
      expect(() => parseImageHeader(bytes)).toThrow('图片头');
    }
  });

  it('reads baseline and progressive JPEG after metadata segments', () => {
    for (const marker of [0xc0, 0xc2]) {
      expect(parseImageHeader(jpeg(4032, 3024, marker))).toEqual({
        format: 'jpeg',
        width: 4032,
        height: 3024,
      });
    }
  });

  it('rejects JPEG segments extending beyond the file and scan data before dimensions', () => {
    const truncated = jpeg(100, 100).slice(0, -1);
    const invalidLength = jpeg(100, 100);
    invalidLength[5] = 255;
    for (const bytes of [truncated, invalidLength, new Uint8Array([255, 216, 255, 218, 0, 2])]) {
      expect(() => parseImageHeader(bytes)).toThrow('图片头');
    }
  });

  it('reads VP8 and bit-packed VP8L dimensions, including the lossless maximum', () => {
    expect(parseImageHeader(webp(vp8(1234, 5678)))).toEqual({
      format: 'webp',
      width: 1234,
      height: 5678,
    });
    expect(parseImageHeader(webp(vp8l(16384, 16384)))).toEqual({
      format: 'webp',
      width: 16384,
      height: 16384,
    });
  });

  it('reads extended WebP and skips an odd-length padded metadata chunk', () => {
    expect(
      parseImageHeader(
        webp(vp8x(640, 480), chunk('ICCP', new Uint8Array([1, 2, 3])), vp8l(640, 480)),
      ),
    ).toEqual({ format: 'webp', width: 640, height: 480 });
  });

  it('checks extended WebP canvas against its encoded frame dimensions', () => {
    expect(() => parseImageHeader(webp(vp8x(10, 10), vp8(10000, 10000)))).toThrow('图片头');
    expect(() => parseImageHeader(webp(vp8x(9000, 5000)))).toThrow('4000 万');
  });

  it('rejects RIFF size overflow, truncated chunks, invalid signatures and unknown payloads', () => {
    const overflow = webp(vp8(40, 40));
    new DataView(overflow.buffer).setUint32(16, 0xffffffff, true);
    const badSignature = webp(vp8(40, 40));
    badSignature[23] = 0;
    const badVersion = webp(vp8l(40, 40));
    badVersion[24] |= 0x20;
    const truncated = webp(vp8(40, 40)).slice(0, -2);
    for (const bytes of [
      overflow,
      badSignature,
      badVersion,
      truncated,
      webp(chunk('FAKE', new Uint8Array(10))),
    ]) {
      expect(() => parseImageHeader(bytes)).toThrow('图片头');
    }
  });

  it('validates animated WebP frame sizes within the declared canvas', () => {
    const encoded = vp8l(30, 20);
    const frame = new Uint8Array(16 + encoded.length);
    write24(frame, 6, 29);
    write24(frame, 9, 19);
    frame.set(encoded, 16);
    const animation = () =>
      webp(vp8x(100, 80, true), chunk('ANIM', new Uint8Array(6)), chunk('ANMF', frame));
    expect(parseImageHeader(animation())).toEqual({ format: 'webp', width: 100, height: 80 });
    write24(frame, 0, 40); // Frame X is stored in units of two pixels.
    expect(() => parseImageHeader(animation())).toThrow('图片头');
  });

  it('reads correctly from a Uint8Array subview without consuming unrelated buffer bytes', () => {
    const container = new Uint8Array(100);
    container.set(png(123, 456), 7);
    expect(parseImageHeader(container.subarray(7, 40))).toEqual({
      format: 'png',
      width: 123,
      height: 456,
    });
  });
});

describe('pre-decode import limits', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects oversized encoded images before either browser decode entry point runs', async () => {
    const decoder = vi.fn();
    vi.stubGlobal('createImageBitmap', decoder);
    const file = new File([png(9000, 5000)], 'large.png', { type: 'image/png' });
    await expect(validateImage(file)).rejects.toThrow('4000 万');
    await expect(readRaster(file)).rejects.toThrow('4000 万');
    expect(decoder).not.toHaveBeenCalled();
  });

  it('rejects files over 25 MB before reading their contents', async () => {
    const arrayBuffer = vi.fn();
    await expect(
      preflightImage({ size: MAX_IMPORT_BYTES + 1, arrayBuffer } as unknown as Blob),
    ).rejects.toThrow('25 MB');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('rejects damaged, unsupported, and tiny images before decode', async () => {
    const decoder = vi.fn();
    vi.stubGlobal('createImageBitmap', decoder);
    for (const bytes of [
      new Uint8Array(ascii('<svg></svg>')),
      jpeg(20, 20).slice(0, 8),
      png(7, 8),
    ]) {
      await expect(validateImage(new File([bytes], 'untrusted.png'))).rejects.toThrow();
    }
    expect(decoder).not.toHaveBeenCalled();
  });

  it('allows the exact pixel limit and returns browser dimensions after orientation', async () => {
    await expect(preflightImage(new Blob([png(8000, 5000)]))).resolves.toEqual({
      format: 'png',
      width: 8000,
      height: 5000,
    });
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 50, height: 80, close }));
    await expect(validateImage(new File([jpeg(80, 50)], 'rotated.jpg'))).resolves.toEqual({
      width: 50,
      height: 80,
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
