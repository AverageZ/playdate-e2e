import { PNG } from 'pngjs';

import { FRAME_DATA_SIZE } from '../types';

/** Playdate LCD width in pixels */
export const DISPLAY_WIDTH = 400;

/** Playdate LCD height in pixels */
export const DISPLAY_HEIGHT = 240;

/** Data bytes per row (400px / 8 bits) */
export const BYTES_PER_ROW = 50;

/** LCD row stride: 50 data bytes + 2 padding bytes */
export const LCD_ROWSIZE = 52;

// Lookup table: number of set bits in a byte (0–255).
// Recurrence: popcount(i) = popcount(i >> 1) + least significant bit of i.
const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  POPCOUNT[i] = POPCOUNT[i >> 1]! + (i & 1);
}

/**
 * Decode a raw 1-bit Playdate framebuffer into a pixel buffer.
 *
 * Input: 12,480 bytes (52 bytes/row × 240 rows, MSB-first, 1=white 0=black).
 * Output: 96,000 bytes (400 × 240, one byte per pixel, 0=black 255=white).
 *
 * The 2 padding bytes at the end of each 52-byte row are skipped.
 */
export function decodeFramebuffer(raw: Buffer): Buffer {
  if (raw.length !== FRAME_DATA_SIZE) {
    throw new Error(`Expected ${FRAME_DATA_SIZE} bytes, got ${raw.length}`);
  }

  const pixels = Buffer.alloc(DISPLAY_WIDTH * DISPLAY_HEIGHT);

  for (let row = 0; row < DISPLAY_HEIGHT; row++) {
    const rowOffset = row * LCD_ROWSIZE;
    const pixelRow = row * DISPLAY_WIDTH;

    for (let byteIdx = 0; byteIdx < BYTES_PER_ROW; byteIdx++) {
      const byte = raw[rowOffset + byteIdx]!;
      const pixelBase = pixelRow + byteIdx * 8;

      // MSB = leftmost pixel
      for (let bit = 7; bit >= 0; bit--) {
        pixels[pixelBase + (7 - bit)] = (byte >> bit) & 1 ? 255 : 0;
      }
    }
  }

  return pixels;
}

/**
 * XOR two raw framebuffers and count differing pixels.
 *
 * Operates on packed 1-bit data (skipping stride padding) for efficiency.
 * Returns a decoded pixel buffer where white (255) = different, black (0) = same.
 */
export function xorFramebuffers(
  a: Buffer,
  b: Buffer,
): { diffBuffer: Buffer; diffCount: number } {
  if (a.length !== FRAME_DATA_SIZE) {
    throw new Error(
      `Buffer a: expected ${FRAME_DATA_SIZE} bytes, got ${a.length}`,
    );
  }
  if (b.length !== FRAME_DATA_SIZE) {
    throw new Error(
      `Buffer b: expected ${FRAME_DATA_SIZE} bytes, got ${b.length}`,
    );
  }

  const diffBuffer = Buffer.alloc(DISPLAY_WIDTH * DISPLAY_HEIGHT);
  let diffCount = 0;

  for (let row = 0; row < DISPLAY_HEIGHT; row++) {
    const rowOffset = row * LCD_ROWSIZE;
    const pixelRow = row * DISPLAY_WIDTH;

    for (let byteIdx = 0; byteIdx < BYTES_PER_ROW; byteIdx++) {
      const xor = a[rowOffset + byteIdx]! ^ b[rowOffset + byteIdx]!;
      diffCount += POPCOUNT[xor]!;

      if (xor !== 0) {
        const pixelBase = pixelRow + byteIdx * 8;
        for (let bit = 7; bit >= 0; bit--) {
          if ((xor >> bit) & 1) {
            diffBuffer[pixelBase + (7 - bit)] = 255;
          }
        }
      }
    }
  }

  return { diffBuffer, diffCount };
}

/**
 * Encode a grayscale pixel buffer (one byte per pixel) as a PNG.
 *
 * pngjs uses RGBA internally — we write R=G=B=pixel, A=255.
 */
function encodeGrayscalePng(
  pixels: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const png = new PNG({ height, width });
    png.data = Buffer.alloc(width * height * 4);

    for (let i = 0; i < width * height; i++) {
      const v = pixels[i]!;
      const j = i * 4;
      png.data[j] = v;
      png.data[j + 1] = v;
      png.data[j + 2] = v;
      png.data[j + 3] = 255;
    }

    const chunks: Buffer[] = [];
    png
      .pack()
      .on('data', (chunk: Buffer) => chunks.push(chunk))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject);
  });
}

/** Convert a raw framebuffer to a grayscale PNG. */
export function framebufferToPng(raw: Buffer): Promise<Buffer> {
  const pixels = decodeFramebuffer(raw);

  return encodeGrayscalePng(pixels, DISPLAY_WIDTH, DISPLAY_HEIGHT);
}

/** Convert a diff pixel buffer (from xorFramebuffers) to a PNG. */
export function diffToPng(diffBuffer: Buffer): Promise<Buffer> {
  return encodeGrayscalePng(diffBuffer, DISPLAY_WIDTH, DISPLAY_HEIGHT);
}

export type DecodedPng = {
  height: number;
  pixels: Buffer;
  width: number;
};

/**
 * Decode a grayscale PNG buffer into a pixel buffer (one byte per pixel).
 *
 * Returns dimensions alongside pixels so callers can validate aspect ratio,
 * not just total pixel count.
 */
export function decodePng(pngBuffer: Buffer): Promise<DecodedPng> {
  return new Promise((resolve, reject) => {
    new PNG().parse(pngBuffer, (err, data) => {
      if (err) {
        reject(err);

        return;
      }

      // Convert RGBA → single-channel grayscale
      const pixels = Buffer.alloc(data.width * data.height);
      for (let i = 0; i < pixels.length; i++) {
        pixels[i] = data.data[i * 4]!;
      }
      resolve({ height: data.height, pixels, width: data.width });
    });
  });
}
