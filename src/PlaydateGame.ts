import type { CompareResult, ScreenshotOptions } from './assert/Screenshot';
import type { TcpServerOptions } from './connection/tcpServer';
import type { Message } from './types';

import { compareScreenshot } from './assert/Screenshot';
import { TcpServer } from './connection/tcpServer';
import { MSG_CAPTURE_FRAME, MSG_FRAME_DATA, MSG_PING, MSG_PONG } from './types';

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
