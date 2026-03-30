import { describe, expect, it } from 'vitest';

import { FRAME_DATA_SIZE } from '../types';
import {
  BYTES_PER_ROW,
  decodePng,
  decodeFramebuffer,
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  framebufferToPng,
  LCD_ROWSIZE,
  xorFramebuffers,
} from './FrameBuffer';

// --- Test helpers ---

/** Create a zeroed 12,480-byte raw framebuffer. */
function makeFramebuffer(): Buffer {
  return Buffer.alloc(FRAME_DATA_SIZE);
}

/**
 * Set a single pixel in a raw framebuffer.
 * Accounts for 52-byte stride and MSB-first bit order.
 */
function setPixel(buf: Buffer, x: number, y: number): void {
  const byteIdx = Math.floor(x / 8);
  const bitIdx = 7 - (x % 8); // MSB = leftmost
  const offset = y * LCD_ROWSIZE + byteIdx;
  buf[offset] = buf[offset]! | (1 << bitIdx);
}

/**
 * Create a framebuffer with all data bytes set to a value.
 * Padding bytes (50–51 of each row) are left as 0.
 */
function makeFilledFramebuffer(dataByte: number): Buffer {
  const buf = Buffer.alloc(FRAME_DATA_SIZE);
  for (let row = 0; row < DISPLAY_HEIGHT; row++) {
    const rowOffset = row * LCD_ROWSIZE;
    for (let col = 0; col < BYTES_PER_ROW; col++) {
      buf[rowOffset + col] = dataByte;
    }
  }

  return buf;
}

// --- decodeFramebuffer ---

describe('decodeFramebuffer', () => {
  it('decodes all-white framebuffer (0xFF data bytes)', () => {
    const raw = makeFilledFramebuffer(0xff);
    const pixels = decodeFramebuffer(raw);

    expect(pixels.length).toBe(DISPLAY_WIDTH * DISPLAY_HEIGHT);
    for (let i = 0; i < pixels.length; i++) {
      expect(pixels[i]).toBe(255);
    }
  });

  it('decodes all-black framebuffer (0x00)', () => {
    const raw = makeFramebuffer();
    const pixels = decodeFramebuffer(raw);

    expect(pixels.length).toBe(DISPLAY_WIDTH * DISPLAY_HEIGHT);
    for (let i = 0; i < pixels.length; i++) {
      expect(pixels[i]).toBe(0);
    }
  });

  it('decodes checkerboard (0xAA bytes = 10101010)', () => {
    const raw = makeFilledFramebuffer(0xaa);
    const pixels = decodeFramebuffer(raw);

    // 0xAA = 10101010 → pixel 0 white, pixel 1 black, pixel 2 white, ...
    expect(pixels[0]).toBe(255);
    expect(pixels[1]).toBe(0);
    expect(pixels[2]).toBe(255);
    expect(pixels[3]).toBe(0);
  });

  it('decodes single pixel at (0, 0)', () => {
    const raw = makeFramebuffer();
    setPixel(raw, 0, 0);
    const pixels = decodeFramebuffer(raw);

    expect(pixels[0]).toBe(255);
    expect(pixels[1]).toBe(0);
    // All other pixels black
    for (let i = 1; i < pixels.length; i++) {
      if (i === 0) continue;
      expect(pixels[i]).toBe(0);
    }
  });

  it('decodes single pixel at (399, 239)', () => {
    const raw = makeFramebuffer();
    setPixel(raw, 399, 239);
    const pixels = decodeFramebuffer(raw);

    const lastPixel = 239 * DISPLAY_WIDTH + 399;
    expect(pixels[lastPixel]).toBe(255);

    // Verify the raw byte: pixel 399 = byte 49, bit 0
    const rawOffset = 239 * LCD_ROWSIZE + 49;
    expect(raw[rawOffset]).toBe(0x01); // bit 0 set
  });

  it('decodes all four corner pixels', () => {
    const raw = makeFramebuffer();
    setPixel(raw, 0, 0);
    setPixel(raw, 399, 0);
    setPixel(raw, 0, 239);
    setPixel(raw, 399, 239);
    const pixels = decodeFramebuffer(raw);

    expect(pixels[0]).toBe(255); // (0,0)
    expect(pixels[399]).toBe(255); // (399,0)
    expect(pixels[239 * DISPLAY_WIDTH]).toBe(255); // (0,239)
    expect(pixels[239 * DISPLAY_WIDTH + 399]).toBe(255); // (399,239)

    // A non-corner pixel should be black
    expect(pixels[200]).toBe(0);
    expect(pixels[120 * DISPLAY_WIDTH + 200]).toBe(0);
  });

  it('ignores stride padding bytes', () => {
    const raw = makeFramebuffer();
    // Set padding bytes (50 and 51 of each row) to 0xFF
    for (let row = 0; row < DISPLAY_HEIGHT; row++) {
      raw[row * LCD_ROWSIZE + 50] = 0xff;
      raw[row * LCD_ROWSIZE + 51] = 0xff;
    }
    const pixels = decodeFramebuffer(raw);

    // All pixels should still be black — padding must not affect output
    for (let i = 0; i < pixels.length; i++) {
      expect(pixels[i]).toBe(0);
    }
  });

  it('throws on wrong buffer size', () => {
    expect(() => decodeFramebuffer(Buffer.alloc(0))).toThrow(
      'Expected 12480 bytes, got 0',
    );
    expect(() => decodeFramebuffer(Buffer.alloc(12_479))).toThrow(
      'Expected 12480 bytes, got 12479',
    );
    expect(() => decodeFramebuffer(Buffer.alloc(12_481))).toThrow(
      'Expected 12480 bytes, got 12481',
    );
  });
});

// --- xorFramebuffers ---

describe('xorFramebuffers', () => {
  it('identical framebuffers produce diffCount=0', () => {
    const a = makeFilledFramebuffer(0xaa);
    const b = makeFilledFramebuffer(0xaa);
    const { diffBuffer, diffCount } = xorFramebuffers(a, b);

    expect(diffCount).toBe(0);
    for (let i = 0; i < diffBuffer.length; i++) {
      expect(diffBuffer[i]).toBe(0);
    }
  });

  it('all-white vs all-black produces diffCount=96000', () => {
    const white = makeFilledFramebuffer(0xff);
    const black = makeFramebuffer();
    const { diffCount } = xorFramebuffers(white, black);

    expect(diffCount).toBe(DISPLAY_WIDTH * DISPLAY_HEIGHT);
  });

  it('single pixel difference produces diffCount=1 at correct location', () => {
    const a = makeFramebuffer();
    const b = makeFramebuffer();
    setPixel(b, 200, 120);
    const { diffBuffer, diffCount } = xorFramebuffers(a, b);

    expect(diffCount).toBe(1);
    expect(diffBuffer[120 * DISPLAY_WIDTH + 200]).toBe(255);

    // All other pixels should be 0
    let nonZeroCount = 0;
    for (let i = 0; i < diffBuffer.length; i++) {
      if (diffBuffer[i] !== 0) nonZeroCount++;
    }
    expect(nonZeroCount).toBe(1);
  });

  it('throws on wrong buffer size', () => {
    expect(() =>
      xorFramebuffers(Buffer.alloc(100), Buffer.alloc(FRAME_DATA_SIZE)),
    ).toThrow('Buffer a: expected 12480 bytes, got 100');
    expect(() =>
      xorFramebuffers(Buffer.alloc(FRAME_DATA_SIZE), Buffer.alloc(100)),
    ).toThrow('Buffer b: expected 12480 bytes, got 100');
  });
});

// --- PNG encoding ---

describe('framebufferToPng', () => {
  it('returns valid PNG (magic bytes)', async () => {
    const raw = makeFramebuffer();
    const png = await framebufferToPng(raw);

    // PNG magic: 0x89 P N G \r \n 0x1A \n
    expect(png[0]).toBe(0x89);
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('PNG round-trip is lossless for sparse pixels', async () => {
    const raw = makeFramebuffer();
    setPixel(raw, 0, 0);
    setPixel(raw, 399, 239);
    setPixel(raw, 200, 120);

    const originalPixels = decodeFramebuffer(raw);
    const png = await framebufferToPng(raw);
    const decoded = await decodePng(png);

    expect(decoded.width).toBe(DISPLAY_WIDTH);
    expect(decoded.height).toBe(DISPLAY_HEIGHT);
    expect(decoded.pixels.length).toBe(originalPixels.length);
    expect(decoded.pixels.equals(originalPixels)).toBe(true);
  });

  it('PNG round-trip is lossless for all-white', async () => {
    const raw = makeFilledFramebuffer(0xff);
    const originalPixels = decodeFramebuffer(raw);
    const png = await framebufferToPng(raw);
    const decoded = await decodePng(png);

    expect(decoded.pixels.equals(originalPixels)).toBe(true);
  });

  it('PNG round-trip is lossless for all-black', async () => {
    const raw = makeFramebuffer();
    const originalPixels = decodeFramebuffer(raw);
    const png = await framebufferToPng(raw);
    const decoded = await decodePng(png);

    expect(decoded.pixels.equals(originalPixels)).toBe(true);
  });

  it('PNG round-trip is lossless for checkerboard', async () => {
    const raw = makeFilledFramebuffer(0xaa);
    const originalPixels = decodeFramebuffer(raw);
    const png = await framebufferToPng(raw);
    const decoded = await decodePng(png);

    expect(decoded.pixels.equals(originalPixels)).toBe(true);
  });
});
