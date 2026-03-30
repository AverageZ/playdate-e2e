import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FRAME_DATA_SIZE } from '../types';
import { BYTES_PER_ROW, DISPLAY_HEIGHT, LCD_ROWSIZE } from './FrameBuffer';
import { compareScreenshot } from './Screenshot';

// --- Helpers ---

function makeFramebuffer(): Buffer {
  return Buffer.alloc(FRAME_DATA_SIZE);
}

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

function setPixel(buf: Buffer, x: number, y: number): void {
  const byteIdx = Math.floor(x / 8);
  const bitIdx = 7 - (x % 8);
  const offset = y * LCD_ROWSIZE + byteIdx;
  buf[offset] = buf[offset]! | (1 << bitIdx);
}

let testDir: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `pdk-screenshot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { force: true, recursive: true });
});

// --- Tests ---

describe('compareScreenshot', () => {
  it('returns missing when no reference exists and updateMode is false', async () => {
    const captured = makeFramebuffer();
    const result = await compareScreenshot('test-shot', captured, {
      snapshotDir: testDir,
    });

    expect(result.status).toBe('missing');
    expect(result.referencePath).toBe(join(testDir, 'test-shot.png'));

    // Verify no file was written
    await expect(access(join(testDir, 'test-shot.png'))).rejects.toThrow();
  });

  it('creates reference PNG when no reference exists and updateMode is true', async () => {
    const captured = makeFramebuffer();
    const result = await compareScreenshot('test-shot', captured, {
      snapshotDir: testDir,
      updateMode: true,
    });

    expect(result.status).toBe('created');
    expect(result.referencePath).toBe(join(testDir, 'test-shot.png'));

    // Verify file was written and is a valid PNG
    const written = await readFile(result.referencePath);
    expect(written[0]).toBe(0x89);
    expect(written.subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('passes when captured matches reference', async () => {
    const fb = makeFilledFramebuffer(0xaa);

    // Create reference first
    await compareScreenshot('match', fb, {
      snapshotDir: testDir,
      updateMode: true,
    });

    // Compare identical framebuffer
    const result = await compareScreenshot('match', fb, {
      snapshotDir: testDir,
    });

    expect(result.status).toBe('pass');
    expect(result.diffCount).toBe(0);
  });

  it('fails when captured differs from reference', async () => {
    const white = makeFilledFramebuffer(0xff);
    const black = makeFramebuffer();

    // Create reference from white
    await compareScreenshot('differ', white, {
      snapshotDir: testDir,
      updateMode: true,
    });

    // Compare with black
    const result = await compareScreenshot('differ', black, {
      snapshotDir: testDir,
    });

    expect(result.status).toBe('fail');
    expect(result.diffCount).toBe(96_000);
    expect(result.diffPath).toBe(join(testDir, 'diff', 'differ-diff.png'));

    // Verify diff PNG was written
    const diffPng = await readFile(result.diffPath!);
    expect(diffPng[0]).toBe(0x89);
  });

  it('passes with tolerance when diff is within maxDiffPixels', async () => {
    const a = makeFramebuffer();
    const b = makeFramebuffer();
    // Set 5 different pixels
    for (let i = 0; i < 5; i++) {
      setPixel(b, i * 10, 0);
    }

    await compareScreenshot('tolerance-pass', a, {
      snapshotDir: testDir,
      updateMode: true,
    });

    const result = await compareScreenshot('tolerance-pass', b, {
      maxDiffPixels: 10,
      snapshotDir: testDir,
    });

    expect(result.status).toBe('pass');
    expect(result.diffCount).toBe(5);
  });

  it('fails when diff exceeds maxDiffPixels', async () => {
    const a = makeFramebuffer();
    const b = makeFramebuffer();
    for (let i = 0; i < 5; i++) {
      setPixel(b, i * 10, 0);
    }

    await compareScreenshot('tolerance-fail', a, {
      snapshotDir: testDir,
      updateMode: true,
    });

    const result = await compareScreenshot('tolerance-fail', b, {
      maxDiffPixels: 2,
      snapshotDir: testDir,
    });

    expect(result.status).toBe('fail');
    expect(result.diffCount).toBe(5);
    expect(result.diffPath).toBeDefined();
  });

  it('overwrites reference in update mode with existing ref', async () => {
    const white = makeFilledFramebuffer(0xff);
    const black = makeFramebuffer();

    // Create reference from white
    await compareScreenshot('overwrite', white, {
      snapshotDir: testDir,
      updateMode: true,
    });
    const original = await readFile(join(testDir, 'overwrite.png'));

    // Update with black
    const result = await compareScreenshot('overwrite', black, {
      snapshotDir: testDir,
      updateMode: true,
    });

    expect(result.status).toBe('updated');
    const updated = await readFile(join(testDir, 'overwrite.png'));
    expect(updated.equals(original)).toBe(false);
  });

  it('creates diff directory on failure if it does not exist', async () => {
    const a = makeFramebuffer();
    const b = makeFilledFramebuffer(0xff);

    await compareScreenshot('mkdiff', a, {
      snapshotDir: testDir,
      updateMode: true,
    });

    // diff/ directory should not exist yet
    await expect(access(join(testDir, 'diff'))).rejects.toThrow();

    const result = await compareScreenshot('mkdiff', b, {
      snapshotDir: testDir,
    });

    expect(result.status).toBe('fail');
    // diff/ directory should now exist with the diff PNG
    const diffPng = await readFile(result.diffPath!);
    expect(diffPng.length).toBeGreaterThan(0);
  });

  it('throws on wrong-dimension reference PNG', async () => {
    const captured = makeFramebuffer();

    // Write a valid but wrong-dimension PNG (1x1 white pixel) as the reference
    const { PNG } = await import('pngjs');
    const png = new PNG({ height: 1, width: 1 });
    png.data = Buffer.alloc(4);
    png.data[0] = 255;
    png.data[1] = 255;
    png.data[2] = 255;
    png.data[3] = 255;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      png
        .pack()
        .on('data', (chunk: Buffer) => chunks.push(chunk))
        .on('end', () => resolve());
    });
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(join(testDir, 'wrong-dim.png'), Buffer.concat(chunks));

    await expect(
      compareScreenshot('wrong-dim', captured, { snapshotDir: testDir }),
    ).rejects.toThrow(/1x1.*expected 400x240/);
  });

  it('throws on corrupt reference PNG', async () => {
    const captured = makeFramebuffer();

    // Write garbage as the reference
    const refPath = join(testDir, 'corrupt.png');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(refPath, Buffer.from('not a png'));

    await expect(
      compareScreenshot('corrupt', captured, { snapshotDir: testDir }),
    ).rejects.toThrow();
  });
});
