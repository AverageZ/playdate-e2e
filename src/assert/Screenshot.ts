import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  decodePng,
  decodeFramebuffer,
  diffToPng,
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  framebufferToPng,
} from './FrameBuffer';

export type ScreenshotOptions = {
  /** Maximum number of differing pixels before failure. Default: 0 (exact match). */
  maxDiffPixels?: number;
  /** Directory for screenshot references. Required. */
  snapshotDir: string;
  /** When true, create or overwrite references instead of comparing. */
  updateMode?: boolean;
};

export type CompareResult = {
  diffCount?: number;
  diffPath?: string;
  referencePath: string;
  status: 'created' | 'fail' | 'missing' | 'pass' | 'updated';
};

/**
 * Compare a captured framebuffer against a reference screenshot on disk.
 *
 * - missing reference + updateMode=false → { status: 'missing' }
 * - missing reference + updateMode=true → save PNG, { status: 'created' }
 * - updateMode=true + existing ref → overwrite, { status: 'updated' }
 * - pixel diff <= maxDiffPixels → { status: 'pass' }
 * - pixel diff > maxDiffPixels → write diff PNG, { status: 'fail' }
 */
export async function compareScreenshot(
  name: string,
  captured: Buffer,
  options: ScreenshotOptions,
): Promise<CompareResult> {
  const { maxDiffPixels = 0, snapshotDir, updateMode = false } = options;
  const referencePath = join(snapshotDir, `${name}.png`);

  // Try to read existing reference
  let referencePng: Buffer | null = null;
  try {
    referencePng = await readFile(referencePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // No reference exists
  if (referencePng === null) {
    if (!updateMode) {
      return { referencePath, status: 'missing' };
    }

    await mkdir(dirname(referencePath), { recursive: true });
    const png = await framebufferToPng(captured);
    await writeFile(referencePath, png);

    // eslint-disable-next-line no-console -- CLAUDE.md requires visible console output on first-run
    console.log(
      `[playdate-e2e] Created reference screenshot: ${referencePath}`,
    );

    return { referencePath, status: 'created' };
  }

  // Update mode with existing reference — overwrite
  if (updateMode) {
    const png = await framebufferToPng(captured);
    await writeFile(referencePath, png);

    return { referencePath, status: 'updated' };
  }

  // Normal comparison: decode reference PNG → pixel buffer, compare
  const ref = await decodePng(referencePng);

  if (ref.width !== DISPLAY_WIDTH || ref.height !== DISPLAY_HEIGHT) {
    throw new Error(
      `Reference PNG is ${ref.width}x${ref.height}, expected ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT} (${referencePath})`,
    );
  }

  const capturedPixels = decodeFramebuffer(captured);

  // Count differing pixels and build diff buffer in a single pass
  const diffBuffer = Buffer.alloc(DISPLAY_WIDTH * DISPLAY_HEIGHT);
  let diffCount = 0;
  for (let i = 0; i < capturedPixels.length; i++) {
    if (capturedPixels[i] !== ref.pixels[i]) {
      diffBuffer[i] = 255;
      diffCount++;
    }
  }

  if (diffCount <= maxDiffPixels) {
    return { diffCount, referencePath, status: 'pass' };
  }

  // Failure — write diff image to disk
  const diffDir = join(snapshotDir, 'diff');
  await mkdir(diffDir, { recursive: true });
  const diffPath = join(diffDir, `${name}-diff.png`);
  const diffPng = await diffToPng(diffBuffer);
  await writeFile(diffPath, diffPng);

  return { diffCount, diffPath, referencePath, status: 'fail' };
}
