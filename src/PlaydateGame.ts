import type { ChildProcess } from 'child_process';
import type { SnapshotUpdateState } from 'vitest';

import type { CompareResult, ScreenshotOptions } from './assert/Screenshot';
import type { TcpServerOptions } from './connection/tcpServer';
import type { Message } from './types';

import { detectUpdateMode } from './assert/detectUpdateMode';
import { xorFramebuffers } from './assert/FrameBuffer';
import { resolveSnapshotDir } from './assert/resolveSnapshotDir';
import { compareScreenshot } from './assert/Screenshot';
import { TcpServer } from './connection/tcpServer';
import {
  killSimulator,
  resolveSimulatorPath,
  spawnSimulator,
  validatePdxPath,
} from './lifecycle/Launcher';
import {
  CRANK_NO_INJECT,
  MSG_CAPTURE_FRAME,
  MSG_FRAME_DATA,
  MSG_INJECT_INPUT,
  MSG_INPUT_ACK,
  MSG_PING,
  MSG_PONG,
  MSG_QUERY_STATE,
  MSG_RELEASE_INPUT,
  MSG_STATE_NOT_FOUND,
  MSG_STATE_VALUE,
  PlaydateButton,
  StateType,
} from './types';

export type LaunchOptions = {
  /** Port for the TCP server. Default: 54321 */
  port?: number;
  /** Timeout in ms for connection + READY. Default: 10000 */
  timeout?: number;
  /** Override PLAYDATE_SDK_PATH. Default: reads from env. */
  sdkPath?: string;
  /** If false, skip simulator spawn (assume already running). Default: true. */
  autoLaunch?: boolean;
};

/**
 * Connects to a Playdate game running in the simulator and provides
 * frame-synced test control via the wire protocol.
 *
 * By default, `launch()` spawns the simulator automatically using
 * PLAYDATE_SDK_PATH. Set `autoLaunch: false` to connect to an
 * already-running simulator instead.
 */
export class PlaydateGame {
  private server: TcpServer;
  private timeout: number;
  private simulatorProcess: ChildProcess | null;
  private closed = false;
  private queryInFlight = false;
  private lastCrankAngle: number = CRANK_NO_INJECT;

  private constructor(
    server: TcpServer,
    timeout: number,
    simulatorProcess: ChildProcess | null = null,
  ) {
    this.server = server;
    this.timeout = timeout;
    this.simulatorProcess = simulatorProcess;
  }

  /**
   * Launch the simulator with a .pdx game, start a TCP server, and wait
   * for the game to connect and send READY.
   *
   * Set `autoLaunch: false` to skip simulator spawning (assumes the
   * simulator is already running with the game loaded).
   */
  static async launch(
    pdxPath: string,
    options?: LaunchOptions,
  ): Promise<PlaydateGame> {
    const autoLaunch = options?.autoLaunch ?? true;
    const timeout = options?.timeout ?? 10_000;

    let simulatorProcess: ChildProcess | null = null;

    const serverOpts: TcpServerOptions = {
      port: options?.port,
      timeout: options?.timeout,
    };
    const server = new TcpServer(serverOpts);

    try {
      // Bind the TCP server BEFORE spawning the simulator so it can connect
      await server.listen();

      if (autoLaunch) {
        validatePdxPath(pdxPath);
        const simulatorPath = resolveSimulatorPath(options?.sdkPath);
        simulatorProcess = spawnSimulator(simulatorPath, pdxPath);
      }

      await server.waitForConnection(timeout);
      await server.waitForReady(timeout);
    } catch (err) {
      // Clean up simulator if connection fails
      if (simulatorProcess) {
        await killSimulator(simulatorProcess);
      }
      await server.close();
      throw err;
    }

    return new PlaydateGame(server, timeout, simulatorProcess);
  }

  /**
   * Create a PlaydateGame from an already-connected TcpServer.
   * The caller is responsible for having completed the listen/connect/ready handshake.
   */
  static fromServer(server: TcpServer, timeout?: number): PlaydateGame {
    return new PlaydateGame(server, timeout ?? 10_000);
  }

  /**
   * Close the connection, stop the TCP server, and kill the simulator
   * process if one was spawned by launch(). Safe to call multiple times.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    await this.server.close();

    if (this.simulatorProcess) {
      await killSimulator(this.simulatorProcess);
      this.simulatorProcess = null;
    }
  }

  /**
   * Advance the game by exactly `n` frames using PING/PONG synchronization.
   *
   * Each PING/PONG round-trip = one game frame. Sequential — waits for
   * each PONG before sending the next PING (protocol constraint).
   */
  async waitFrames(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      this.server.send({ type: MSG_PING });
      await this.server.receive(MSG_PONG, this.timeout);
    }
  }

  /**
   * Capture the current framebuffer from the simulator.
   *
   * Sends CAPTURE_FRAME, waits for FRAME_DATA (12,480 bytes raw LCD memory).
   */
  async screenshot(): Promise<Buffer> {
    // sendAndWait resolves only when the response type matches MSG_FRAME_DATA
    const response = await this.sendAndWait(
      { type: MSG_CAPTURE_FRAME },
      MSG_FRAME_DATA,
    );

    // AIDEV-NOTE: Type narrowing — sendAndWait guarantees the type match,
    // but the discriminated union requires a runtime check for TS to see .framebuffer
    if (response.type !== MSG_FRAME_DATA) {
      throw new Error(
        `Expected FRAME_DATA (0x${MSG_FRAME_DATA.toString(16)}), got 0x${response.type.toString(16)}`,
      );
    }

    return response.framebuffer;
  }

  /**
   * Capture a screenshot and compare against a reference PNG on disk.
   *
   * Update mode and snapshot directory are auto-detected from vitest when omitted:
   * - `--update` flag → overwrites all references
   * - Default → compares, but auto-creates missing references (first-run)
   * - Explicit `updateMode` / `snapshotDir` in options always takes precedence
   */
  async toMatchScreenshot(
    name: string,
    options?: ScreenshotOptions,
  ): Promise<CompareResult> {
    const snapshotDir = resolveSnapshotDir(options?.snapshotDir);

    // Determine effective update mode
    let updateMode = options?.updateMode;
    const vitestMode =
      updateMode === undefined ? detectUpdateMode() : undefined;

    if (updateMode === undefined) {
      updateMode = vitestMode === 'all';
    }

    // Auto-create missing references only when vitest provides a mode and
    // that mode is not 'none' (strict CI). When detectUpdateMode() returns
    // undefined (not in vitest, or global setup missing), default to strict —
    // never silently create references without explicit opt-in.
    const autoCreateMissing =
      options?.updateMode === undefined &&
      vitestMode !== undefined &&
      vitestMode !== 'none';

    const raw = await this.screenshot();
    const resolved = {
      maxDiffPixels: options?.maxDiffPixels,
      snapshotDir,
      updateMode,
    };
    const result = await compareScreenshot(name, raw, resolved);

    switch (result.status) {
      case 'missing':
        if (autoCreateMissing) {
          // AIDEV-NOTE: This re-enters compareScreenshot which does a redundant
          // readFile (ENOENT) before writing. Accepted trade-off: one extra
          // failed read per new screenshot, avoids restructuring compareScreenshot.
          return compareScreenshot(name, raw, {
            ...resolved,
            updateMode: true,
          });
        }
        throw new Error(
          `Screenshot "${name}" has no reference at ${result.referencePath}. ${this.missingReferenceHint(options?.updateMode, vitestMode)}`,
        );
      case 'fail':
        throw new Error(
          `Screenshot "${name}" differs by ${result.diffCount} pixels ` +
            `(max: ${options?.maxDiffPixels ?? 0}). ` +
            `Diff saved to: ${result.diffPath}`,
        );
      case 'created':
      case 'updated':
      case 'pass':
        return result;
    }
  }

  private missingReferenceHint(
    explicitUpdateMode: boolean | undefined,
    vitestMode: SnapshotUpdateState | undefined,
  ): string {
    if (explicitUpdateMode === false) {
      return 'updateMode is explicitly set to false. Remove the override or set updateMode: true to create it.';
    }

    if (vitestMode === undefined) {
      return (
        'Could not detect vitest update mode. ' +
        'Either add playdate-e2e/vitest-setup to your vitest globalSetup, ' +
        'or pass updateMode explicitly.'
      );
    }

    // vitestMode === 'none' (strict CI mode)
    return 'Run with --update to create it.';
  }

  /**
   * Query an int32 state value exposed by the game via pdk_e2e_expose_int().
   * Throws if the state name is not registered or the type does not match.
   */
  async queryInt(name: string): Promise<number> {
    const { stateType, value } = await this.queryState(name);
    if (stateType !== StateType.Int32) {
      throw new Error(
        `State "${name}" is ${StateType[stateType]}, not Int32. ` +
          'Use the matching query method for this type.',
      );
    }

    return value as number;
  }

  /**
   * Query a float32 state value exposed by the game via pdk_e2e_expose_float().
   * Throws if the state name is not registered or the type does not match.
   */
  async queryFloat(name: string): Promise<number> {
    const { stateType, value } = await this.queryState(name);
    if (stateType !== StateType.Float32) {
      throw new Error(
        `State "${name}" is ${StateType[stateType]}, not Float32. ` +
          'Use the matching query method for this type.',
      );
    }

    return value as number;
  }

  /**
   * Query a string state value exposed by the game via pdk_e2e_expose_string().
   * Throws if the state name is not registered or the type does not match.
   */
  async queryString(name: string): Promise<string> {
    const { stateType, value } = await this.queryState(name);
    if (stateType !== StateType.String) {
      throw new Error(
        `State "${name}" is ${StateType[stateType]}, not String. ` +
          'Use the matching query method for this type.',
      );
    }

    return value as string;
  }

  /** Send QUERY_STATE and wait for STATE_VALUE or STATE_NOT_FOUND. */
  private async queryState(
    name: string,
  ): Promise<{ stateType: StateType; value: number | string }> {
    if (this.queryInFlight) {
      throw new Error(
        'A queryState call is already in-flight. Queries must be sequential.',
      );
    }
    this.queryInFlight = true;

    let response: Message;
    try {
      this.server.send({ name, type: MSG_QUERY_STATE });

      response = await this.server.receiveAny(
        [MSG_STATE_VALUE, MSG_STATE_NOT_FOUND],
        this.timeout,
      );
    } catch (err) {
      throw new Error(
        `queryState("${name}") failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.queryInFlight = false;
    }

    if (response.type === MSG_STATE_NOT_FOUND) {
      throw new Error(
        `State "${name}" is not registered on the game side. ` +
          'Ensure the game calls pdk_e2e_expose_int/float/string() for this name.',
      );
    }

    // receiveAny constrains return to MSG_STATE_VALUE | MSG_STATE_NOT_FOUND,
    // so after the NOT_FOUND check above, this must be STATE_VALUE.
    const stateMsg = response as Message & { type: typeof MSG_STATE_VALUE };

    return { stateType: stateMsg.stateType, value: stateMsg.value };
  }

  /**
   * Wait until the framebuffer differs from the current frame.
   * Captures a baseline, then polls each frame until pixels change.
   * Each screenshot() call advances one game frame (CAPTURE_FRAME round-trip).
   * Throws if timeout is reached without a change.
   */
  async waitUntilScreenChanges(options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? this.timeout;
    const deadline = Date.now() + timeout;
    const baseline = await this.screenshot();

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `waitUntilScreenChanges timed out after ${timeout}ms — ` +
            'the screen did not change. Check that the game is updating its display.',
        );
      }

      const current = await this.screenshot();
      const { diffCount } = xorFramebuffers(baseline, current);
      if (diffCount > 0) {
        return;
      }
    }
  }

  /**
   * Wait until a named state value satisfies a predicate.
   * Polls QUERY_STATE each frame until the predicate returns true.
   * Each queryState() call advances one game frame (QUERY_STATE round-trip).
   * Throws immediately if the state name is not registered.
   * Throws if timeout is reached without the predicate returning true.
   */
  async waitUntilState<T extends number | string>(
    name: string,
    predicate: (value: T) => boolean,
    options?: { timeout?: number },
  ): Promise<T> {
    const timeout = options?.timeout ?? this.timeout;
    const deadline = Date.now() + timeout;

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `waitUntilState("${name}") timed out after ${timeout}ms — ` +
            'predicate never returned true.',
        );
      }

      // queryState throws on STATE_NOT_FOUND — let it propagate immediately
      const { value } = await this.queryState(name);
      // queryState returns number | string; T narrows this via the caller's type param
      const typed = value as T;
      if (predicate(typed)) {
        return typed;
      }
    }
  }

  /**
   * Wait until the framebuffer stops changing for N consecutive frames.
   * Useful for waiting for animations to complete.
   * Each screenshot() call advances one game frame (CAPTURE_FRAME round-trip).
   * Default settleFrames: 3. Throws if timeout is reached.
   */
  async waitUntilStable(options?: {
    settleFrames?: number;
    timeout?: number;
  }): Promise<void> {
    const timeout = options?.timeout ?? this.timeout;
    const settleTarget = options?.settleFrames ?? 3;
    const deadline = Date.now() + timeout;

    let previous = await this.screenshot();
    let settleCount = 0;

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `waitUntilStable timed out after ${timeout}ms — ` +
            `screen was still changing (reached ${settleCount}/${settleTarget} consecutive identical frames).`,
        );
      }

      const current = await this.screenshot();
      const { diffCount } = xorFramebuffers(previous, current);

      if (diffCount === 0) {
        settleCount++;
        if (settleCount >= settleTarget) {
          return;
        }
      } else {
        settleCount = 0;
        previous = current;
      }
    }
  }

  // --- Input helpers ---

  /** Press the A button. */
  async pressA(): Promise<void> {
    await this.pressButtons(PlaydateButton.A);
  }

  /** Press the B button. */
  async pressB(): Promise<void> {
    await this.pressButtons(PlaydateButton.B);
  }

  /** Press D-pad up. */
  async dpadUp(): Promise<void> {
    await this.pressButtons(PlaydateButton.Up);
  }

  /** Press D-pad down. */
  async dpadDown(): Promise<void> {
    await this.pressButtons(PlaydateButton.Down);
  }

  /** Press D-pad left. */
  async dpadLeft(): Promise<void> {
    await this.pressButtons(PlaydateButton.Left);
  }

  /** Press D-pad right. */
  async dpadRight(): Promise<void> {
    await this.pressButtons(PlaydateButton.Right);
  }

  /** Press an arbitrary combination of buttons. */
  async pressButtons(...buttons: PlaydateButton[]): Promise<void> {
    if (buttons.length === 0) {
      throw new Error('pressButtons requires at least one button');
    }

    let bitmask = 0;
    for (const b of buttons) {
      bitmask |= b;
    }

    await this.sendAndWait(
      {
        buttons: bitmask,
        crankAngle: this.lastCrankAngle,
        type: MSG_INJECT_INPUT,
      },
      MSG_INPUT_ACK,
    );
  }

  /** Set the crank to an absolute angle (degrees). Angles are sent as-is — no normalization to [0, 360). */
  async setCrank(angle: number): Promise<void> {
    await this.sendAndWait(
      { buttons: 0, crankAngle: angle, type: MSG_INJECT_INPUT },
      MSG_INPUT_ACK,
    );
    this.lastCrankAngle = angle;
  }

  /** Rotate the crank by a delta (degrees) from the last sent angle. No normalization — angles accumulate. */
  async rotateCrank(delta: number): Promise<void> {
    const base =
      this.lastCrankAngle === CRANK_NO_INJECT ? 0 : this.lastCrankAngle;
    const newAngle = base + delta;
    await this.sendAndWait(
      { buttons: 0, crankAngle: newAngle, type: MSG_INJECT_INPUT },
      MSG_INPUT_ACK,
    );
    this.lastCrankAngle = newAngle;
  }

  /** Release all injected input (buttons and crank). */
  async releaseInput(): Promise<void> {
    await this.sendAndWait({ type: MSG_RELEASE_INPUT }, MSG_INPUT_ACK);
    this.lastCrankAngle = CRANK_NO_INJECT;
  }

  /** Press a button, hold for `holdFrames` frames, then release all injected input (including any active crank angle). */
  async tap(button: PlaydateButton, holdFrames: number = 1): Promise<void> {
    await this.pressButtons(button);
    await this.waitFrames(holdFrames);
    await this.releaseInput();
  }

  /** Wait for a duration in milliseconds (real time, not frame-synced). */
  async waitMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Send a protocol message and wait for a response of the expected type. */
  async sendAndWait(
    command: Message,
    responseType: number,
    timeout?: number,
  ): Promise<Message> {
    this.server.send(command);

    return this.server.receive(responseType, timeout ?? this.timeout);
  }
}
