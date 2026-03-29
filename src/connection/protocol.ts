import type { Message } from '../types';

import { assertNever } from '../assertNever';
import {
  FRAME_DATA_SIZE,
  HEADER_SIZE,
  MAX_PAYLOAD_SIZE,
  MSG_CAPTURE_FRAME,
  MSG_ERROR,
  MSG_FRAME_DATA,
  MSG_INJECT_INPUT,
  MSG_INPUT_ACK,
  MSG_PING,
  MSG_PONG,
  MSG_QUERY_STATE,
  MSG_READY,
  MSG_RELEASE_INPUT,
  MSG_STATE_NOT_FOUND,
  MSG_STATE_VALUE,
  StateType,
} from '../types';

// --- Encoder ---

export function encodeMessage(msg: Message): Buffer {
  const payload = encodePayload(msg);
  const buf = Buffer.alloc(HEADER_SIZE + payload.length);
  buf.writeUInt8(msg.type, 0);
  buf.writeUInt16BE(payload.length, 1);
  payload.copy(buf, HEADER_SIZE);

  return buf;
}

function encodePayload(msg: Message): Buffer {
  switch (msg.type) {
    // Empty-payload messages
    case MSG_PING:
    case MSG_PONG:
    case MSG_CAPTURE_FRAME:
    case MSG_RELEASE_INPUT:
    case MSG_INPUT_ACK:
    case MSG_READY:
    case MSG_STATE_NOT_FOUND:
      return Buffer.alloc(0);

    case MSG_INJECT_INPUT: {
      const buf = Buffer.alloc(5);
      buf.writeUInt8(msg.buttons, 0);
      buf.writeFloatLE(msg.crankAngle, 1);

      return buf;
    }

    case MSG_QUERY_STATE: {
      // Null-terminated string
      const strBuf = Buffer.from(msg.name, 'utf-8');
      const buf = Buffer.alloc(strBuf.length + 1);
      strBuf.copy(buf);
      buf.writeUInt8(0, strBuf.length);

      return buf;
    }

    case MSG_FRAME_DATA:
      return msg.framebuffer;

    case MSG_STATE_VALUE:
      return encodeStateValue(msg.stateType, msg.value);

    case MSG_ERROR: {
      // Null-terminated string
      const errBuf = Buffer.from(msg.message, 'utf-8');
      const buf = Buffer.alloc(errBuf.length + 1);
      errBuf.copy(buf);
      buf.writeUInt8(0, errBuf.length);

      return buf;
    }
  }
}

function encodeStateValue(
  stateType: StateType,
  value: number | string,
): Buffer {
  switch (stateType) {
    case StateType.Int32: {
      const buf = Buffer.alloc(5);
      buf.writeUInt8(StateType.Int32, 0);
      buf.writeInt32LE(value as number, 1);

      return buf;
    }
    case StateType.Float32: {
      const buf = Buffer.alloc(5);
      buf.writeUInt8(StateType.Float32, 0);
      buf.writeFloatLE(value as number, 1);

      return buf;
    }
    case StateType.String: {
      const strBuf = Buffer.from(value as string, 'utf-8');
      // 1B type tag + string + null terminator
      const buf = Buffer.alloc(1 + strBuf.length + 1);
      buf.writeUInt8(StateType.String, 0);
      strBuf.copy(buf, 1);
      buf.writeUInt8(0, 1 + strBuf.length);

      return buf;
    }
  }
}

// --- Decoder ---

function decodePayload(type: number, payload: Buffer): Message | null {
  switch (type) {
    case MSG_PING:
      return { type: MSG_PING };
    case MSG_PONG:
      return { type: MSG_PONG };
    case MSG_CAPTURE_FRAME:
      return { type: MSG_CAPTURE_FRAME };
    case MSG_RELEASE_INPUT:
      return { type: MSG_RELEASE_INPUT };
    case MSG_INPUT_ACK:
      return { type: MSG_INPUT_ACK };
    case MSG_READY:
      return { type: MSG_READY };
    case MSG_STATE_NOT_FOUND:
      return { type: MSG_STATE_NOT_FOUND };

    case MSG_INJECT_INPUT: {
      if (payload.length !== 5) {
        return null;
      }

      return {
        buttons: payload.readUInt8(0),
        crankAngle: payload.readFloatLE(1),
        type: MSG_INJECT_INPUT,
      };
    }

    case MSG_QUERY_STATE: {
      if (payload.length < 1 || payload[payload.length - 1] !== 0) {
        return null;
      }

      return {
        name: payload.subarray(0, payload.length - 1).toString('utf-8'),
        type: MSG_QUERY_STATE,
      };
    }

    case MSG_FRAME_DATA: {
      if (payload.length !== FRAME_DATA_SIZE) {
        return null;
      }

      return {
        framebuffer: Buffer.from(payload),
        type: MSG_FRAME_DATA,
      };
    }

    case MSG_STATE_VALUE: {
      if (payload.length < 1) {
        return null;
      }
      const stateType = payload.readUInt8(0) as StateType;

      return decodeStateValue(stateType, payload.subarray(1));
    }

    case MSG_ERROR: {
      if (payload.length < 1 || payload[payload.length - 1] !== 0) {
        return null;
      }

      return {
        message: payload.subarray(0, payload.length - 1).toString('utf-8'),
        type: MSG_ERROR,
      };
    }

    default:
      // Unknown message type — skip it (length-prefixed framing lets us)
      return null;
  }
}

function decodeStateValue(stateType: StateType, data: Buffer): Message | null {
  switch (stateType) {
    case StateType.Int32: {
      if (data.length !== 4) return null;

      return {
        stateType: StateType.Int32,
        type: MSG_STATE_VALUE,
        value: data.readInt32LE(0),
      };
    }
    case StateType.Float32: {
      if (data.length !== 4) return null;

      return {
        stateType: StateType.Float32,
        type: MSG_STATE_VALUE,
        value: data.readFloatLE(0),
      };
    }
    case StateType.String: {
      if (data.length < 1 || data[data.length - 1] !== 0) return null;

      return {
        stateType: StateType.String,
        type: MSG_STATE_VALUE,
        value: data.subarray(0, data.length - 1).toString('utf-8'),
      };
    }
    default:
      assertNever(stateType);

      return null;
  }
}

// --- Streaming parser ---

/**
 * Accumulates TCP chunks and extracts complete protocol messages.
 * Handles partial reads, concatenated messages, and unknown types.
 */
export class ProtocolParser {
  private buffer = Buffer.alloc(0);

  /** Feed raw TCP data into the parser. */
  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  /** Extract all complete messages from the internal buffer. */
  parse(): Message[] {
    const messages: Message[] = [];

    while (this.buffer.length >= HEADER_SIZE) {
      const payloadLength = this.buffer.readUInt16BE(1);

      if (payloadLength > MAX_PAYLOAD_SIZE) {
        // AIDEV-NOTE: Protocol violation — payload exceeds uint16 max.
        // This shouldn't happen with valid framing, but we skip the header
        // and try to re-sync. In practice this means the stream is corrupt.
        throw new ProtocolError(
          `Payload length ${payloadLength} exceeds maximum ${MAX_PAYLOAD_SIZE}`,
        );
      }

      const totalLength = HEADER_SIZE + payloadLength;
      if (this.buffer.length < totalLength) {
        // Partial message — wait for more data
        break;
      }

      const type = this.buffer.readUInt8(0);
      const payload = this.buffer.subarray(HEADER_SIZE, totalLength);
      this.buffer = this.buffer.subarray(totalLength);

      const msg = decodePayload(type, payload);
      if (msg !== null) {
        messages.push(msg);
      }
      // Unknown types are silently skipped — the length prefix lets us
      // advance past them without corrupting the stream.
    }

    return messages;
  }

  /** Number of buffered bytes not yet consumed. */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  /** Reset internal buffer. */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}
