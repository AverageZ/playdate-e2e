import type { Socket } from 'net';
import type { Server } from 'net';

import { createServer } from 'net';

import type { Message } from '../types';

import { MSG_READY } from '../types';
import { encodeMessage, ProtocolParser } from './protocol';

export type TcpServerOptions = {
  /** Port to listen on. Default: 54321 */
  port?: number;
  /** Timeout in ms for waiting for a connection. Default: 10000 */
  timeout?: number;
};

const DEFAULT_PORT = 54321;
const DEFAULT_TIMEOUT = 10_000;

/**
 * TCP server that accepts a single game connection.
 *
 * Lifecycle: listen() -> waitForConnection() -> waitForReady() -> send/receive -> close()
 */
export class TcpServer {
  private server: Server | null = null;
  private socket: Socket | null = null;
  private parser = new ProtocolParser();
  private pendingMessages: Message[] = [];
  private waiters: Array<(msg: Message) => void> = [];
  private port: number;
  private timeout: number;

  constructor(options?: TcpServerOptions) {
    this.port = options?.port ?? DEFAULT_PORT;
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  }

  /** Start listening for a game connection. */
  async listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        if (this.socket) {
          // Reject additional connections
          socket.destroy();

          return;
        }
        this.socket = socket;
        socket.on('data', (chunk: Buffer) => this.onData(chunk));
        socket.on('error', () => {
          // Connection errors are surfaced via receive() timeouts
        });
      });

      this.server.on('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  /** Wait for the game to connect (TCP handshake). */
  async waitForConnection(timeout?: number): Promise<void> {
    const ms = timeout ?? this.timeout;
    if (this.socket) return;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `waitForConnection timed out after ${ms}ms. ` +
              'Is the simulator running? Is the game calling pdk_e2e_init()?',
          ),
        );
      }, ms);

      const check = setInterval(() => {
        if (this.socket) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
  }

  /** Wait for the READY message from the game. */
  async waitForReady(timeout?: number): Promise<void> {
    const msg = await this.receive(MSG_READY, timeout);
    if (msg.type !== MSG_READY) {
      throw new Error(
        `Expected READY (0xFE) from game, got message type 0x${msg.type.toString(16)}`,
      );
    }
  }

  /** Send an encoded message to the game. */
  send(msg: Message): void {
    if (!this.socket) {
      throw new Error('Cannot send: no game connected');
    }
    this.socket.write(encodeMessage(msg));
  }

  /** Wait for a message of the given type. */
  async receive(expectedType: number, timeout?: number): Promise<Message> {
    const ms = timeout ?? this.timeout;

    // Check pending messages first
    const idx = this.pendingMessages.findIndex((m) => m.type === expectedType);
    if (idx !== -1) {
      return this.pendingMessages.splice(idx, 1)[0];
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this waiter
        const wi = this.waiters.indexOf(waiter);
        if (wi !== -1) this.waiters.splice(wi, 1);
        reject(
          new Error(
            `receive(0x${expectedType.toString(16)}) timed out after ${ms}ms. ` +
              'The game may have stopped responding or crashed.',
          ),
        );
      }, ms);

      const waiter = (msg: Message) => {
        if (msg.type === expectedType) {
          clearTimeout(timer);
          const wi = this.waiters.indexOf(waiter);
          if (wi !== -1) this.waiters.splice(wi, 1);
          resolve(msg);
        }
      };

      this.waiters.push(waiter);
    });
  }

  /** Close the server and socket. */
  async close(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.server = null;
          resolve();
        });
      });
    }
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  /** The port the server is listening on. Reflects the OS-assigned port when constructed with port 0. */
  get listeningPort(): number {
    const addr = this.server?.address();

    if (addr && typeof addr !== 'string') {
      return addr.port;
    }

    return this.port;
  }

  private onData(chunk: Buffer): void {
    this.parser.push(chunk);
    const messages = this.parser.parse();

    for (const msg of messages) {
      let consumed = false;
      // Try to satisfy a waiter
      for (const waiter of [...this.waiters]) {
        waiter(msg);
        // If the waiter removed itself, it consumed the message
        if (!this.waiters.includes(waiter)) {
          consumed = true;
          break;
        }
      }

      if (!consumed) {
        this.pendingMessages.push(msg);
      }
    }
  }
}
