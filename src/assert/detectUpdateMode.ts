import type { SnapshotUpdateState } from 'vitest';

import { inject } from 'vitest';

/**
 * Read the snapshot update state provided by playdate-e2e's vitest global setup.
 *
 * Returns 'all' when --update was passed, 'new' by default, 'none' in strict CI mode.
 * Returns undefined if called outside a vitest worker (e.g. no global setup configured,
 * or the library is used from a non-vitest runner).
 */
export function detectUpdateMode(): SnapshotUpdateState | undefined {
  try {
    const mode = inject('playdateUpdateSnapshots');
    // inject() returns undefined when the key was never provided
    if (typeof mode !== 'string') return undefined;

    return mode;
  } catch {
    return undefined;
  }
}
