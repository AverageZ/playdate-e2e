import { dirname, join } from 'node:path';
import { expect } from 'vitest';

/**
 * Resolve the screenshot directory.
 *
 * If an explicit path is provided, returns it directly.
 * Otherwise derives `__screenshots__/` next to the current test file
 * using vitest's `expect.getState().testPath`.
 */
export function resolveSnapshotDir(explicit?: string): string {
  if (explicit !== undefined) return explicit;

  const testPath = expect.getState().testPath;
  if (testPath) {
    return join(dirname(testPath), '__screenshots__');
  }

  throw new Error(
    'snapshotDir is required: could not resolve from vitest test path. ' +
      'Pass snapshotDir explicitly in options.',
  );
}
