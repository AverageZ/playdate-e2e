/**
 * Integration tests: real C client ↔ TypeScript server over TCP.
 *
 * Spawns the C test_integration binary (compiled from c/tests/test_integration.c)
 * which uses POSIX sockets to implement the PlaydateTCP interface. The C binary
 * runs the real pdk_e2e state machine — same code that ships in games.
 *
 * These tests verify that the C encode/decode and TypeScript encode/decode agree
 * on the wire format over an actual TCP connection.
 */

import type { ChildProcess } from 'child_process';

import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { TcpServer } from './connection/tcpServer';
import { PlaydateGame } from './PlaydateGame';
import {
  FRAME_DATA_SIZE,
  MSG_INJECT_INPUT,
  MSG_INPUT_ACK,
  MSG_RELEASE_INPUT,
} from './types';

const C_BINARY_PATH = resolve(
  import.meta.dirname,
  '../c/tests/test_integration',
);

// Build the C binary before running any tests in this file.
// Skip the entire suite if compilation fails (e.g. no C compiler).
beforeAll(() => {
  try {
    execSync('make -C c integration', {
      cwd: resolve(import.meta.dirname, '..'),
      stdio: 'pipe',
    });
  } catch {
    throw new Error(
      'Failed to compile C integration binary. Ensure a C11 compiler is available.\n' +
        'Run `make -C c integration` manually to see the error.',
    );
  }

  if (!existsSync(C_BINARY_PATH)) {
    throw new Error(
      `C integration binary not found at ${C_BINARY_PATH}. ` +
        'Check the Makefile output path.',
    );
  }
});

describe('C ↔ TypeScript integration', () => {
  let server: TcpServer | null = null;
  let cProcess: ChildProcess | null = null;
  let game: PlaydateGame | null = null;

  afterEach(async () => {
    await game?.close();
    game = null;

    if (cProcess && !cProcess.killed) {
      cProcess.kill('SIGTERM');
      // Wait for the process to exit to avoid zombies
      await new Promise<void>((done) => {
        cProcess!.on('exit', () => done());
        setTimeout(() => done(), 1000);
      });
    }
    cProcess = null;

    await server?.close();
    server = null;
  });

  /**
   * Start the TCP server and spawn the C binary. Returns when the C client
   * has connected and sent READY.
   */
  async function launchCClient(timeout = 5000): Promise<void> {
    server = new TcpServer({ port: 0, timeout });
    await server.listen();
    const port = server.listeningPort;

    cProcess = spawn(C_BINARY_PATH, [String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Collect stderr for diagnostics on failure
    let stderr = '';
    cProcess.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    cProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`C binary exited with code ${code}: ${stderr}`);
      }
    });

    await server.waitForConnection(timeout);
    await server.waitForReady(timeout);

    game = PlaydateGame.fromServer(server, timeout);
  }

  it('C client connects and sends READY', async () => {
    // launchCClient already waits for READY — if it resolves, the test passes
    await launchCClient();
    expect(server!.connected).toBe(true);
  });

  it('PING/PONG round-trip over real TCP', async () => {
    await launchCClient();

    // waitFrames sends n PINGs and expects n PONGs
    // If the C side doesn't respond correctly, this times out
    await game!.waitFrames(3);
  });

  it('CAPTURE_FRAME sends correct framebuffer bytes', async () => {
    await launchCClient();

    const framebuffer = await game!.screenshot();

    // The shim produces alternating 0xAA/0x55 rows (52 bytes/row x 240 rows)
    expect(framebuffer.length).toBe(FRAME_DATA_SIZE);

    // Verify the pattern: even rows = 0xAA, odd rows = 0x55
    for (let row = 0; row < 240; row++) {
      const expected = row % 2 === 0 ? 0xaa : 0x55;
      const offset = row * 52;
      expect(framebuffer[offset]).toBe(expected);
      expect(framebuffer[offset + 51]).toBe(expected);
    }
  });

  it('INJECT_INPUT + INPUT_ACK cycle', async () => {
    await launchCClient();

    // Send INJECT_INPUT with button A (0x01) and crank angle 90.0
    const crankBuf = Buffer.alloc(4);
    crankBuf.writeFloatLE(90.0, 0);
    const payload = Buffer.alloc(5);
    payload[0] = 0x01; // Button A
    crankBuf.copy(payload, 1);

    const response = await game!.sendAndWait(
      { buttons: 0x01, crankAngle: 90.0, type: MSG_INJECT_INPUT },
      MSG_INPUT_ACK,
      3000,
    );
    expect(response.type).toBe(MSG_INPUT_ACK);

    // Also test RELEASE_INPUT
    const releaseResponse = await game!.sendAndWait(
      { type: MSG_RELEASE_INPUT },
      MSG_INPUT_ACK,
      3000,
    );
    expect(releaseResponse.type).toBe(MSG_INPUT_ACK);
  });

  it('QUERY_STATE with registered int value', async () => {
    await launchCClient();

    // The C binary exposes: score=42, speed=3.14f, name="alice"
    const score = await game!.queryInt('score');
    expect(score).toBe(42);
  });

  it('QUERY_STATE with registered float value', async () => {
    await launchCClient();

    const speed = await game!.queryFloat('speed');
    expect(speed).toBeCloseTo(3.14, 2);
  });

  it('QUERY_STATE with registered string value', async () => {
    await launchCClient();

    const name = await game!.queryString('name');
    expect(name).toBe('alice');
  });

  it('QUERY_STATE returns STATE_NOT_FOUND for unregistered name', async () => {
    await launchCClient();

    await expect(game!.queryInt('nonexistent')).rejects.toThrow(
      /not registered/,
    );
  });

  it('connection drop: TS side times out after C process exits', async () => {
    await launchCClient(2000);

    // Verify the connection is alive
    await game!.waitFrames(1);

    // Kill the C process — the OS closes the TCP socket
    cProcess!.kill('SIGKILL');
    await new Promise<void>((done) => {
      cProcess!.on('exit', () => done());
    });

    // AIDEV-NOTE: Node's TCP socket doesn't always get an immediate 'close'
    // event when the remote end is killed. The TS side detects this via
    // receive() timeout — the C side stops responding to commands.
    // Use a short timeout to keep the test fast.
    const shortTimeoutGame = PlaydateGame.fromServer(server!, 500);
    await expect(shortTimeoutGame.waitFrames(1)).rejects.toThrow(/timed out/);
  });
});

afterAll(async () => {
  // Extra safety: ensure no leaked server or process
});
