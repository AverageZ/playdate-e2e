import type { Socket } from 'net';

import { connect } from 'net';
import { afterEach, describe, expect, it } from 'vitest';

import { encodeMessage, ProtocolParser } from './connection/protocol';
import { PlaydateGame } from './PlaydateGame';
import {
  FRAME_DATA_SIZE,
  MSG_CAPTURE_FRAME,
  MSG_ERROR,
  MSG_FRAME_DATA,
  MSG_PING,
  MSG_PONG,
  MSG_QUERY_STATE,
  MSG_READY,
  MSG_STATE_NOT_FOUND,
  MSG_STATE_VALUE,
  StateType,
} from './types';

// Helper: connect a mock game client that sends READY on connection
async function connectMockGame(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const client = connect({ host: '127.0.0.1', port }, () => {
      client.write(encodeMessage({ type: MSG_READY }));
      resolve(client);
    });
    client.on('error', reject);
  });
}

describe('PlaydateGame', () => {
  let game: PlaydateGame | null = null;
  let mockClient: Socket | null = null;

  afterEach(async () => {
    mockClient?.destroy();
    mockClient = null;
    await game?.close();
    game = null;
  });

  it('waitFrames sends n PINGs and receives n PONGs', async () => {
    // Use the TcpServer directly for testability
    const { TcpServer } = await import('./connection/tcpServer');
    const server = new TcpServer({ port: 0, timeout: 2000 });
    await server.listen();

    mockClient = await connectMockGame(server.listeningPort);
    await server.waitForConnection(1000);
    await server.waitForReady(1000);

    game = PlaydateGame.fromServer(server, 2000);

    // Set up mock game to respond to PINGs with PONGs
    const parser = new ProtocolParser();
    let pingCount = 0;

    mockClient.on('data', (chunk: Buffer) => {
      parser.push(chunk);
      for (const msg of parser.parse()) {
        if (msg.type === MSG_PING) {
          pingCount++;
          mockClient!.write(encodeMessage({ type: MSG_PONG }));
        }
      }
    });

    await game.waitFrames(5);
    expect(pingCount).toBe(5);
  });

  it('waitFrames(0) completes immediately', async () => {
    const { TcpServer } = await import('./connection/tcpServer');
    const server = new TcpServer({ port: 0, timeout: 2000 });
    await server.listen();

    mockClient = await connectMockGame(server.listeningPort);
    await server.waitForConnection(1000);
    await server.waitForReady(1000);

    game = PlaydateGame.fromServer(server, 2000);

    await game.waitFrames(0);
    // Should complete immediately without sending any PINGs
  });

  it('sendAndWait sends command and receives response', async () => {
    const { TcpServer } = await import('./connection/tcpServer');
    const server = new TcpServer({ port: 0, timeout: 2000 });
    await server.listen();

    mockClient = await connectMockGame(server.listeningPort);
    await server.waitForConnection(1000);
    await server.waitForReady(1000);

    game = PlaydateGame.fromServer(server, 2000);

    // Mock game responds to any message with ERROR
    mockClient.on('data', () => {
      mockClient!.write(
        encodeMessage({ message: 'test error', type: MSG_ERROR }),
      );
    });

    const response = await game.sendAndWait(
      { type: MSG_PING },
      MSG_ERROR,
      1000,
    );
    expect(response.type).toBe(MSG_ERROR);
    if (response.type === MSG_ERROR) {
      expect(response.message).toBe('test error');
    }
  });

  it('waitFrames times out if game stops responding', async () => {
    const { TcpServer } = await import('./connection/tcpServer');
    const server = new TcpServer({ port: 0, timeout: 200 });
    await server.listen();

    mockClient = await connectMockGame(server.listeningPort);
    await server.waitForConnection(1000);
    await server.waitForReady(1000);

    game = PlaydateGame.fromServer(server, 200);

    // Mock game does NOT respond to PINGs
    await expect(game.waitFrames(1)).rejects.toThrow(/timed out/);
  });

  it('screenshot sends CAPTURE_FRAME and returns framebuffer', async () => {
    const { TcpServer } = await import('./connection/tcpServer');
    const server = new TcpServer({ port: 0, timeout: 2000 });
    await server.listen();

    mockClient = await connectMockGame(server.listeningPort);
    await server.waitForConnection(1000);
    await server.waitForReady(1000);

    game = PlaydateGame.fromServer(server, 2000);

    // Fill framebuffer with a known pattern
    const testFramebuffer = Buffer.alloc(FRAME_DATA_SIZE);
    testFramebuffer[0] = 0xde;
    testFramebuffer[FRAME_DATA_SIZE - 1] = 0xad;

    // Mock game responds to CAPTURE_FRAME with FRAME_DATA
    const parser = new ProtocolParser();
    mockClient.on('data', (chunk: Buffer) => {
      parser.push(chunk);
      for (const msg of parser.parse()) {
        if (msg.type === MSG_CAPTURE_FRAME) {
          mockClient!.write(
            encodeMessage({
              framebuffer: testFramebuffer,
              type: MSG_FRAME_DATA,
            }),
          );
        }
      }
    });

    const result = await game.screenshot();
    expect(result.length).toBe(FRAME_DATA_SIZE);
    expect(result[0]).toBe(0xde);
    expect(result[FRAME_DATA_SIZE - 1]).toBe(0xad);
  });

  it('screenshot times out if game does not respond', async () => {
    const { TcpServer } = await import('./connection/tcpServer');
    const server = new TcpServer({ port: 0, timeout: 200 });
    await server.listen();

    mockClient = await connectMockGame(server.listeningPort);
    await server.waitForConnection(1000);
    await server.waitForReady(1000);

    game = PlaydateGame.fromServer(server, 200);

    // Mock game does NOT respond to CAPTURE_FRAME
    await expect(game.screenshot()).rejects.toThrow(/timed out/);
  });

  it('queryInt sends QUERY_STATE and returns int32 value', async () => {
    const { TcpServer } = await import('./connection/tcpServer');
    const server = new TcpServer({ port: 0, timeout: 2000 });
    await server.listen();

    mockClient = await connectMockGame(server.listeningPort);
    await server.waitForConnection(1000);
    await server.waitForReady(1000);

    game = PlaydateGame.fromServer(server, 2000);

    const parser = new ProtocolParser();
    const queriedNames: string[] = [];
    mockClient.on('data', (chunk: Buffer) => {
      parser.push(chunk);
      for (const msg of parser.parse()) {
        if (msg.type === MSG_QUERY_STATE) {
          queriedNames.push(msg.name);
          mockClient!.write(
            encodeMessage({
              stateType: StateType.Int32,
              type: MSG_STATE_VALUE,
              value: 42,
            }),
          );
        }
      }
    });

    const result = await game.queryInt('score');
    expect(result).toBe(42);
    expect(queriedNames).toEqual(['score']);
  });

  it('queryFloat sends QUERY_STATE and returns float32 value', async () => {
    const { TcpServer } = await import('./connection/tcpServer');
    const server = new TcpServer({ port: 0, timeout: 2000 });
    await server.listen();

    mockClient = await connectMockGame(server.listeningPort);
    await server.waitForConnection(1000);
    await server.waitForReady(1000);

    game = PlaydateGame.fromServer(server, 2000);

    const parser = new ProtocolParser();
    mockClient.on('data', (chunk: Buffer) => {
      parser.push(chunk);
      for (const msg of parser.parse()) {
        if (msg.type === MSG_QUERY_STATE) {
          mockClient!.write(
            encodeMessage({
              stateType: StateType.Float32,
              type: MSG_STATE_VALUE,
              // float32 representation of 3.14 (precision loss from 64→32 bit)
              value: 3.140000104904175,
            }),
          );
        }
      }
    });

    const result = await game.queryFloat('speed');
    expect(result).toBeCloseTo(3.14, 2);
  });

  it('queryString sends QUERY_STATE and returns string value', async () => {
    const { TcpServer } = await import('./connection/tcpServer');
    const server = new TcpServer({ port: 0, timeout: 2000 });
    await server.listen();

    mockClient = await connectMockGame(server.listeningPort);
    await server.waitForConnection(1000);
    await server.waitForReady(1000);

    game = PlaydateGame.fromServer(server, 2000);

    const parser = new ProtocolParser();
    mockClient.on('data', (chunk: Buffer) => {
      parser.push(chunk);
      for (const msg of parser.parse()) {
        if (msg.type === MSG_QUERY_STATE) {
          mockClient!.write(
            encodeMessage({
              stateType: StateType.String,
              type: MSG_STATE_VALUE,
              value: 'hello',
            }),
          );
        }
      }
    });

    const result = await game.queryString('playerName');
    expect(result).toBe('hello');
  });

  it('queryString handles empty string value', async () => {
    const { TcpServer } = await import('./connection/tcpServer');
    const server = new TcpServer({ port: 0, timeout: 2000 });
    await server.listen();

    mockClient = await connectMockGame(server.listeningPort);
    await server.waitForConnection(1000);
    await server.waitForReady(1000);

    game = PlaydateGame.fromServer(server, 2000);

    const parser = new ProtocolParser();
    mockClient.on('data', (chunk: Buffer) => {
      parser.push(chunk);
      for (const msg of parser.parse()) {
        if (msg.type === MSG_QUERY_STATE) {
          mockClient!.write(
            encodeMessage({
              stateType: StateType.String,
              type: MSG_STATE_VALUE,
              value: '',
            }),
          );
        }
      }
    });

    const result = await game.queryString('emptyField');
    expect(result).toBe('');
  });

  it('queryInt throws when state name not registered', async () => {
    const { TcpServer } = await import('./connection/tcpServer');
    const server = new TcpServer({ port: 0, timeout: 2000 });
    await server.listen();

    mockClient = await connectMockGame(server.listeningPort);
    await server.waitForConnection(1000);
    await server.waitForReady(1000);

    game = PlaydateGame.fromServer(server, 2000);

    const parser = new ProtocolParser();
    mockClient.on('data', (chunk: Buffer) => {
      parser.push(chunk);
      for (const msg of parser.parse()) {
        if (msg.type === MSG_QUERY_STATE) {
          mockClient!.write(encodeMessage({ type: MSG_STATE_NOT_FOUND }));
        }
      }
    });

    await expect(game.queryInt('nonexistent')).rejects.toThrow(
      /not registered/,
    );
  });

  it('queryInt throws on type mismatch', async () => {
    const { TcpServer } = await import('./connection/tcpServer');
    const server = new TcpServer({ port: 0, timeout: 2000 });
    await server.listen();

    mockClient = await connectMockGame(server.listeningPort);
    await server.waitForConnection(1000);
    await server.waitForReady(1000);

    game = PlaydateGame.fromServer(server, 2000);

    // Game responds with Float32 when we expect Int32
    const parser = new ProtocolParser();
    mockClient.on('data', (chunk: Buffer) => {
      parser.push(chunk);
      for (const msg of parser.parse()) {
        if (msg.type === MSG_QUERY_STATE) {
          mockClient!.write(
            encodeMessage({
              stateType: StateType.Float32,
              type: MSG_STATE_VALUE,
              value: 3.14,
            }),
          );
        }
      }
    });

    await expect(game.queryInt('speed')).rejects.toThrow(/Float32, not Int32/);
  });

  it('queryInt times out if game does not respond', async () => {
    const { TcpServer } = await import('./connection/tcpServer');
    const server = new TcpServer({ port: 0, timeout: 200 });
    await server.listen();

    mockClient = await connectMockGame(server.listeningPort);
    await server.waitForConnection(1000);
    await server.waitForReady(1000);

    game = PlaydateGame.fromServer(server, 200);

    // Mock game does NOT respond to QUERY_STATE
    await expect(game.queryInt('score')).rejects.toThrow(/timed out/);
  });
});

// Helper: create a connected PlaydateGame with a mock client
async function setupGame(timeout = 2000) {
  const { TcpServer } = await import('./connection/tcpServer');
  const server = new TcpServer({ port: 0, timeout });
  await server.listen();
  const client = await connectMockGame(server.listeningPort);
  await server.waitForConnection(1000);
  await server.waitForReady(1000);
  const game = PlaydateGame.fromServer(server, timeout);
  const parser = new ProtocolParser();

  return { game, mockClient: client, parser, server };
}

describe('waitUntilScreenChanges', () => {
  let game: PlaydateGame | null = null;
  let mockClient: Socket | null = null;

  afterEach(async () => {
    mockClient?.destroy();
    mockClient = null;
    await game?.close();
    game = null;
  });

  it('resolves when the screen changes', async () => {
    const setup = await setupGame();
    game = setup.game;
    mockClient = setup.mockClient;

    const frameA = Buffer.alloc(FRAME_DATA_SIZE, 0x00);
    const frameB = Buffer.alloc(FRAME_DATA_SIZE, 0xff);
    let captureCount = 0;

    mockClient.on('data', (chunk: Buffer) => {
      setup.parser.push(chunk);
      for (const msg of setup.parser.parse()) {
        if (msg.type === MSG_CAPTURE_FRAME) {
          captureCount++;
          // First capture is baseline, subsequent captures return frameA then frameB
          const frame = captureCount <= 3 ? frameA : frameB;
          mockClient!.write(
            encodeMessage({ framebuffer: frame, type: MSG_FRAME_DATA }),
          );
        }
      }
    });

    await game.waitUntilScreenChanges({ timeout: 2000 });
    // Baseline capture + at least one more that differs
    expect(captureCount).toBeGreaterThanOrEqual(2);
  });

  it('resolves on first poll if frame already differs', async () => {
    const setup = await setupGame();
    game = setup.game;
    mockClient = setup.mockClient;

    let captureCount = 0;

    mockClient.on('data', (chunk: Buffer) => {
      setup.parser.push(chunk);
      for (const msg of setup.parser.parse()) {
        if (msg.type === MSG_CAPTURE_FRAME) {
          captureCount++;
          // Every capture returns a different frame
          const frame = Buffer.alloc(FRAME_DATA_SIZE, captureCount);
          mockClient!.write(
            encodeMessage({ framebuffer: frame, type: MSG_FRAME_DATA }),
          );
        }
      }
    });

    await game.waitUntilScreenChanges({ timeout: 2000 });
    // Baseline + one poll = 2 captures
    expect(captureCount).toBe(2);
  });

  it('times out when screen never changes', async () => {
    const setup = await setupGame(300);
    game = setup.game;
    mockClient = setup.mockClient;

    const staticFrame = Buffer.alloc(FRAME_DATA_SIZE, 0xaa);

    mockClient.on('data', (chunk: Buffer) => {
      setup.parser.push(chunk);
      for (const msg of setup.parser.parse()) {
        if (msg.type === MSG_CAPTURE_FRAME) {
          mockClient!.write(
            encodeMessage({ framebuffer: staticFrame, type: MSG_FRAME_DATA }),
          );
        }
      }
    });

    await expect(game.waitUntilScreenChanges({ timeout: 300 })).rejects.toThrow(
      /waitUntilScreenChanges timed out/,
    );
  });
});

describe('waitUntilState', () => {
  let game: PlaydateGame | null = null;
  let mockClient: Socket | null = null;

  afterEach(async () => {
    mockClient?.destroy();
    mockClient = null;
    await game?.close();
    game = null;
  });

  it('resolves when predicate matches and returns the value', async () => {
    const setup = await setupGame();
    game = setup.game;
    mockClient = setup.mockClient;

    let queryCount = 0;

    mockClient.on('data', (chunk: Buffer) => {
      setup.parser.push(chunk);
      for (const msg of setup.parser.parse()) {
        if (msg.type === MSG_QUERY_STATE) {
          queryCount++;
          mockClient!.write(
            encodeMessage({
              stateType: StateType.Int32,
              type: MSG_STATE_VALUE,
              value: queryCount,
            }),
          );
        }
      }
    });

    const result = await game.waitUntilState<number>('score', (v) => v >= 3, {
      timeout: 2000,
    });
    expect(result).toBe(3);
    expect(queryCount).toBe(3);
  });

  it('throws immediately on STATE_NOT_FOUND', async () => {
    const setup = await setupGame();
    game = setup.game;
    mockClient = setup.mockClient;

    mockClient.on('data', (chunk: Buffer) => {
      setup.parser.push(chunk);
      for (const msg of setup.parser.parse()) {
        if (msg.type === MSG_QUERY_STATE) {
          mockClient!.write(encodeMessage({ type: MSG_STATE_NOT_FOUND }));
        }
      }
    });

    await expect(
      game.waitUntilState('missing', () => true, { timeout: 2000 }),
    ).rejects.toThrow(/not registered/);
  });

  it('times out when predicate never matches', async () => {
    const setup = await setupGame(300);
    game = setup.game;
    mockClient = setup.mockClient;

    mockClient.on('data', (chunk: Buffer) => {
      setup.parser.push(chunk);
      for (const msg of setup.parser.parse()) {
        if (msg.type === MSG_QUERY_STATE) {
          mockClient!.write(
            encodeMessage({
              stateType: StateType.Int32,
              type: MSG_STATE_VALUE,
              value: 0,
            }),
          );
        }
      }
    });

    await expect(
      game.waitUntilState<number>('score', (v) => v > 100, { timeout: 300 }),
    ).rejects.toThrow(/waitUntilState\("score"\) timed out/);
  });

  it('works with string state values', async () => {
    const setup = await setupGame();
    game = setup.game;
    mockClient = setup.mockClient;

    let queryCount = 0;
    const states = ['loading', 'loading', 'ready'];

    mockClient.on('data', (chunk: Buffer) => {
      setup.parser.push(chunk);
      for (const msg of setup.parser.parse()) {
        if (msg.type === MSG_QUERY_STATE) {
          const value = states[queryCount] ?? 'ready';
          queryCount++;
          mockClient!.write(
            encodeMessage({
              stateType: StateType.String,
              type: MSG_STATE_VALUE,
              value,
            }),
          );
        }
      }
    });

    const result = await game.waitUntilState<string>(
      'screen',
      (v) => v === 'ready',
      { timeout: 2000 },
    );
    expect(result).toBe('ready');
  });
});

describe('waitUntilStable', () => {
  let game: PlaydateGame | null = null;
  let mockClient: Socket | null = null;

  afterEach(async () => {
    mockClient?.destroy();
    mockClient = null;
    await game?.close();
    game = null;
  });

  it('resolves after 3 consecutive identical frames (default)', async () => {
    const setup = await setupGame();
    game = setup.game;
    mockClient = setup.mockClient;

    const stableFrame = Buffer.alloc(FRAME_DATA_SIZE, 0xff);
    let captureCount = 0;

    mockClient.on('data', (chunk: Buffer) => {
      setup.parser.push(chunk);
      for (const msg of setup.parser.parse()) {
        if (msg.type === MSG_CAPTURE_FRAME) {
          captureCount++;
          // First 2 captures change, then stable from capture 3 onward
          const frame =
            captureCount <= 2
              ? Buffer.alloc(FRAME_DATA_SIZE, captureCount)
              : stableFrame;
          mockClient!.write(
            encodeMessage({ framebuffer: frame, type: MSG_FRAME_DATA }),
          );
        }
      }
    });

    await game.waitUntilStable({ timeout: 2000 });
    // Initial capture + frames until 3 consecutive identical
    expect(captureCount).toBeGreaterThanOrEqual(4);
  });

  it('respects custom settleFrames option', async () => {
    const setup = await setupGame();
    game = setup.game;
    mockClient = setup.mockClient;

    const stableFrame = Buffer.alloc(FRAME_DATA_SIZE, 0xaa);
    let captureCount = 0;

    mockClient.on('data', (chunk: Buffer) => {
      setup.parser.push(chunk);
      for (const msg of setup.parser.parse()) {
        if (msg.type === MSG_CAPTURE_FRAME) {
          captureCount++;
          // Always return the same frame — should settle in exactly settleFrames polls
          mockClient!.write(
            encodeMessage({ framebuffer: stableFrame, type: MSG_FRAME_DATA }),
          );
        }
      }
    });

    await game.waitUntilStable({ settleFrames: 5, timeout: 2000 });
    // Initial capture + 5 identical polls = 6 total captures
    expect(captureCount).toBe(6);
  });

  it('resets settle counter on intermittent change', async () => {
    const setup = await setupGame();
    game = setup.game;
    mockClient = setup.mockClient;

    let captureCount = 0;
    // Pattern: stable, stable, CHANGE, stable, stable, stable (settles after the change)
    // Captures: 1=initial, 2=same(1), 3=same(2), 4=diff(reset), 5=same(1), 6=same(2), 7=same(3=settle)
    const stableFrame = Buffer.alloc(FRAME_DATA_SIZE, 0xbb);
    const differentFrame = Buffer.alloc(FRAME_DATA_SIZE, 0xcc);

    mockClient.on('data', (chunk: Buffer) => {
      setup.parser.push(chunk);
      for (const msg of setup.parser.parse()) {
        if (msg.type === MSG_CAPTURE_FRAME) {
          captureCount++;
          // Capture 4 is different, all others are stable
          const frame = captureCount === 4 ? differentFrame : stableFrame;
          mockClient!.write(
            encodeMessage({ framebuffer: frame, type: MSG_FRAME_DATA }),
          );
        }
      }
    });

    await game.waitUntilStable({ timeout: 2000 });
    // 1(baseline=bb) + 2(bb,settle=1) + 3(bb,settle=2) + 4(cc,diff,reset,prev=cc)
    // + 5(bb,diff from cc,reset,prev=bb) + 6(bb,settle=1) + 7(bb,settle=2) + 8(bb,settle=3→done)
    expect(captureCount).toBe(8);
  });

  it('times out when frames keep changing', async () => {
    const setup = await setupGame(300);
    game = setup.game;
    mockClient = setup.mockClient;

    let captureCount = 0;

    mockClient.on('data', (chunk: Buffer) => {
      setup.parser.push(chunk);
      for (const msg of setup.parser.parse()) {
        if (msg.type === MSG_CAPTURE_FRAME) {
          captureCount++;
          // Every frame is different
          const frame = Buffer.alloc(FRAME_DATA_SIZE, captureCount % 256);
          mockClient!.write(
            encodeMessage({ framebuffer: frame, type: MSG_FRAME_DATA }),
          );
        }
      }
    });

    await expect(game.waitUntilStable({ timeout: 300 })).rejects.toThrow(
      /waitUntilStable timed out/,
    );
  });
});
