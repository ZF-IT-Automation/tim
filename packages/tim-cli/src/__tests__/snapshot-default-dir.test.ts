import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { defaultSnapshotDir } from '../snapshot.js';

describe('snapshot default dir', () => {
  it('lives beside the DB under ~/.tim, not in /tmp (cleared at boot)', () => {
    expect(defaultSnapshotDir()).toBe(path.join(os.homedir(), '.tim', 'snapshots'));
  });
});
