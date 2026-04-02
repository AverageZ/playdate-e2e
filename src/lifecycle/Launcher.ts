import type { ChildProcess } from 'child_process';

import { spawn } from 'child_process';
import { existsSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Platform-specific relative paths from PLAYDATE_SDK_PATH to the simulator binary.
 *
 * macOS uses an .app bundle, so the binary is nested inside Contents/MacOS.
 * Windows and Linux use a flat bin/ directory.
 */
const SIMULATOR_PATHS: Record<string, string> = {
  darwin: join(
    'bin',
    'Playdate Simulator.app',
    'Contents',
    'MacOS',
    'Playdate Simulator',
  ),
  linux: join('bin', 'PlaydateSimulator'),
  win32: join('bin', 'PlaydateSimulator.exe'),
};

/**
 * Resolve the absolute path to the Playdate Simulator binary.
 *
 * Reads PLAYDATE_SDK_PATH from the environment unless `sdkPath` is provided.
 * Throws with a diagnostic message if the SDK path is missing or the binary
 * does not exist at the expected platform-specific location.
 */
export function resolveSimulatorPath(sdkPath?: string): string {
  const sdk = sdkPath ?? process.env['PLAYDATE_SDK_PATH'];

  if (!sdk) {
    throw new Error(
      'PLAYDATE_SDK_PATH is not set. ' +
        'Install the Playdate SDK and set PLAYDATE_SDK_PATH to its root directory ' +
        '(e.g. export PLAYDATE_SDK_PATH=/path/to/PlaydateSDK).',
    );
  }

  const relativePath = SIMULATOR_PATHS[process.platform];

  if (!relativePath) {
    throw new Error(
      `Unsupported platform: ${process.platform}. ` +
        'The Playdate Simulator launcher supports darwin (macOS), win32 (Windows), and linux.',
    );
  }

  const binaryPath = join(sdk, relativePath);

  if (!existsSync(binaryPath)) {
    throw new Error(
      `Playdate Simulator not found at ${binaryPath}. ` +
        `Verify that PLAYDATE_SDK_PATH (${sdk}) points to a valid Playdate SDK installation ` +
        'and that the simulator is installed.',
    );
  }

  return binaryPath;
}

/**
 * Validate that a .pdx path exists and is a directory.
 *
 * Playdate games compile to a .pdx directory (not a single file).
 * This catches common mistakes before spawning the simulator.
 */
export function validatePdxPath(pdxPath: string): void {
  if (!existsSync(pdxPath)) {
    throw new Error(
      `PDX path does not exist: ${pdxPath}. ` +
        'Build your game first (e.g. make or pdc) to produce the .pdx directory.',
    );
  }

  const stat = statSync(pdxPath);
  if (!stat.isDirectory()) {
    throw new Error(
      `PDX path is not a directory: ${pdxPath}. ` +
        'A .pdx bundle should be a directory, not a file. ' +
        'Check that you are pointing to the compiled .pdx output.',
    );
  }
}

/**
 * Spawn the Playdate Simulator with a .pdx game path.
 *
 * Returns the child process handle. The caller is responsible for killing
 * the process on cleanup (see PlaydateGame.close()).
 *
 * stdio: stdin is ignored, stdout and stderr are piped so the caller can
 * capture simulator output for diagnostics.
 */
export function spawnSimulator(
  simulatorPath: string,
  pdxPath: string,
): ChildProcess {
  const child = spawn(simulatorPath, [pdxPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Log simulator stderr for diagnostics — cap at 4 KiB to prevent
  // unbounded growth in long-running test suites.
  const MAX_STDERR_BYTES = 4096;
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > MAX_STDERR_BYTES) {
      stderr = stderr.slice(-MAX_STDERR_BYTES);
    }
  });

  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      // eslint-disable-next-line no-console -- diagnostic output for simulator crashes
      console.error(
        `Playdate Simulator exited with code ${code}${stderr ? `: ${stderr}` : ''}`,
      );
    }
  });

  return child;
}

/**
 * Kill a simulator process gracefully (SIGTERM), falling back to SIGKILL
 * after a timeout. Returns a promise that resolves when the process exits.
 *
 * Includes a hard deadline so test teardown is never permanently blocked,
 * even if the process enters an uninterruptible state and never emits 'exit'.
 */
export function killSimulator(
  proc: ChildProcess,
  timeoutMs: number = 2000,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (proc.killed || proc.exitCode !== null) {
      resolve();

      return;
    }

    // Hard ceiling: resolve even if the process never emits 'exit'
    // (zombie, uninterruptible sleep). Test teardown must not hang.
    const hardDeadline = setTimeout(() => {
      resolve();
    }, timeoutMs + 500);

    const forceKillTimer = setTimeout(() => {
      if (!proc.killed && proc.exitCode === null) {
        proc.kill('SIGKILL');
      }
    }, timeoutMs);

    proc.on('exit', () => {
      clearTimeout(forceKillTimer);
      clearTimeout(hardDeadline);
      resolve();
    });

    proc.kill('SIGTERM');
  });
}
