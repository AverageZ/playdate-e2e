import type { ChildProcess } from 'child_process';

import * as cp from 'child_process';
import * as fs from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  killSimulator,
  resolveSimulatorPath,
  spawnSimulator,
  validatePdxPath,
} from './Launcher';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();

  return { ...actual };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof cp>();

  return { ...actual };
});

// --- resolveSimulatorPath ---

describe('resolveSimulatorPath', () => {
  const originalPlatform = process.platform;
  const originalEnv = process.env['PLAYDATE_SDK_PATH'];

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalEnv === undefined) {
      delete process.env['PLAYDATE_SDK_PATH'];
    } else {
      process.env['PLAYDATE_SDK_PATH'] = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it('throws when PLAYDATE_SDK_PATH is not set and no override provided', () => {
    delete process.env['PLAYDATE_SDK_PATH'];

    expect(() => resolveSimulatorPath()).toThrow(
      'PLAYDATE_SDK_PATH is not set',
    );
  });

  it('uses sdkPath override instead of env var', () => {
    process.env['PLAYDATE_SDK_PATH'] = '/env/sdk';
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = resolveSimulatorPath('/override/sdk');
    expect(result).toContain('/override/sdk');
    expect(result).not.toContain('/env/sdk');
  });

  it('resolves macOS simulator path', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const expected = join(
      '/sdk',
      'bin',
      'Playdate Simulator.app',
      'Contents',
      'MacOS',
      'Playdate Simulator',
    );

    expect(resolveSimulatorPath('/sdk')).toBe(expected);
  });

  it('resolves Windows simulator path', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const expected = join('/sdk', 'bin', 'PlaydateSimulator.exe');
    expect(resolveSimulatorPath('/sdk')).toBe(expected);
  });

  it('resolves Linux simulator path', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const expected = join('/sdk', 'bin', 'PlaydateSimulator');
    expect(resolveSimulatorPath('/sdk')).toBe(expected);
  });

  it('throws for unsupported platform', () => {
    Object.defineProperty(process, 'platform', { value: 'freebsd' });

    expect(() => resolveSimulatorPath('/sdk')).toThrow(
      'Unsupported platform: freebsd',
    );
  });

  it('returns path when binary exists', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = resolveSimulatorPath('/sdk');
    expect(result).toBe(
      join(
        '/sdk',
        'bin',
        'Playdate Simulator.app',
        'Contents',
        'MacOS',
        'Playdate Simulator',
      ),
    );
  });
});

// --- validatePdxPath ---

describe('validatePdxPath', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when path does not exist', () => {
    expect(() => validatePdxPath('/nonexistent/game.pdx')).toThrow(
      'PDX path does not exist',
    );
  });

  it('throws when path is a file, not a directory', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({
      isDirectory: () => false,
    } as ReturnType<typeof fs.statSync>);

    expect(() => validatePdxPath('/some/game.pdx')).toThrow(
      'PDX path is not a directory',
    );
  });

  it('passes when path is a valid directory', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({
      isDirectory: () => true,
    } as ReturnType<typeof fs.statSync>);

    expect(() => validatePdxPath('/valid/game.pdx')).not.toThrow();
  });
});

// --- spawnSimulator ---

describe('spawnSimulator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('spawns process with correct arguments', () => {
    const mockProcess = {
      exitCode: null,
      killed: false,
      on: vi.fn(),
      stderr: { on: vi.fn() },
    } as unknown as ChildProcess;

    vi.spyOn(cp, 'spawn').mockReturnValue(mockProcess);

    const result = spawnSimulator('/path/to/simulator', '/path/to/game.pdx');

    expect(cp.spawn).toHaveBeenCalledWith(
      '/path/to/simulator',
      ['/path/to/game.pdx'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(result).toBe(mockProcess);
  });

  it('registers stderr and exit event handlers', () => {
    const mockProcess = {
      exitCode: null,
      killed: false,
      on: vi.fn(),
      stderr: { on: vi.fn() },
    } as unknown as ChildProcess;

    vi.spyOn(cp, 'spawn').mockReturnValue(mockProcess);

    spawnSimulator('/path/to/simulator', '/path/to/game.pdx');

    expect(mockProcess.stderr!.on).toHaveBeenCalledWith(
      'data',
      expect.any(Function),
    );
    expect(mockProcess.on).toHaveBeenCalledWith('exit', expect.any(Function));
  });
});

// --- killSimulator ---

describe('killSimulator', () => {
  it('resolves immediately if process already killed', async () => {
    const proc = {
      exitCode: 0,
      kill: vi.fn(),
      killed: true,
      on: vi.fn(),
    } as unknown as ChildProcess;

    await killSimulator(proc);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('sends SIGTERM and resolves on exit', async () => {
    let exitCallback: (() => void) | undefined;
    const proc = {
      exitCode: null,
      kill: vi.fn(),
      killed: false,
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'exit') exitCallback = cb;
      }),
    } as unknown as ChildProcess;

    const promise = killSimulator(proc, 5000);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    // Simulate process exit
    exitCallback!();
    await promise;
  });

  it('sends SIGKILL after timeout if process does not exit', async () => {
    vi.useFakeTimers();
    const proc = {
      exitCode: null,
      kill: vi.fn(),
      killed: false,
      on: vi.fn(),
    } as unknown as ChildProcess;

    const promise = killSimulator(proc, 100);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    // Advance past the timeout
    vi.advanceTimersByTime(150);

    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

    // Simulate exit after SIGKILL — find the exit handler and call it
    const onCalls = (proc.on as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      () => void,
    ][];
    const exitHandler = onCalls.find((c) => c[0] === 'exit')?.[1];
    exitHandler?.();

    await promise;
    vi.useRealTimers();
  });
});
