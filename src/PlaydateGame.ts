import type { CompareResult, ScreenshotOptions } from './assert/Screenshot';
import type { TcpServerOptions } from './connection/tcpServer';
import type { Message } from './types';

import { xorFramebuffers } from './assert/FrameBuffer';
import { compareScreenshot } from './assert/Screenshot';
import { TcpServer } from './connection/tcpServer';
import {
  MSG_CAPTURE_FRAME,
  MSG_FRAME_DATA,
  MSG_PING,
  MSG_PONG,
  MSG_QUERY_STATE,
  MSG_STATE_NOT_FOUND,
  MSG_STATE_VALUE,
  StateType,
} from './types';

export type LaunchOptions = {
  /** Port for the TCP server. Default: 54321 */
  port?: number;
  /** Timeout in ms for connection + READY. Default: 10000 */
  timeout?: number;
};

/**
 * Connects to a Playdate game running in the simulator and provides
 * frame-synced test control via the wire protocol.
 *
 * Phase 1: TCP connection + PING/PONG frame sync only.
 * Simulator launch (Phase 5) is not yet implemented — the caller must
 * start the simulator manually or the game must already be running.
 */
export class PlaydateGame {
  private server: TcpServer;
  private timeout: number;
  private queryInFlight = false;

  private constructor(server: TcpServer, timeout: number) {
    this.server = server;
    this.timeout = timeout;
  }

  /**
   * Start a TCP server and wait for the game to connect and send READY.
   *
   * AIDEV-NOTE: Phase 1 does not launch the simulator. The game must
   * already be running and calling pdk_e2e_init() to connect.
   */
  static async launch(
    _pdxPath: string,
    options?: LaunchOptions,
  ): Promise<PlaydateGame> {
    const serverOpts: TcpServerOptions = {
      port: options?.port,
      timeout: options?.timeout,
    };
    const server = new TcpServer(serverOpts);
    const timeout = options?.timeout ?? 10_000;

    await server.listen();
    await server.waitForConnection(timeout);
    await server.waitForReady(timeout);

    return new PlaydateGame(server, timeout);
  }

  /**
   * Create a PlaydateGame from an already-connected TcpServer.
   * The caller is responsible for having completed the listen/connect/ready handshake.
   */
  static fromServer(server: TcpServer, timeout?: number): PlaydateGame {
    return new PlaydateGame(server, timeout ?? 10_000);
  }

  /**
   * Close the connection and stop the TCP server.
   *
   * AIDEV-NOTE: Phase 5 will also kill the simulator process here.
   */
  async close(): Promise<void> {
    await this.server.close();
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
   * - First run without updateMode: fails with a message to run with --update.
   * - With updateMode: creates or overwrites the reference PNG.
   * - Normal run: XOR comparison, fails if diff exceeds maxDiffPixels (default 0).
   */
  async toMatchScreenshot(
    name: string,
    options: ScreenshotOptions,
  ): Promise<CompareResult> {
    const raw = await this.screenshot();
    const result = await compareScreenshot(name, raw, options);

    switch (result.status) {
      case 'missing':
        throw new Error(
          `Screenshot "${name}" has no reference at ${result.referencePath}. ` +
            'Run with --update to create it.',
        );
      case 'fail':
        throw new Error(
          `Screenshot "${name}" differs by ${result.diffCount} pixels ` +
            `(max: ${options.maxDiffPixels ?? 0}). ` +
            `Diff saved to: ${result.diffPath}`,
        );
      case 'created':
      case 'updated':
      case 'pass':
        return result;
    }
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
