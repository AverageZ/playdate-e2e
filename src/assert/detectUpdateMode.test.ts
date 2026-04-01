import { describe, expect, it } from 'vitest';

import { detectUpdateMode } from './detectUpdateMode';

// AIDEV-NOTE: This is an integration test — it verifies that vitest.config.ts
// wires the global setup correctly, not detectUpdateMode in isolation.
// If the provide key changes, this test will surface the breakage.
describe('detectUpdateMode', () => {
  it('returns "new" in a normal test run (no --update flag)', () => {
    const result = detectUpdateMode();
    expect(result).toBe('new');
  });
});
