import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, getConfigPath } from 'tim-core';
import {
  startIdleSweepTimer,
  stopIdleSweepTimer,
  isIdleSweepTimerRunning,
} from '../idle-sweep-timer.js';
import { TimStore } from 'tim-store';

describe('idle sweep timer (criteria 11–12)', () => {
  let store: TimStore;
  let home: string;

  beforeEach(() => {
    store = new TimStore(':memory:');
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-idle-timer-'));
    vi.stubEnv('HOME', home);
    stopIdleSweepTimer();
  });

  afterEach(() => {
    stopIdleSweepTimer();
    vi.unstubAllEnvs();
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('criterion 11: does not start when TIM_SUMMARIZER=1', () => {
    vi.stubEnv('TIM_SUMMARIZER', '1');
    startIdleSweepTimer(store);
    expect(isIdleSweepTimerRunning()).toBe(false);
  });

  it('criterion 12: does not start when idle_sweep.enabled is false', () => {
    fs.mkdirSync(path.join(home, '.tim'), { recursive: true });
    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({ summarizer: { idle_sweep: { enabled: false } } }),
    );
    expect(loadConfig().summarizer?.idle_sweep?.enabled).toBe(false);
    startIdleSweepTimer(store);
    expect(isIdleSweepTimerRunning()).toBe(false);
  });

  it('starts when enabled (default config)', () => {
    startIdleSweepTimer(store);
    expect(isIdleSweepTimerRunning()).toBe(true);
    startIdleSweepTimer(store);
    expect(isIdleSweepTimerRunning()).toBe(true);
    stopIdleSweepTimer();
    expect(isIdleSweepTimerRunning()).toBe(false);
  });
});
