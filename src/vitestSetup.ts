// AIDEV-NOTE: This file runs in the main vitest process (not in workers).
// Consumers add it to their vitest.config.ts:
//   test: { globalSetup: ['playdate-e2e/vitest-setup'] }

import type { GlobalSetupContext } from 'vitest/node';

export default function setup({ config, provide }: GlobalSetupContext): void {
  // vitest's SnapshotUpdateState: 'all' | 'new' | 'none'
  // 'all' = --update flag was passed (overwrite everything)
  // 'new' = default (create missing, don't overwrite existing)
  // 'none' = CI-safe strict mode (fail on missing)
  provide(
    'playdateUpdateSnapshots',
    config.snapshotOptions?.updateSnapshot ?? 'new',
  );
}
