import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveSnapshotDir } from './resolveSnapshotDir';

describe('resolveSnapshotDir', () => {
  it('returns explicit dir when provided', () => {
    expect(resolveSnapshotDir('/custom/path')).toBe('/custom/path');
  });

  it('returns empty string when explicitly passed', () => {
    expect(resolveSnapshotDir('')).toBe('');
  });

  it('resolves __screenshots__ next to test file when no explicit dir', () => {
    // vitest sets testPath on expect.getState() — we're running in vitest, so it's available
    const testPath = expect.getState().testPath;
    expect(testPath).toBeDefined();

    const result = resolveSnapshotDir();
    expect(result).toBe(join(dirname(testPath!), '__screenshots__'));
  });

  it('prefers explicit dir over auto-resolution', () => {
    const result = resolveSnapshotDir('/explicit');
    expect(result).toBe('/explicit');
  });

  // AIDEV-NOTE: Can't test the "no testPath" error path because vitest
  // exposes testPath as a getter-only property. The throw is a defensive
  // guard for unusual runner configurations.
});
