import type { SnapshotUpdateState } from 'vitest';

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  export interface ProvidedContext {
    playdateUpdateSnapshots: SnapshotUpdateState;
  }
}
