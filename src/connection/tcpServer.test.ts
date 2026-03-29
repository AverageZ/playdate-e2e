import type { Socket } from 'net';

import { connect } from 'net';
import { afterEach, describe, expect, it } from 'vitest';

import { MSG_PING, MSG_PONG, MSG_READY } from '../types';
import { encodeMessage } from './protocol';
import { TcpServer } from './tcpServer';

// Helper: connect a raw TCP client to the server
function connectClient(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const client = connect({ host: '127.0.0.1', port }, () => resolve(client));
    client.on('error', reject);
  });
}

describe('TcpServer', () => {
  let server: TcpServer;
  let client: Socket | null = null;

  afterEach(async () => {
    client?.destroy();
    client = null;
    await server?.close();
  });

  it('accepts a connection on the specified port', async () => {
    server = new TcpServer({ port: 0, timeout: 2000 });
    await server.listen();

    // Get the actual port assigned by the OS
    const port = getPort(server);
    client = await connectClient(port);
    await server.waitForConnection(1000);

    expect(server.connected).toBe(true);
  });

  it('receives READY from game', async () => {
    server = new TcpServer({ port: 0, timeout: 2000 });
    await server.listen();
    const port = getPort(server);

    client = await connectClient(port);
    await server.waitForConnection(1000);

    // Game sends READY
    client.write(encodeMessage({ type: MSG_READY }));
    await server.waitForReady(1000);

    // If we get here without timeout, READY was received
    expect(true).toBe(true);
  });

  it('sends a message to the game', async () => {
    server = new TcpServer({ port: 0, timeout: 2000 });
    await server.listen();
    const port = getPort(server);

    client = await connectClient(port);
    await server.waitForConnection(1000);

    // Send PING from runner
    const received = new Promise<Buffer>((resolve) => {
      client!.once('data', resolve);
    });
    server.send({ type: MSG_PING });

    const data = await received;
    expect(data).toEqual(Buffer.from([0x01, 0x00, 0x00]));
  });

  it('receives a specific message type', async () => {
    server = new TcpServer({ port: 0, timeout: 2000 });
    await server.listen();
    const port = getPort(server);

    client = await connectClient(port);
    await server.waitForConnection(1000);

    // Game sends PONG
    client.write(encodeMessage({ type: MSG_PONG }));
    const msg = await server.receive(MSG_PONG, 1000);
    expect(msg.type).toBe(MSG_PONG);
  });

  it('queues messages and delivers by type', async () => {
    server = new TcpServer({ port: 0, timeout: 2000 });
    await server.listen();
    const port = getPort(server);

    client = await connectClient(port);
    await server.waitForConnection(1000);

    // Game sends READY then PONG
    client.write(
      Buffer.concat([
        encodeMessage({ type: MSG_READY }),
        encodeMessage({ type: MSG_PONG }),
      ]),
    );

    // Wait a tick for data to arrive
    await new Promise((r) => setTimeout(r, 50));

    // Request PONG first — should skip READY in the queue
    const pong = await server.receive(MSG_PONG, 1000);
    expect(pong.type).toBe(MSG_PONG);

    // READY should still be pending
    const ready = await server.receive(MSG_READY, 1000);
    expect(ready.type).toBe(MSG_READY);
  });

  it('rejects additional connections', async () => {
    server = new TcpServer({ port: 0, timeout: 2000 });
    await server.listen();
    const port = getPort(server);

    client = await connectClient(port);
    await server.waitForConnection(1000);

    // Second client should be rejected
    const client2 = await connectClient(port);
    const destroyed = new Promise<void>((resolve) => {
      client2.on('close', () => resolve());
    });
    await destroyed;
    client2.destroy();
  });

  it('waitForConnection times out with descriptive error', async () => {
    server = new TcpServer({ port: 0, timeout: 100 });
    await server.listen();

    await expect(server.waitForConnection(100)).rejects.toThrow(
      /waitForConnection timed out/,
    );
  });

  it('receive times out with descriptive error', async () => {
    server = new TcpServer({ port: 0, timeout: 100 });
    await server.listen();
    const port = getPort(server);

    client = await connectClient(port);
    await server.waitForConnection(1000);

    await expect(server.receive(MSG_PONG, 100)).rejects.toThrow(
      /receive.*timed out/,
    );
  });

  it('send throws when no game connected', () => {
    server = new TcpServer({ port: 0 });
    expect(() => server.send({ type: MSG_PING })).toThrow(
      'Cannot send: no game connected',
    );
  });

  it('close is safe to call multiple times', async () => {
    server = new TcpServer({ port: 0 });
    await server.listen();
    await server.close();
    await server.close(); // should not throw
  });
});

// Helper to extract the actual listening port (OS-assigned with port: 0)
function getPort(server: TcpServer): number {
  // Access the underlying net.Server to get the port
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const addr = (server as any).server?.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Server not listening');
  }

  return addr.port;
}
